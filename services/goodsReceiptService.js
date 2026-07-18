const { Op } = require('sequelize');
const { GoodsReceipt, GoodsReceiptItem, PurchaseOrder, PurchaseOrderItem, Supplier, Product, ProductStock, Warehouse, Location, Batch, Inventory, InventoryLog } = require('../models');
const auditLogService = require('./auditLogService');

function isTruthyYes(v) {
  if (v === true) return true;
  if (!v) return false;
  const s = String(v).toUpperCase().trim();
  return s === 'YES' || s === 'TRUE' || s === '1' || s === 'Y';
}

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'super_admin') {
    if (query.companyId) where.companyId = query.companyId;
  } else {
    where.companyId = reqUser.companyId;
  }
  if (query.status) where.status = query.status;
  if (reqUser.clientId) {
    where.clientId = reqUser.clientId;
  } else if (query.clientId) {
    where.clientId = query.clientId;
  }

  const receipts = await GoodsReceipt.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'PurchaseOrder', include: [{ association: 'Supplier', attributes: ['id', 'name'] }] },
      { association: 'Warehouse', attributes: ['id', 'name', 'code'] },
      { association: 'GoodsReceiptItems', include: [{ association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] }] },
    ],
  });
  applyGrnDisplayNormalization(receipts);
  return receipts;
}

function applyGrnDisplayNormalization(receipts) {
  const byCompany = {};
  receipts.forEach((r) => {
    const cid = r.companyId;
    if (!byCompany[cid]) byCompany[cid] = [];
    byCompany[cid].push(r);
  });
  Object.values(byCompany).forEach((arr) => {
    const newFormatNums = arr.map((r) => (r.grNumber || '').match(/^GRN(\d+)$/i)).filter(Boolean).map((m) => parseInt(m[1], 10));
    const nextNum = newFormatNums.length > 0 ? Math.max(...newFormatNums) + 1 : 1;
    const oldFormat = arr.filter((r) => /^GRN-\d+-\d+$/i.test((r.grNumber || '').trim()));
    const oldSorted = [...oldFormat].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let n = nextNum;
    oldSorted.forEach((r) => {
      r.setDataValue('grNumber', `GRN${String(n).padStart(3, '0')}`);
      n += 1;
    });
  });
}

async function getById(id, reqUser) {
  const gr = await GoodsReceipt.findByPk(id, {
    include: [
      { association: 'PurchaseOrder', include: ['Supplier'] },
      { association: 'Warehouse', attributes: ['id', 'name', 'code'] },
      { association: 'GoodsReceiptItems', include: ['Product'] },
    ],
  });
  if (!gr) throw new Error('Goods receipt not found');
  if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Goods receipt not found');
  if (reqUser.clientId && gr.clientId !== reqUser.clientId) throw new Error('Not authorized to access this client data');
  if (/^GRN-\d+-\d+$/i.test((gr.grNumber || '').trim())) {
    const all = await GoodsReceipt.findAll({ where: { companyId: gr.companyId }, order: [['createdAt', 'ASC']] });
    applyGrnDisplayNormalization(all);
    const found = all.find((r) => r.id === gr.id);
    if (found) gr.setDataValue('grNumber', found.grNumber);
  }
  return gr;
}

