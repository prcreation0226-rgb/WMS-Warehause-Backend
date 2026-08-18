const { Warehouse, Company, Zone, Location } = require('../models');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'super_admin') {
    if (query.companyId) where.companyId = query.companyId;
  } else if (reqUser.role === 'company_admin') {
    where.companyId = reqUser.companyId;
  } else {
    if (reqUser.warehouseId) where.id = reqUser.warehouseId;
    else where.companyId = reqUser.companyId;
  }
  if (query.status) where.status = query.status;
  const warehouses = await Warehouse.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [{ association: 'Company', attributes: ['id', 'name', 'code'] }],
  });

  // Auto-backfill missing address or capacity for ShipStation warehouses in DB
  for (const wh of warehouses) {
    let changed = false;
    if ((!wh.address || wh.address === '—') && (wh.code === 'WH-SE-18434' || (wh.name || '').toLowerCase().includes('warehouse'))) {
      wh.address = '36 Gorsey Place, Skelmersdale, WN8 9UP';
      wh.city = 'Skelmersdale';
      wh.state = 'Lancashire';
      wh.postcode = 'WN8 9UP';
      wh.country = 'GB';
      wh.phone = wh.phone || '01695768001';
      changed = true;
    }
    if (wh.capacity == null || wh.capacity === 0) {
      wh.capacity = 10000;
      changed = true;
    }
    if (changed) {
      try { await wh.save(); } catch (_) {}
    }
  }

  return warehouses;
}

async function getById(id, reqUser) {
  const wh = await Warehouse.findByPk(id, {
    include: [
      { association: 'Company' },
      { association: 'Zones', include: [{ association: 'Locations' }] },
    ],
  });
  if (!wh) throw new Error('Warehouse not found');
  if (reqUser.role === 'company_admin' && wh.companyId !== reqUser.companyId) throw new Error('Warehouse not found');
  return wh;
}

async function create(data, reqUser) {
  if (reqUser.role === 'company_admin') data.companyId = reqUser.companyId;
  if (!data.companyId) throw new Error('companyId required');
  const existing = await Warehouse.findOne({ where: { companyId: data.companyId, code: data.code.trim() } });
  if (existing) throw new Error('Warehouse code already exists for this company');
  return Warehouse.create({
    companyId: data.companyId,
    name: data.name,
    code: data.code.trim(),
    warehouseType: data.warehouseType || null,
    address: data.address || null,
    phone: data.phone || null,
    capacity: data.capacity != null ? Number(data.capacity) : null,
    status: data.status || 'ACTIVE',
  });
}

async function update(id, data, reqUser) {
  const wh = await Warehouse.findByPk(id);
  if (!wh) throw new Error('Warehouse not found');
  if (reqUser.role === 'company_admin' && wh.companyId !== reqUser.companyId) throw new Error('Warehouse not found');
  await wh.update({
    name: data.name ?? wh.name,
    code: data.code?.trim() ?? wh.code,
    warehouseType: data.warehouseType !== undefined ? data.warehouseType : wh.warehouseType,
    address: data.address !== undefined ? data.address : wh.address,
    phone: data.phone !== undefined ? data.phone : wh.phone,
    capacity: data.capacity !== undefined ? (data.capacity != null ? Number(data.capacity) : null) : wh.capacity,
    status: data.status ?? wh.status,
  });
  return wh;
}

async function remove(id, reqUser) {
  const wh = await Warehouse.findByPk(id);
  if (!wh) throw new Error('Warehouse not found');
  if (reqUser.role === 'company_admin' && wh.companyId !== reqUser.companyId) throw new Error('Warehouse not found');
  
  try {
    await wh.destroy();
    return { message: 'Warehouse deleted' };
  } catch (err) {
    if (err.name === 'SequelizeForeignKeyConstraintError' || err.message.includes('foreign key constraint fails')) {
      const sqlMessage = err.parent?.sqlMessage || err.message || '';
      console.error('[warehouseService] Deletion blocked by foreign key constraint:', sqlMessage);
      
      if (sqlMessage.includes('pick_lists')) {
        throw new Error('This warehouse is in use. Cannot delete it because it contains active pick lists (picking tasks).');
      } else if (sqlMessage.includes('zones')) {
        throw new Error('This warehouse is in use. Cannot delete it because it contains zones.');
      } else {
        throw new Error('This warehouse is in use.');
      }
    }
    throw err;
  }
}

async function validateCapacity(warehouseId, incomingQty, options = {}) {
  const { ProductStock } = require('../models');
  const wh = await Warehouse.findByPk(warehouseId);
  if (!wh) throw new Error('Warehouse not found');

  // If no capacity is set, skip validation
  if (wh.capacity == null || wh.capacity <= 0) return true;

  // Calculate current total stock in this warehouse
  const currentStock = await ProductStock.sum('quantity', {
    where: { warehouseId },
    transaction: options.transaction
  }) || 0;

  if (currentStock + incomingQty > wh.capacity) {
    throw new Error(`Warehouse capacity exceeded. Current: ${currentStock}, Incoming: ${incomingQty}, Max: ${wh.capacity}. Warehouse: ${wh.name} (${wh.code})`);
  }
  return true;
}

async function getProducts(warehouseId, reqUser) {
  const { Product, sequelize } = require('../models');
  
  // Base query for company
  let companyId = reqUser.companyId;
  const whereClause = ['p.company_id = :companyId'];
  const replacements = { companyId, warehouseId };

  // JSON query for MySQL as requested
  // SELECT * FROM products WHERE JSON_EXTRACT(marketplace_skus, '$.warehouseId') = ?
  whereClause.push("JSON_EXTRACT(p.marketplace_skus, '$.warehouseId') = :warehouseId");

  const query = `
    SELECT p.* 
    FROM products p
    WHERE ${whereClause.join(' AND ')}
  `;

  const products = await sequelize.query(query, {
    replacements,
    type: sequelize.QueryTypes.SELECT,
    model: Product,
    mapToModel: true
  });

  // Map to include quantity, available and status as requested
  return products.map(p => {
    const qty = 0; // Default as per Task 2
    const available = qty;
    const reorderLevel = p.reorderLevel || 10;
    
    let status = 'In Stock';
    if (qty <= 0) status = 'Out of Stock';
    else if (qty < reorderLevel) status = 'Low Stock';

    return {
      ...p.toJSON(),
      quantity: qty,
      availableQuantity: available,
      status
    };
  });
}

module.exports = { list, getById, create, update, remove, validateCapacity, getProducts };
