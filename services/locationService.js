const { Location, Zone, Warehouse, ProductStock } = require('../models');
const { Op } = require('sequelize');

function normalizeRole(role) {
  return (role || '').toString().toLowerCase().replace(/-/g, '_').trim();
}

/**
 * Formats location name according to Aisle + Rack + Shelf + Bin without dashes
 */
function formatLocationName(data) {
  const parts = [data.aisle, data.rack, data.shelf, data.bin];
  const formatted = parts
    .filter(p => p != null && p !== '')
    .map(p => p.toString().trim())
    .join('');
  
  if (formatted) return formatted;
  return null;
}

async function list(reqUser, query = {}) {
  const where = {};
  if (query.zoneId) where.zoneId = query.zoneId;
  if (query.warehouseId) {
    const zoneIds = await Zone.findAll({ where: { warehouseId: query.warehouseId }, attributes: ['id'] });
    where.zoneId = { [Op.in]: zoneIds.map(z => z.id) };
  }
  const role = normalizeRole(reqUser.role);
  // super_admin: no company/warehouse filter -> show all locations
  if (role !== 'super_admin') {
    if (role === 'company_admin' && reqUser.companyId) {
      const whIds = await Warehouse.findAll({ where: { companyId: reqUser.companyId }, attributes: ['id'] });
      const whIdList = whIds.map(w => w.id);
      if (whIdList.length > 0) {
        const zoneRows = await Zone.findAll({ where: { warehouseId: { [Op.in]: whIdList } }, attributes: ['id'] });
        const zoneIdList = zoneRows.map(z => z.id);
        where.zoneId = zoneIdList.length > 0 ? { [Op.in]: zoneIdList } : { [Op.in]: [] };
      } else {
        where.zoneId = { [Op.in]: [] };
      }
    } else if (reqUser.warehouseId) {
      const zoneIds = await Zone.findAll({ where: { warehouseId: reqUser.warehouseId }, attributes: ['id'] });
      where.zoneId = { [Op.in]: zoneIds.map(z => z.id) };
    }
  }
  const locations = await Location.findAll({
    where,
    order: [['updatedAt', 'DESC'], ['createdAt', 'DESC']],
    include: [{ association: 'Zone', include: [{ association: 'Warehouse', attributes: ['id', 'name', 'code'] }] }],
  });

  const activeStockLocations = await ProductStock.findAll({
    attributes: ['locationId'],
    where: {
      quantity: { [Op.gt]: 0 }
    },
    group: ['locationId'],
    raw: true
  });
  const inUseLocationIds = new Set(activeStockLocations.map(s => s.locationId));

  return locations.map(loc => {
    const plain = loc.get ? loc.get({ plain: true }) : loc;
    plain.status = inUseLocationIds.has(plain.id) ? 'In Use' : 'Empty';
    return plain;
  });
}

async function getById(id, reqUser) {
  const loc = await Location.findByPk(id, {
    include: [{ association: 'Zone', include: ['Warehouse'] }],
  });
  if (!loc) throw new Error('Location not found');

  const hasStock = await ProductStock.findOne({
    where: {
      locationId: id,
      quantity: { [Op.gt]: 0 }
    }
  });

  const plain = loc.get ? loc.get({ plain: true }) : loc;
  plain.status = hasStock ? 'In Use' : 'Empty';
  return plain;
}

async function create(data, reqUser) {
  if (!data.zoneId) throw new Error('zoneId required');
  
  const formattedName = formatLocationName(data);
  
  return Location.create({
    zoneId: data.zoneId,
    name: data.name || formattedName,
    code: data.code || null,
    aisle: data.aisle || null,
    rack: data.rack || null,
    shelf: data.shelf || null,
    bin: data.bin || null,
    locationType: data.locationType || null,
    pickSequence: data.pickSequence != null ? Number(data.pickSequence) : null,
    maxWeight: data.maxWeight != null ? Number(data.maxWeight) : null,
    heatSensitive: data.heatSensitive || null,
  });
}