async function create(body, reqUser) {
  const companyId = reqUser.role === 'super_admin' ? (body.companyId || reqUser.companyId) : reqUser.companyId;
  if (!companyId) throw new Error('Company context required');

  const po = await PurchaseOrder.findByPk(body.purchaseOrderId, {
    include: [{ association: 'PurchaseOrderItems', include: [{ association: 'Product', attributes: ['id', 'name', 'sku'] }] }],
  });
  if (!po || po.companyId !== companyId) throw new Error('Purchase order not found');
  if (!['approved', 'pending', 'draft', 'asn_sent'].includes((po.status || '').toLowerCase())) {
    throw new Error('Only approved or pending purchase orders can be received');
  }

  // GRN number format: GRN001, GRN002, GRN003, ... (sequential per company)
  const all = await GoodsReceipt.findAll({ where: { companyId }, attributes: ['grNumber'], raw: true });
  const existingNums = all.map((r) => (r.grNumber || '').match(/^GRN(\d+)$/i)).filter(Boolean).map((m) => parseInt(m[1], 10));
  const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
  const grNumber = `GRN${String(nextNum).padStart(3, '0')}`;

  const totalExpected = (po.PurchaseOrderItems || []).reduce((acc, i) => {
    return acc + (Number(i.quantity) || 0);
  }, 0);

  const gr = await GoodsReceipt.create({
    companyId: po.companyId,
    purchaseOrderId: po.id,
    clientId: po.clientId || null,
    warehouseId: po.warehouseId || body.warehouseId || null,
    grNumber,
    status: 'pending',
    notes: body.notes || null,
    totalExpected,
    totalReceived: 0,
  });

  // Update PO status to reflect it's now being processed (ASN stage)
  await po.update({ status: 'asn_sent' });

  const items = (po.PurchaseOrderItems || []).map((i) => ({
    goodsReceiptId: gr.id,
    productId: i.productId,
    productName: (i.productName && i.productName.trim()) ? i.productName.trim() : (i.Product?.name || null),
    productSku: (i.productSku && i.productSku.trim()) ? i.productSku.trim() : (i.Product?.sku || null),
    expectedQty: Number(i.quantity) || 0,
    receivedQty: 0,
    qualityStatus: null,
  }));
  if (items.length) await GoodsReceiptItem.bulkCreate(items);

  return getById(gr.id, reqUser);
}