async function update(id, data, reqUser) {
  const loc = await Location.findByPk(id);
  if (!loc) throw new Error('Location not found');

  const formattedName = formatLocationName(data);

  await loc.update({
    name: data.name || formattedName || loc.name,
    code: data.code !== undefined ? data.code : loc.code,
    aisle: data.aisle !== undefined ? data.aisle : loc.aisle,
    rack: data.rack !== undefined ? data.rack : loc.rack,
    shelf: data.shelf !== undefined ? data.shelf : loc.shelf,
    bin: data.bin !== undefined ? data.bin : loc.bin,
    locationType: data.locationType !== undefined ? data.locationType : loc.locationType,
    pickSequence: data.pickSequence !== undefined ? (data.pickSequence != null ? Number(data.pickSequence) : null) : loc.pickSequence,
    maxWeight: data.maxWeight !== undefined ? (data.maxWeight != null ? Number(data.maxWeight) : null) : loc.maxWeight,
    heatSensitive: data.heatSensitive !== undefined ? data.heatSensitive : loc.heatSensitive,
  });
  return loc;
}

async function remove(id, reqUser) {
  const loc = await Location.findByPk(id);
  if (!loc) throw new Error('Location not found');

  const hasStock = await ProductStock.findOne({
    where: {
      locationId: id,
      quantity: { [Op.gt]: 0 }
    }
  });

  if (hasStock) {
    throw new Error('In Use location cannot be deleted.');
  }

  await loc.destroy();
  return { message: 'Location deleted' };
}

async function bulkCreate(locationsData, reqUser) {
  const results = [];
  const errors = [];
  const namesInBatch = new Set(); 

  let successCount = 0;
  let failureCount = 0;
  let createdCount = 0;
  let updatedCount = 0;

  const normalizeLocationType = (value) => {
    if (!value) return 'PICK';
    const t = String(value).trim().toUpperCase();
    return ['PICK', 'BULK', 'QUARANTINE', 'STAGING'].includes(t) ? t : 'PICK';
  };

  const normalizeKey = (value) => String(value || '').toLowerCase().trim();
  
  try {
    // Cache zones for the company to resolve names to IDs
    let zoneWhere = {};
    if (reqUser.role !== 'super_admin') {
        const whWhere = {};
        if (reqUser.companyId) whWhere.companyId = reqUser.companyId;
        else if (reqUser.warehouseId) whWhere.id = reqUser.warehouseId;
        
        const warehouses = await Warehouse.findAll({ where: whWhere, attributes: ['id'] });
        const whIds = warehouses.map(w => w.id);
        zoneWhere = { warehouseId: { [Op.in]: whIds } };
    }
    
    const existingZones = await Zone.findAll({ 
      where: zoneWhere,
      attributes: ['id', 'name', 'code', 'warehouseId']
    });
    const accessibleWarehouses = await Warehouse.findAll({
      where: zoneWhere.warehouseId ? { id: zoneWhere.warehouseId } : (reqUser.companyId ? { companyId: reqUser.companyId } : (reqUser.warehouseId ? { id: reqUser.warehouseId } : {})),
      attributes: ['id', 'name', 'code', 'companyId']
    });
    const warehouseByNameOrCode = new Map();
    accessibleWarehouses.forEach((w) => {
      warehouseByNameOrCode.set(normalizeKey(w.name), w);
      warehouseByNameOrCode.set(normalizeKey(w.code), w);
    });
    const zoneMap = new Map();
    const validZoneIds = new Set();
    existingZones.forEach(z => {
      zoneMap.set(z.name.toLowerCase().trim(), z.id);
      if (z.code) zoneMap.set(z.code.toLowerCase().trim(), z.id);
      validZoneIds.add(z.id);
    });

    /** In-memory list (plain rows) so batch imports can reuse zones created in this run */
    const zoneRows = existingZones.map((z) => (z.get ? z.get({ plain: true }) : z));

    const findZoneRowByWhAndCode = (warehouseId, codeUpper) =>
      zoneRows.find(
        (z) =>
          Number(z.warehouseId) === Number(warehouseId) &&
          z.code &&
          String(z.code).toUpperCase() === String(codeUpper).toUpperCase()
      );

    const upsertImportZone = async (warehouseId, { refNum, isDefault }) => {
      const code = isDefault ? 'CSVIMPORT' : `IMPREF${refNum}`;
      const name = isDefault ? 'CSV Import' : `Imported (ref ${refNum})`;
      const existing = findZoneRowByWhAndCode(warehouseId, code);
      if (existing) return existing.id;

      const targetWarehouse = accessibleWarehouses.find((w) => Number(w.id) === Number(warehouseId));
      const created = await Zone.create({
        warehouseId,
        companyId: targetWarehouse?.companyId || reqUser.companyId || null,
        name,
        code,
        zoneType: 'STORAGE',
      });
      const plain = {
        id: created.id,
        warehouseId: created.warehouseId,
        name: created.name,
        code: created.code,
      };
      zoneRows.push(plain);
      zoneMap.set(String(plain.name).toLowerCase().trim(), plain.id);
      if (plain.code) zoneMap.set(String(plain.code).toLowerCase().trim(), plain.id);
      validZoneIds.add(plain.id);
      return plain.id;
    };

    /** When the CSV has no warehouse column, use the lowest-id accessible warehouse (SMB default). */
    const resolveTargetWarehouseId = (resolvedWarehouseId) => {
      if (resolvedWarehouseId) return resolvedWarehouseId;
      if (!accessibleWarehouses.length) return null;
      const sorted = [...accessibleWarehouses].sort((a, b) => Number(a.id) - Number(b.id));
      return sorted[0].id;
    };

    for (const [index, item] of locationsData.entries()) {
      try {
        const lc = {};
        for (const [k, v] of Object.entries(item)) {
          const kl = String(k || '')
            .replace(/^\uFEFF/, '')
            .trim()
            .toLowerCase();
          if (!kl) continue;
          if (v === undefined || v === null || String(v).trim() === '') continue;
          const trimmed = String(v).trim();
          if (lc[kl] === undefined || lc[kl] === null || String(lc[kl]).trim() === '') {
            lc[kl] = trimmed;
          }
        }
        const get = (aliases) => {
          for (const a of aliases) {
            const key = String(a || '')
              .replace(/^\uFEFF/, '')
              .trim()
              .toLowerCase();
            const val = lc[key];
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              return String(val).trim();
            }
          }
          return null;
        };

        const zoneIdInput = get(['zoneid', 'zone_id', 'zone id']);
        const zoneNameInputExplicit = get(['zonename', 'zone_name', 'zone name', 'zone']);
        const rawNameCol = get(['name']);
        const locationNameExplicit = get(['locationname', 'location_name', 'location name']);
        let zoneNameInput = zoneNameInputExplicit;
        // Legacy Excel: zone label only in "name" (e.g. Zone A) while location comes from aisle/rack/…
        if (!zoneNameInput && rawNameCol && /^zone\b/i.test(String(rawNameCol).trim())) {
          zoneNameInput = rawNameCol;
        }
        const nameUsedOnlyAsZoneLabel =
          Boolean(
            rawNameCol &&
              zoneNameInput &&
              String(rawNameCol).trim() === String(zoneNameInput).trim() &&
              /^zone\b/i.test(String(rawNameCol).trim())
          );
        let locationNameForRow = locationNameExplicit;
        if (!locationNameForRow && rawNameCol && !nameUsedOnlyAsZoneLabel) {
          locationNameForRow = rawNameCol;
        }

        const warehouseInput = get([
          'warehouseid',
          'warehouse_id',
          'warehouse id',
          'warehousename',
          'warehouse name',
          'warehousecode',
          'warehouse code',
          'warehouse',
        ]);
        
        let zoneId = null;
        let resolvedWarehouseId = null;
        let numericZoneIdNotInDb = null;
        /** DB row exists but not in this user's warehouses / company — ignore id and use zoneName instead */
        let zoneIdInaccessible = null;

        // Resolve Warehouse first (for fallback zone creation)
        if (warehouseInput != null && warehouseInput !== '') {
          if (!isNaN(warehouseInput)) {
            const numericWarehouseId = Number(warehouseInput);
            if (accessibleWarehouses.some((w) => Number(w.id) === numericWarehouseId)) {
              resolvedWarehouseId = numericWarehouseId;
            }
          } else {
            const wh = warehouseByNameOrCode.get(normalizeKey(warehouseInput));
            if (wh) resolvedWarehouseId = wh.id;
          }
        }

        // --- RESILIENT ZONE RESOLUTION LOGIC ---
        
        // 1. Try resolving by zoneId first
        if (zoneIdInput != null && zoneIdInput !== '' && !isNaN(zoneIdInput)) {
          const numericId = Number(zoneIdInput);
          if (validZoneIds.has(numericId)) {
            zoneId = numericId;
          } else {
            const zoneRow = await Zone.findByPk(numericId);
            if (zoneRow) {
              zoneIdInaccessible = numericId;
            } else {
              numericZoneIdNotInDb = numericId;
            }
          }
        }

        // 2. Fallback to zoneName (if zoneId failed or was missing)
        if (!zoneId && zoneNameInput != null && zoneNameInput !== '') {
          const lowerName = zoneNameInput.toLowerCase().trim();
          if (zoneMap.has(lowerName)) {
            zoneId = zoneMap.get(lowerName);
          } else {
            // Auto-create new zone (Resilient/Self-healing)
            if (!resolvedWarehouseId) {
              resolvedWarehouseId = resolveTargetWarehouseId(null);
              if (!resolvedWarehouseId) {
                throw new Error(`Zone "${zoneNameInput}" not found and no warehouse is available for your account.`);
              }
            }

            const generatedCode = String(zoneNameInput).toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 20) || `ZONE_${Date.now()}`;
            const targetWarehouse = accessibleWarehouses.find((w) => Number(w.id) === Number(resolvedWarehouseId));
            
            const createdZone = await Zone.create({
              warehouseId: resolvedWarehouseId,
              companyId: targetWarehouse?.companyId || reqUser.companyId || null,
              name: String(zoneNameInput).trim(),
              code: generatedCode,
              zoneType: 'STORAGE'
            });
            
            zoneId = createdZone.id;
            // Cache for same batch
            zoneMap.set(lowerName, zoneId);
            zoneMap.set(generatedCode.toLowerCase(), zoneId);
            validZoneIds.add(zoneId);
          }
        }

        // 2b. CSV zoneId points to a row that never existed in DB (e.g. old export / wrong env) —
        // create a dedicated holding zone per ref ID in the target warehouse when we know which warehouse.
        if (!zoneId && numericZoneIdNotInDb != null) {
          const whId = resolveTargetWarehouseId(resolvedWarehouseId);
          if (whId) {
            zoneId = await upsertImportZone(whId, { refNum: numericZoneIdNotInDb });
          }
        }

        // 2c. No zoneId / zoneName at all — park rows in a shared "CSV Import" zone if warehouse is known.
        const noZoneIdCol = zoneIdInput == null || String(zoneIdInput).trim() === '';
        const noZoneNameCol = zoneNameInput == null || String(zoneNameInput).trim() === '';
        if (!zoneId && noZoneIdCol && noZoneNameCol) {
          const whId = resolveTargetWarehouseId(resolvedWarehouseId);
          if (whId) {
            zoneId = await upsertImportZone(whId, { isDefault: true });
          }
        }

        // 3. Final validation
        if (!zoneId) {
          if (zoneIdInaccessible != null) {
            throw new Error(
              `Zone ID ${zoneIdInaccessible} is not allowed for your login (wrong company/warehouse). Clear zoneId and use zoneName (exactly as in Export / Zones screen), or copy zoneId from "Zone ID Reference" in the import dialog.`
            );
          }
          if (numericZoneIdNotInDb != null) {
            throw new Error(
              `Zone ID ${numericZoneIdNotInDb} is not in the database. Add warehouseId or warehouseName on this row (or use a single-warehouse account) so a zone can be created, or add a zoneName column.`
            );
          }
          throw new Error(
            `Each row needs a zone: use zoneName (recommended), or a zoneId from your Zone ID Reference, or leave both empty only if warehouse columns allow a default import zone. Add warehouseName if you have more than one warehouse.`
          );
        }

        const normalized = {
          zoneId,
          name: locationNameForRow,
          code: get(['code']),
          aisle: get(['aisle']),
          rack: get(['rack']),
          shelf: get(['shelf']),
          bin: get(['bin']),
          locationType: normalizeLocationType(get(['locationtype', 'location_type', 'location type', 'type'])),
          pickSequence: get(['picksequence', 'pick_sequence', 'pick sequence']),
          maxWeight: get(['maxweight', 'max_weight', 'max weight']),
          heatSensitive: get(['heatsensitive', 'heat_sensitive', 'heat sensitive']),
        };
        
        const locName = normalized.name || formatLocationName(normalized);
        if (!locName) throw new Error(`Location name could not be generated from Aisle/Rack/Shelf/Bin.`);

        const batchKey = `${zoneId}-${locName.toLowerCase().trim()}`;
        if (namesInBatch.has(batchKey)) {
          throw new Error(`Duplicate entry for "${locName}" found in this CSV for same Zone.`);
        }
        namesInBatch.add(batchKey);

        const existingInDb = await Location.findOne({ where: { name: locName, zoneId } });
        
        if (existingInDb) {
          await existingInDb.update({
            code: normalized.code || existingInDb.code,
            aisle: normalized.aisle || existingInDb.aisle,
            rack: normalized.rack || existingInDb.rack,
            shelf: normalized.shelf || existingInDb.shelf,
            bin: normalized.bin || existingInDb.bin,
            locationType: normalized.locationType,
            pickSequence: normalized.pickSequence != null ? Number(normalized.pickSequence) : existingInDb.pickSequence,
            maxWeight: normalized.maxWeight != null ? Number(normalized.maxWeight) : existingInDb.maxWeight,
            heatSensitive: normalized.heatSensitive || existingInDb.heatSensitive,
          });
          results.push(existingInDb);
          updatedCount++;
        } else {
          const loc = await Location.create({
            zoneId,
            name: locName,
            code: normalized.code || null,
            aisle: normalized.aisle || null,
            rack: normalized.rack || null,
            shelf: normalized.shelf || null,
            bin: normalized.bin || null,
            locationType: normalized.locationType,
            pickSequence: normalized.pickSequence != null ? Number(normalized.pickSequence) : null,
            maxWeight: normalized.maxWeight != null ? Number(normalized.maxWeight) : null,
            heatSensitive: normalized.heatSensitive || null,
          });
          results.push(loc);
          createdCount++;
        }
        successCount++;
      } catch (err) {
        failureCount++;
        errors.push({
          row: index + 2,
          message: err.message
        });
      }
    }

    return {
      success: true,
      message: `Processed ${locationsData.length} rows. ${successCount} successful (${createdCount} created, ${updatedCount} updated), ${failureCount} failed.`,
      successCount: Number(successCount || 0),
      createdCount: Number(createdCount || 0),
      updatedCount: Number(updatedCount || 0),
      failureCount: Number(failureCount || 0),
      errors: errors || [],
      importEngine: 'bulk-locations-v3',
    };
  } catch (err) {
    console.error('Bulk Import Service Error:', err);
    throw err;
  }
}