async function updateReceived(id, body, reqUser) {
  const t = await GoodsReceipt.sequelize.transaction();
  try {
    const gr = await GoodsReceipt.findByPk(id, {
      include: ['GoodsReceiptItems'],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!gr) throw new Error('Goods receipt not found');
    if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Goods receipt not found');
    if (gr.status === 'completed') throw new Error('Receipt already completed');

    const po = await PurchaseOrder.findByPk(gr.purchaseOrderId, {
      include: ['PurchaseOrderItems'],
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    const items = body.items || [];
    for (const row of items) {
      const line = gr.GoodsReceiptItems?.find((i) => i.productId === row.productId || i.id === row.id);
      if (line) {
        const newReceivedQty = Number(row.receivedQty) || 0;

        // Over-receive validation
        const poItem = po.PurchaseOrderItems.find(p => p.productId === line.productId);
        if (poItem) {
          // Check other finalized GRNs
          const otherGrItems = await GoodsReceiptItem.findAll({
            include: [{ association: 'GoodsReceipt', where: { purchaseOrderId: po.id, status: 'completed', id: { [Op.ne]: id } } }],
            where: { productId: line.productId },
            transaction: t
          });
          const alreadyReceived = otherGrItems.reduce((sum, gi) => sum + (Number(gi.receivedQty) || 0), 0);
          /*
          if ((alreadyReceived + newReceivedQty) > Number(poItem.quantity)) {
            throw new Error(`Over-receiving detected for SKU ${line.productSku}. Ordered: ${poItem.quantity}, Already finalized: ${alreadyReceived}, Attempting to set this ASN to: ${newReceivedQty}.`);
          }
          */
        }

        await line.update({
          receivedQty: newReceivedQty,
          qualityStatus: row.qualityStatus || line.qualityStatus
        }, { transaction: t });
      }
    }

    const newTotal = (gr.GoodsReceiptItems || []).reduce((s, i) => s + (Number(i.receivedQty) || 0), 0);
    const allReceived = (gr.GoodsReceiptItems || []).every((i) => (Number(i.receivedQty) || 0) >= (Number(i.expectedQty) || 0));

    await gr.update({
      totalReceived: newTotal,
      status: allReceived ? 'completed' : 'in_progress',
    }, { transaction: t });

    await auditLogService.logAction(reqUser, {
      action: 'GRN_RECEIVED_PARTIAL',
      module: 'INBOUND',
      referenceId: gr.id,
      referenceNumber: gr.grNumber,
      details: { totalReceived: newTotal }
    });

    await t.commit();
    return getById(gr.id, reqUser);
  } catch (err) {
    if (t) await t.rollback();
    throw err;
  }
}

function normalizeString(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim();
}

function normalizeInt(val) {
  if (val === null || val === undefined || val === '') return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

function normalizeDate(val) {
  if (val === null || val === undefined || val === '') return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

async function updateAsnItems(id, body, reqUser) {
  const t = await GoodsReceipt.sequelize.transaction();
  try {
    const gr = await GoodsReceipt.findByPk(id, {
      include: ['GoodsReceiptItems'],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!gr) throw new Error('ASN not found');
    if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Not authorized');

    // Immutability checks:
    // 1. Omission check: If any existing item has qtyToBook > 0 but is omitted in body.items, block it
    if (Array.isArray(body.items)) {
      for (const dbItem of gr.GoodsReceiptItems) {
        if (Number(dbItem.qtyToBook) > 0) {
          const payloadItem = body.items.find(i => i.id === dbItem.id);
          if (!payloadItem) {
            throw new Error('Once entries are added to the ASN they cannot be deleted');
          }
        }
      }
    }

    if (body.deliveryType) gr.deliveryType = body.deliveryType;
    if (body.eta) gr.eta = body.eta;
    if (body.warehouseId && Number(body.warehouseId) !== gr.warehouseId) {
      gr.warehouseId = Number(body.warehouseId);
      // Keep existing pending records in sync with new warehouse
      await ProductStock.update(
        { warehouseId: gr.warehouseId },
        { where: { status: 'PENDING', reason: { [Op.like]: `ASN:${gr.id}:%` } }, transaction: t }
      );
      await InventoryLog.update(
        { warehouseId: gr.warehouseId },
        { where: { type: 'PENDING_IN', reason: { [Op.like]: `ASN Pending Receipt:${gr.id}:%` } }, transaction: t }
      );
    }
    await gr.save({ transaction: t });

    if (Array.isArray(body.items)) {
      const existingIds = gr.GoodsReceiptItems.map(i => i.id);
      const updatedIds = body.items.filter(i => i.id).map(i => i.id);
      const toDeleteIds = existingIds.filter(itemId => !updatedIds.includes(itemId));

      if (toDeleteIds.length > 0) {
        await GoodsReceiptItem.destroy({ where: { id: toDeleteIds }, transaction: t });
        for (const deletedId of toDeleteIds) {
          await ProductStock.destroy({
            where: { status: 'PENDING', reason: `ASN:${gr.id}:${deletedId}` },
            transaction: t
          });
          await InventoryLog.destroy({
            where: { type: 'PENDING_IN', reason: `ASN Pending Receipt:${gr.id}:${deletedId}` },
            transaction: t
          });
        }
      }

      for (const item of body.items) {
        let dbItem;
        if (item.id) {
          dbItem = gr.GoodsReceiptItems.find(i => i.id === item.id);
          if (dbItem) {
            // Immutability checks:
            // 2. Modification check: If qtyToBook > 0, compare fields and block if changed
            if (Number(dbItem.qtyToBook) > 0) {
              const qtyChanged = Number(item.qtyToBook) !== Number(dbItem.qtyToBook);
              const batchChanged = normalizeString(item.batchId) !== normalizeString(dbItem.batchId);
              const bbdChanged = normalizeDate(item.bestBeforeDate) !== normalizeDate(dbItem.bestBeforeDate);
              const locChanged = normalizeInt(item.locationId) !== normalizeInt(dbItem.locationId);
              const statusChanged = normalizeString(item.qualityStatus || 'GOOD') !== normalizeString(dbItem.qualityStatus || 'GOOD');

              if (qtyChanged || batchChanged || bbdChanged || locChanged || statusChanged) {
                throw new Error('Once entries are added to the ASN they cannot be modified');
              }
            }

            await dbItem.update({
              batchId: item.batchId || dbItem.batchId,
              bestBeforeDate: item.bestBeforeDate || dbItem.bestBeforeDate,
              qtyToBook: item.qtyToBook ?? dbItem.qtyToBook,
              locationId: item.locationId || dbItem.locationId,
              qualityStatus: item.qualityStatus || dbItem.qualityStatus
            }, { transaction: t });
          }
        } else {
          dbItem = await GoodsReceiptItem.create({
            goodsReceiptId: gr.id,
            productId: item.productId,
            productName: item.productName || null,
            productSku: item.productSku || null,
            expectedQty: 0,
            receivedQty: 0,
            qtyToBook: item.qtyToBook || 0,
            batchId: item.batchId || null,
            bestBeforeDate: item.bestBeforeDate || null,
            locationId: item.locationId || null,
            qualityStatus: item.qualityStatus || 'GOOD'
          }, { transaction: t });
        }

        if (dbItem) {
          const finalQtyToBook = Number(dbItem.qtyToBook) || 0;
          const stockReason = `ASN:${gr.id}:${dbItem.id}`;
          const logReason = `ASN Pending Receipt:${gr.id}:${dbItem.id}`;

          if (finalQtyToBook > 0) {
            let stock = await ProductStock.findOne({
              where: { status: 'PENDING', reason: stockReason },
              transaction: t,
              lock: t.LOCK.UPDATE
            });

            if (stock) {
              await stock.update({
                productId: dbItem.productId,
                warehouseId: gr.warehouseId,
                locationId: dbItem.locationId || null,
                batchNumber: dbItem.batchId || null,
                quantity: finalQtyToBook,
                bestBeforeDate: dbItem.bestBeforeDate || null,
                clientId: gr.clientId || null
              }, { transaction: t });
            } else {
              await ProductStock.create({
                companyId: gr.companyId,
                clientId: gr.clientId || null,
                productId: dbItem.productId,
                warehouseId: gr.warehouseId,
                locationId: dbItem.locationId || null,
                batchNumber: dbItem.batchId || null,
                quantity: finalQtyToBook,
                reserved: 0,
                bestBeforeDate: dbItem.bestBeforeDate || null,
                status: 'PENDING',
                reason: stockReason
              }, { transaction: t });
            }

            let log = await InventoryLog.findOne({
              where: { type: 'PENDING_IN', reason: logReason },
              transaction: t,
              lock: t.LOCK.UPDATE
            });

            if (log) {
              await log.update({
                productId: dbItem.productId,
                warehouseId: gr.warehouseId,
                locationId: dbItem.locationId || null,
                clientId: gr.clientId || null,
                quantity: finalQtyToBook,
                referenceId: gr.grNumber,
                batchNumber: dbItem.batchId || null,
                bestBeforeDate: dbItem.bestBeforeDate || null,
                userId: reqUser.id
              }, { transaction: t });
            } else {
              await InventoryLog.create({
                productId: dbItem.productId,
                warehouseId: gr.warehouseId,
                locationId: dbItem.locationId || null,
                clientId: gr.clientId || null,
                type: 'PENDING_IN',
                quantity: finalQtyToBook,
                referenceId: gr.grNumber,
                batchNumber: dbItem.batchId || null,
                bestBeforeDate: dbItem.bestBeforeDate || null,
                reason: logReason,
                userId: reqUser.id
              }, { transaction: t });
            }
          } else {
            await ProductStock.destroy({
              where: { status: 'PENDING', reason: stockReason },
              transaction: t
            });
            await InventoryLog.destroy({
              where: { type: 'PENDING_IN', reason: logReason },
              transaction: t
            });
          }
        }
      }
    }

    await t.commit();
    return getById(id, reqUser);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function finalizeReceiving(id, reqUser) {
  // 1. Start Transaction
  const t = await GoodsReceipt.sequelize.transaction();

  try {
    // 2. Fetch and Lock GRN
    const gr = await GoodsReceipt.findByPk(id, {
      include: [{ association: 'GoodsReceiptItems', include: ['Product'] }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!gr) throw new Error('ASN not found');
    if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Not authorized');
    if (gr.status === 'completed') throw new Error('Already finalized');
    if (!gr.warehouseId) throw new Error('Warehouse not specified. Please set a destination warehouse.');

    // Delete all draft/pending stock and logs for this ASN before finalizing
    await ProductStock.destroy({
      where: {
        status: 'PENDING',
        reason: { [Op.like]: `ASN:${gr.id}:%` }
      },
      transaction: t
    });

    await InventoryLog.destroy({
      where: {
        type: 'PENDING_IN',
        reason: { [Op.like]: `ASN Pending Receipt:${gr.id}:%` }
      },
      transaction: t
    });

    // 3. Fetch and Lock Purchase Order to prevent concurrent receiving edits
    const po = await PurchaseOrder.findByPk(gr.purchaseOrderId, {
      include: [{ association: 'PurchaseOrderItems' }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!po) throw new Error('Linked Purchase Order not found');

    // 4. Validate and Process each item
    for (const item of gr.GoodsReceiptItems) {
      const qtyToBook = Number(item.qtyToBook) || 0;
      if (qtyToBook <= 0) continue;

      const product = item.Product;
      if (!product) throw new Error(`Product data missing for ASN line item ID ${item.id}`);

      // 4.1 Batch/BBD Validation
      if (isTruthyYes(product.requireBatchTracking)) {
        if (!item.batchId) {
          throw new Error(`Batch Number is required for product "${product.name}" as per catalog settings.`);
        }
      }
      if (isTruthyYes(product.perishable)) {
        if (!item.bestBeforeDate) {
          throw new Error(`Best Before Date is required for perishable product "${product.name}".`);
        }
      }

      // Check for over-receiving against PO line
      const poItem = po.PurchaseOrderItems.find(p => p.productId === item.productId);
      // Unexpected items are allowed, so we do not throw an error if !poItem.

      // 4.2 Heat-Sensitive Check (Relaxed to allow booking if location is selected)
      if (isTruthyYes(product.heatSensitive)) {
        if (!item.locationId) throw new Error(`Location is required for heat-sensitive product "${product.name}"`);
        // Note: Strict hot-zone validation removed to allow operational flexibility.
      }

      // Calculate what has been received so far in other finalized GRNs
      const otherGrItems = await GoodsReceiptItem.findAll({
        include: [{
          association: 'GoodsReceipt',
          where: {
            purchaseOrderId: po.id,
            status: 'completed',
            id: { [Op.ne]: id }
          }
        }],
        where: { productId: item.productId },
        transaction: t
      });
      const alreadyReceived = otherGrItems.reduce((sum, gi) => sum + (Number(gi.receivedQty) || 0), 0);
      const remainingAllowed = poItem ? (Number(poItem.quantity) - alreadyReceived) : 0;

      // Allow over-receiving: Some users might receive more than ordered (bonus stock/samples)
      /*
      if (qtyToBook > remainingAllowed) {
        throw new Error(`Over-receiving detected for ${item.productSku}. Ordered: ${poItem.quantity}, Already Received: ${alreadyReceived}, Attempting: ${qtyToBook}. Maximum allowed now: ${remainingAllowed}`);
      }
      */

      // 6. Manage Batch (if applicable)
      if (item.batchId) {
        const poPackSize = poItem ? (Number(poItem.packSize) || Number(product.packSize) || 1) : (Number(product.packSize) || 1);
        const casePrice = poItem ? (Number(poItem.unitPrice) || 0) : 0;
        const unitCost = poPackSize > 0 ? (casePrice / poPackSize) : casePrice;

        console.log(`[GRN COST DEBUG] SKU: ${product.sku}, Case Price: ${casePrice}, Pack Size: ${poPackSize}, Unit Cost: ${unitCost}`);

        await Batch.create({
          companyId: gr.companyId,
          clientId: gr.clientId || null,
          productId: item.productId,
          warehouseId: gr.warehouseId,
          locationId: item.locationId || null,
          batchNumber: item.batchId,
          quantity: qtyToBook,
          unitCost: unitCost,
          expiryDate: item.bestBeforeDate || null,
          grnId: id,
          status: 'ACTIVE'
        }, { transaction: t });
      }

      // 7. Update Inventory
      let stock = await ProductStock.findOne({
        where: {
          productId: item.productId,
          warehouseId: gr.warehouseId,
          companyId: gr.companyId,

          // locationId: item.locationId || null,
          // batchNumber: item.batchId || null,
          // bestBeforeDate: item.bestBeforeDate || null,

          locationId: (item.locationId && String(item.locationId).trim()) ? item.locationId : null,
          batchNumber: (item.batchId && String(item.batchId).trim()) ? item.batchId : null,
          bestBeforeDate: (item.bestBeforeDate && String(item.bestBeforeDate).trim()) ? item.bestBeforeDate : null,
          clientId: gr.clientId || null
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (stock) {
        await stock.increment('quantity', { by: qtyToBook, transaction: t });
        await stock.update({
          bestBeforeDate: item.bestBeforeDate || stock.bestBeforeDate
        }, { transaction: t });
      } else {
        await ProductStock.create({
          companyId: gr.companyId,
          clientId: gr.clientId || null,
          productId: item.productId,
          warehouseId: gr.warehouseId,
          locationId: item.locationId || null,
          batchNumber: item.batchId || null,
          quantity: qtyToBook,
          reserved: 0,
          bestBeforeDate: item.bestBeforeDate || null,
          status: 'ACTIVE'
        }, { transaction: t });
      }

      // 7.1 Sync Warehouse Inventory (Total)
      const [inv] = await Inventory.findOrCreate({
        where: { productId: item.productId, warehouseId: gr.warehouseId },
        defaults: { quantity: 0, reservedQuantity: 0 },
        transaction: t
      });
      await inv.increment('quantity', { by: qtyToBook, transaction: t });

      // 7.2 Create Inventory Log
      await InventoryLog.create({
        productId: item.productId,
        warehouseId: gr.warehouseId,
        locationId: item.locationId || null,
        clientId: gr.clientId || null,
        type: 'IN',
        quantity: qtyToBook,
        referenceId: gr.grNumber,
        batchNumber: item.batchId || null,
        bestBeforeDate: item.bestBeforeDate || null,
        reason: `Purchase Order Receipt: ${po.poNumber}`,
        userId: reqUser.id
      }, { transaction: t });

      // 7.3 Re-sync Reservations for this product in this warehouse
      const orderService = require('./orderService');
      await orderService.syncReservationsForProduct(item.productId, gr.warehouseId, t);

      // Update item record
      await item.update({ receivedQty: qtyToBook }, { transaction: t });
    }

    // 8. Finalize GRN status
    const totalReceivedNow = (gr.GoodsReceiptItems || []).reduce((s, i) => s + (Number(i.qtyToBook) || 0), 0);
    await gr.update({
      status: 'completed',
      totalReceived: totalReceivedNow
    }, { transaction: t });

    // 9. Auto-Check PO completion
    const allGrItemsForPo = await GoodsReceiptItem.findAll({
      include: [{ association: 'GoodsReceipt', where: { purchaseOrderId: po.id, status: 'completed' } }],
      transaction: t
    });
    const poTotals = {};
    allGrItemsForPo.forEach(gi => {
      poTotals[gi.productId] = (poTotals[gi.productId] || 0) + (Number(gi.receivedQty) || 0);
    });
    const isPoFullyReceived = po.PurchaseOrderItems.every(poi => (poTotals[poi.productId] || 0) >= Number(poi.quantity));
    if (isPoFullyReceived) {
      await po.update({ status: 'received' }, { transaction: t });
    }

    // 10. Audit Log
    await auditLogService.logAction(reqUser, {
      action: 'GRN_FINALIZED',
      module: 'INBOUND',
      referenceId: gr.id,
      referenceNumber: gr.grNumber,
      details: { totalItems: gr.GoodsReceiptItems.length, totalReceived: totalReceivedNow }
    });

    await t.commit();
    return getById(id, reqUser);

  } catch (err) {
    if (t) await t.rollback();
    console.error('Finalize Failed:', err);
    throw err;
  }
}

async function exportCsvTemplate(id, reqUser) {
  const gr = await GoodsReceipt.findByPk(id, {
    include: [{ association: 'GoodsReceiptItems', include: ['Product'] }]
  });
  if (!gr) throw new Error('Goods receipt not found');
  if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Not authorized');

  let csv = 'Internal SKU,SKU,Product,Expected Qty (Each),Best Before Date (DD/MM/YYYY),Batch Number\n';
  (gr.GoodsReceiptItems || []).forEach(item => {
    const internalSku = item.Product?.sku || item.productSku || '';
    const productName = item.productName || item.Product?.name || '';
    csv += `"${internalSku}","${item.productSku}","${productName}",${Number(item.expectedQty).toString()},,\n`;
  });
  return { csv, filename: `Template_${gr.grNumber}.csv` };
}

async function importCsvBbd(id, rows, reqUser) {
  const gr = await GoodsReceipt.findByPk(id, { include: ['GoodsReceiptItems'] });
  if (!gr) throw new Error('Goods receipt not found');
  if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Not authorized');

  const dayjs = require('dayjs');
  const customParseFormat = require('dayjs/plugin/customParseFormat');
  dayjs.extend(customParseFormat);

  for (const row of rows) {
    const sku = (row.SKU || row['sku'] || '').trim();
    if (!sku) continue;

    const bbdStr = (row['Best Before Date (DD/MM/YYYY)'] || row['Best Before Date'] || row['bbd'] || row['best_before_date'] || '').trim();
    const batch = (row['Batch Number'] || row['Batch'] || row['batch'] || row['batch_number'] || '').trim();

    const items = gr.GoodsReceiptItems.filter(i => i.productSku === sku);
    for (const item of items) {
      const updates = {};
      if (batch) updates.batchId = batch;
      if (bbdStr) {
        const d = dayjs(bbdStr, ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']);
        if (d.isValid()) updates.bestBeforeDate = d.format('YYYY-MM-DD');
      }
      if (Object.keys(updates).length > 0) await item.update(updates);
    }
  }
  return getById(id, reqUser);
}

async function remove(id, reqUser) {
  const t = await GoodsReceipt.sequelize.transaction();
  try {
    const gr = await GoodsReceipt.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!gr) throw new Error('Goods receipt not found');
    if (reqUser.role !== 'super_admin' && gr.companyId !== reqUser.companyId) throw new Error('Goods receipt not found');

    // Destroy pending stocks and logs
    await ProductStock.destroy({
      where: {
        status: 'PENDING',
        reason: { [Op.like]: `ASN:${gr.id}:%` }
      },
      transaction: t
    });

    await InventoryLog.destroy({
      where: {
        type: 'PENDING_IN',
        reason: { [Op.like]: `ASN Pending Receipt:${gr.id}:%` }
      },
      transaction: t
    });

    await GoodsReceiptItem.destroy({ where: { goodsReceiptId: id }, transaction: t });
    await gr.destroy({ transaction: t });

    await t.commit();
    return { deleted: true };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { list, getById, create, updateReceived, updateAsnItems, finalizeReceiving, remove, exportCsvTemplate, importCsvBbd };