async function migrateExistingLocations() {
    const locations = await Location.findAll();
    for (const loc of locations) {
        const newName = formatLocationName({
            aisle: loc.aisle,
            rack: loc.rack,
            shelf: loc.shelf,
            bin: loc.bin,
            name: loc.name
        });
        if (newName && newName !== loc.name) {
            await loc.update({ name: newName });
        }
    }
}

async function bulkAction(action, locationIds, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin') {
    throw new Error('Not allowed to perform bulk actions on locations');
  }

  if (action === 'DELETE') {
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const id of locationIds) {
      try {
        const loc = await Location.findByPk(id);
        if (loc) {
          const hasStock = await ProductStock.findOne({
            where: {
              locationId: id,
              quantity: { [Op.gt]: 0 }
            }
          });
          if (hasStock) {
            failedCount++;
            continue;
          }
          await loc.destroy();
          deletedCount++;
        }
      } catch (err) {
        failedCount++;
      }
    }
    
    let msg = `Successfully deleted ${deletedCount} locations.`;
    if (failedCount > 0) msg += ` Failed to delete ${failedCount} locations (In Use locations cannot be deleted).`;
    return { message: msg };
  } else {
    throw new Error('Invalid bulk action');
  }
}

async function getLocationStockDetails(locationId, reqUser) {
  const locId = parseInt(locationId, 10);
  const loc = await Location.findByPk(locId);
  if (!loc) throw new Error('Location not found');

  const locMatchCond = [
    { locationId: locId },
    { locationId: String(locId) }
  ];
  if (loc.name) locMatchCond.push({ locationId: loc.name });
  if (loc.code) locMatchCond.push({ locationId: loc.code });

  const whereLoc = { [Op.or]: locMatchCond };
  const list = [];
  const seenKeys = new Set();

  // 1. Fetch physical stock rows from ProductStock
  try {
    const stocks = await ProductStock.findAll({
      where: whereLoc,
      include: [
        {
          association: 'Product',
          attributes: ['id', 'name', 'sku'],
          required: false,
          include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
        },
        {
          association: 'Client',
          attributes: ['id', 'name', 'code'],
          required: false
        },
        {
          association: 'User',
          attributes: ['id', 'name', 'email'],
          required: false
        }
      ],
      order: [['updatedAt', 'DESC']]
    });

    stocks.forEach(st => {
      const s = st.get ? st.get({ plain: true }) : st;
      const clientCode = s.Client?.code || s.Client?.name || s.Product?.Client?.code || s.Product?.Client?.name || 'FFD';
      const productSku = s.Product?.sku || 'N/A';
      const productName = s.Product?.name || '';
      const productDisplay = productName ? `${productSku} - ${productName}` : productSku;
      const type = (s.reserved > 0) ? 'Allocation' : 'Storage';
      const bestBefore = s.bestBeforeDate ? `${s.bestBeforeDate} 00:00:00` : 'N/A';
      const batchNo = s.batchNumber || s.lotNumber || 'N/A';
      const serialNo = s.serialNumber || 'N/A';
      const allocatedAgainstOrder = (s.reserved > 0) ? 'true' : 'false';
      const lastUpdatedByUser = s.User?.name || s.User?.email || s.reason || 'SYSTEM';

      const dedupKey = `${productSku}_${batchNo}_${bestBefore}_${s.quantity}`;
      seenKeys.add(dedupKey);

      list.push({
        id: `stock_${s.id}`,
        client: clientCode,
        product: productDisplay,
        type,
        bestBefore,
        batchNo,
        serialNo,
        quantity: Math.round(Number(s.quantity) || 0),
        allocatedAgainstOrder,
        lastUpdated: s.updatedAt,
        lastUpdatedByUser
      });
    });
  } catch (err) {
    console.error('[getLocationStockDetails] ProductStock query error:', err.message);
  }

  // 2. Fetch allocated OrderItems assigned to this location
  try {
    const orderItems = await OrderItem.findAll({
      where: whereLoc,
      include: [
        {
          association: 'Product',
          attributes: ['id', 'name', 'sku'],
          required: false,
          include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
        },
        {
          association: 'SalesOrder',
          required: false,
          include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
        }
      ],
      order: [['updatedAt', 'DESC']]
    });

    orderItems.forEach(item => {
      const i = item.get ? item.get({ plain: true }) : item;
      const clientCode = i.SalesOrder?.Client?.code || i.Product?.Client?.code || 'FFD';
      const productSku = i.Product?.sku || 'N/A';
      const productName = i.Product?.name || '';
      const productDisplay = productName ? `${productSku} - ${productName}` : productSku;
      const bestBefore = i.bestBeforeDate ? `${i.bestBeforeDate} 00:00:00` : 'N/A';
      const batchNo = i.batchNumber || 'N/A';
      const quantity = Math.round(parseFloat(i.quantity) || 0);

      list.push({
        id: `order_item_${i.id}`,
        client: clientCode,
        product: productDisplay,
        type: 'Allocation',
        bestBefore,
        batchNo,
        serialNo: 'N/A',
        quantity,
        allocatedAgainstOrder: 'true',
        lastUpdated: i.updatedAt,
        lastUpdatedByUser: 'SYSTEM-SHOPIFY'
      });
    });
  } catch (err) {
    console.error('[getLocationStockDetails] OrderItem query error:', err.message);
  }

  // 3. Fetch allocated PickListItems assigned to this location
  try {
    const { PickListItem } = require('../models');
    if (PickListItem) {
      const pickItems = await PickListItem.findAll({
        where: whereLoc,
        include: [
          {
            association: 'Product',
            attributes: ['id', 'name', 'sku'],
            required: false,
            include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
          }
        ],
        order: [['updatedAt', 'DESC']]
      });

      pickItems.forEach(item => {
        const p = item.get ? item.get({ plain: true }) : item;
        const clientCode = p.Product?.Client?.code || 'FFD';
        const productSku = p.Product?.sku || 'N/A';
        const productName = p.Product?.name || '';
        const productDisplay = productName ? `${productSku} - ${productName}` : productSku;
        const bestBefore = p.bestBeforeDate ? `${p.bestBeforeDate} 00:00:00` : 'N/A';
        const batchNo = p.batchNumber || 'N/A';
        const quantity = parseFloat(p.pickedQty || p.requestedQty || p.quantity || 0);

        const dedupKey = `pick_${p.id}`;
        if (!seenKeys.has(dedupKey) && quantity > 0) {
          list.push({
            id: dedupKey,
            client: clientCode,
            product: productDisplay,
            type: 'Allocation',
            bestBefore,
            batchNo,
            serialNo: 'N/A',
            quantity,
            allocatedAgainstOrder: 'true',
            lastUpdated: p.updatedAt,
            lastUpdatedByUser: 'SYSTEM-SHOPIFY'
          });
        }
      });
    }
  } catch (err) {
    console.error('[getLocationStockDetails] PickListItem query error:', err.message);
  }

  // 4. GoodsReceiptItem
  try {
    const { GoodsReceiptItem } = require('../models');
    if (GoodsReceiptItem) {
      const grItems = await GoodsReceiptItem.findAll({
        where: whereLoc,
        include: [
          {
            association: 'Product',
            attributes: ['id', 'name', 'sku'],
            required: false,
            include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
          }
        ],
        order: [['updatedAt', 'DESC']]
      });

      grItems.forEach(item => {
        const g = item.get ? item.get({ plain: true }) : item;
        const productSku = g.Product?.sku || 'N/A';
        const productName = g.Product?.name || '';
        const productDisplay = productName ? `${productSku} - ${productName}` : productSku;
        const qty = parseFloat(g.receivedQty || g.qtyToBook || g.expectedQty || 0);

        const dedupKey = `gr_${g.id}`;
        if (!seenKeys.has(dedupKey) && qty > 0) {
          list.push({
            id: dedupKey,
            client: g.Product?.Client?.code || 'FFD',
            product: productDisplay,
            type: 'Storage',
            bestBefore: g.bestBeforeDate ? `${g.bestBeforeDate} 00:00:00` : 'N/A',
            batchNo: g.batchNumber || 'N/A',
            serialNo: 'N/A',
            quantity: qty,
            allocatedAgainstOrder: 'false',
            lastUpdated: g.updatedAt,
            lastUpdatedByUser: 'SYSTEM-RECEIVING'
          });
        }
      });
    }
  } catch (err) {
    console.error('[getLocationStockDetails] GoodsReceiptItem query error:', err.message);
  }

  // 5. InventoryAdjustment
  try {
    const { InventoryAdjustment } = require('../models');
    if (InventoryAdjustment) {
      const adjustments = await InventoryAdjustment.findAll({
        where: whereLoc,
        include: [
          {
            association: 'Product',
            attributes: ['id', 'name', 'sku'],
            required: false,
            include: [{ association: 'Client', attributes: ['id', 'name', 'code'], required: false }]
          }
        ],
        order: [['updatedAt', 'DESC']]
      });

      adjustments.forEach(adj => {
        const a = adj.get ? adj.get({ plain: true }) : adj;
        const productSku = a.Product?.sku || 'N/A';
        const productName = a.Product?.name || '';
        const productDisplay = productName ? `${productSku} - ${productName}` : productSku;
        const qty = parseFloat(a.quantity || a.newQuantity || 0);

        const dedupKey = `adj_${a.id}`;
        if (!seenKeys.has(dedupKey) && qty > 0) {
          list.push({
            id: dedupKey,
            client: a.Product?.Client?.code || 'FFD',
            product: productDisplay,
            type: 'Storage',
            bestBefore: a.bestBeforeDate ? `${a.bestBeforeDate} 00:00:00` : 'N/A',
            batchNo: a.batchNumber || 'N/A',
            serialNo: 'N/A',
            quantity: qty,
            allocatedAgainstOrder: 'false',
            lastUpdated: a.updatedAt,
            lastUpdatedByUser: a.createdByUser?.name || a.createdByUser?.email || 'SYSTEM'
          });
        }
      });
    }
  } catch (err) {
    console.error('[getLocationStockDetails] InventoryAdjustment query error:', err.message);
  }

  return list;
}

module.exports = { list, getById, create, update, remove, bulkCreate, bulkAction, migrateExistingLocations, getLocationStockDetails };
