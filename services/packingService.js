const { PackingTask, PickList, SalesOrder, User, OrderItem, sequelize } = require('../models');
const inventoryService = require('./inventoryService');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'packer') {
    where[Op.or] = [
      { assignedTo: reqUser.id },
      { assignedTo: null }
    ];
  }

  if (query.status) where.status = query.status;

  // Filter by Company for non-super-admins (assuming reqUser.companyId exists)
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    // We filter via SalesOrder include
  }

  const tasks = await PackingTask.findAll({
    where,
    order: [['id', 'DESC']],
    include: [
      {
        association: 'SalesOrder',
        where: (reqUser.companyId ? { companyId: reqUser.companyId } : {}),
        required: true,
        attributes: ['id', 'orderNumber', 'status', 'recipientName', 'customerId'],
        include: ['Client']
      },
      {
        association: 'PickList',
        where: { status: 'PICKED' },
        required: true,
        attributes: ['id', 'status'],
        include: ['PickListItems', { association: 'Warehouse', attributes: ['id', 'name'] }]
      },
      { association: 'User', attributes: ['id', 'name', 'email'], required: false },
    ],
  });
  return tasks;
}

async function getById(id, reqUser) {
  const task = await PackingTask.findByPk(id, {
    include: [
      { 
        association: 'SalesOrder', 
        include: [
          { association: 'OrderItems', include: ['Product', 'Warehouse', 'Location'] },
          'Client'
        ] 
      },
      { association: 'PickList', include: ['PickListItems'] },
      { association: 'User', attributes: { exclude: ['passwordHash'] }, required: false },
    ],
  });
  if (!task) throw new Error('Packing task not found');
  if (reqUser.role === 'packer' && task.assignedTo !== reqUser.id) throw new Error('Packing task not found');
  if (reqUser.role === 'company_admin' && task.SalesOrder.companyId !== reqUser.companyId) throw new Error('Packing task not found');
  return task;
}

async function assignPacker(taskId, userId, reqUser) {
  if (reqUser.role !== 'warehouse_manager' && reqUser.role !== 'company_admin' && reqUser.role !== 'super_admin') {
    throw new Error('Only Warehouse Manager can assign packer');
  }
  const task = await PackingTask.findByPk(taskId, { include: ['SalesOrder'] });
  if (!task) throw new Error('Packing task not found');
  if (task.SalesOrder.companyId !== reqUser.companyId && reqUser.role !== 'super_admin') throw new Error('Packing task not found');
  const user = await User.findByPk(userId);
  if (!user || user.role !== 'packer' || user.companyId !== task.SalesOrder.companyId) throw new Error('Invalid packer');

  await task.update({ assignedTo: userId, status: 'ASSIGNED' });

  return getById(taskId, reqUser);
}

async function startPacking(id, reqUser) {
  const task = await PackingTask.findByPk(id, { include: ['SalesOrder'] });
  if (!task) throw new Error('Packing task not found');
  if (reqUser.role === 'packer' && task.assignedTo !== reqUser.id) throw new Error('Not assigned to you');
  try {
    console.log('Starting packing task:', id, 'User:', reqUser.id);
    const task = await PackingTask.findByPk(id, { include: ['SalesOrder'] });
    if (!task) throw new Error('Packing task not found');

    console.log('Task found:', task.id, 'AssignedTo:', task.assignedTo);
    if (reqUser.role === 'packer' && task.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

    console.log('Updating task status to PACKING');
    await task.update({ status: 'PACKING' });

    console.log('Updating SalesOrder status to PACKING_IN_PROGRESS');
    if (task.SalesOrder) {
      await task.SalesOrder.update({ status: 'PACKING' });
    } else {
      console.warn('SalesOrder not found for task', id);
    }

    return getById(id, reqUser);
  } catch (error) {
    console.error('Error in startPacking:', error);
    throw error;
  }
}

async function completePacking(id, reqUser) {
  const task = await PackingTask.findByPk(id, {
    include: [
      {
        association: 'SalesOrder',
        include: [{ association: 'OrderItems' }]
      },
      { association: 'PickList' }
    ]
  });
  if (!task) throw new Error('Packing task not found');
  if (reqUser.role === 'packer' && task.assignedTo !== reqUser.id) throw new Error('Not assigned to you');
  if (task.status === 'PACKED') return task; // Idempotency

  const t = await sequelize.transaction();
  try {
    // Create Shipment
    const { Shipment } = require('../models');
    await Shipment.create({
      salesOrderId: task.salesOrderId,
      companyId: task.SalesOrder.companyId,
      packedBy: reqUser.id,
      dispatchDate: new Date(),
      deliveryStatus: 'READY_TO_SHIP'
    }, { transaction: t });

    // Deduct Stock for each order item
    if (task.SalesOrder && task.SalesOrder.OrderItems) {
      console.log(`[DEBUG_PACKING] Processing ${task.SalesOrder.OrderItems.length} items for task ${id}`);
      for (const item of task.SalesOrder.OrderItems) {
        console.log(`[DEBUG_PACKING] Shipping Product: ${item.productId}, Qty: ${item.quantity}, WH: ${task.PickList?.warehouseId}, Company: ${task.SalesOrder.companyId}`);
        await inventoryService.shipStock({
          productId: item.productId,
          companyId: task.SalesOrder.companyId,
          warehouseId: task.PickList.warehouseId,
          clientId: task.SalesOrder.customerId,
          quantity: item.quantity,
          referenceId: task.SalesOrder.orderNumber,
          userId: reqUser.id
        }, t);
      }
    }

    await task.update({ status: 'PACKED', packedAt: new Date() }, { transaction: t });
    await task.SalesOrder.update({ status: 'PACKED' }, { transaction: t });

    await t.commit();
    return getById(id, reqUser);
  } catch (error) {
    await t.rollback();
    console.error('Error in completePacking (Dispatch):', error);
    throw error;
  }
}

async function rejectAssignment(id, reqUser) {
  const task = await PackingTask.findByPk(id, { include: ['SalesOrder'] });
  if (!task) throw new Error('Packing task not found');
  if (reqUser.role === 'packer' && task.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

  // Unassign and reset status
  await task.update({ assignedTo: null, status: 'NOT_STARTED' });

  // Return simple success object because getById will fail (permission denied for unassigned task)
  return { id: parseInt(id), status: 'NOT_STARTED', assignedTo: null, success: true };
}

function firstProductImage(images) {
  if (images == null || images === '') return null;
  let list = images;
  if (typeof images === 'string') {
    const s = images.trim();
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch (e) { list = [s]; }
    } else if (s.includes(',')) {
      list = s.split(',').map(x => x.trim()).filter(Boolean);
    } else {
      list = [s];
    }
  }
  if (Array.isArray(list) && list.length > 0) {
    return list[0];
  }
  return null;
}



function cleanImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.includes('unsplash.com')) return null;
  return trimmed;
}

async function getPackingScanOrderByBarcode(barcode, reqUser) {
  if (!barcode) throw new Error('Order barcode required');

  const cleanBarcode = String(barcode).trim();
  const where = {
    [Op.or]: [
      { orderNumber: cleanBarcode },
      { orderNumber: { [Op.like]: `%${cleanBarcode}%` } },
      { shipstationOrderId: cleanBarcode },
      { externalRef: cleanBarcode }
    ]
  };
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    where.companyId = reqUser.companyId;
  }

  let order = await SalesOrder.findOne({
    where,
    include: [
      {
        association: 'OrderItems',
        include: ['Product']
      },
      'Client'
    ]
  });

  if (!order && !isNaN(cleanBarcode)) {
    const pkWhere = { id: parseInt(cleanBarcode) };
    if (reqUser.role !== 'super_admin' && reqUser.companyId) {
      pkWhere.companyId = reqUser.companyId;
    }
    order = await SalesOrder.findOne({
      where: pkWhere,
      include: [
        { association: 'OrderItems', include: ['Product'] },
        'Client'
      ]
    });
  }

  if (!order) throw new Error('Sales order not found for barcode: ' + barcode);

  // Format order items for Packing Desk and fetch dynamic product images from DB/API
  const items = await Promise.all(order.OrderItems.map(async item => {
    const p = item.Product || {};
    let rawImg = item.productImageUrl || p.imageUrl || p.image || firstProductImage(p.images) || null;
    let img = cleanImageUrl(rawImg);

    // Auto-clean old unsplash static URLs stored in DB
    if (item.productImageUrl && item.productImageUrl.includes('unsplash.com')) {
      try {
        await item.update({ productImageUrl: null });
      } catch (e) {}
    }
    if (p && p.id && p.images && JSON.stringify(p.images).includes('unsplash.com')) {
      try {
        await Product.update({ images: null }, { where: { id: p.id } });
      } catch (e) {}
    }

    if (!item.productImageUrl && img) {
      try {
        await item.update({ productImageUrl: img });
      } catch (e) {
        // Ignore update error
      }
    }

    return {
      id: item.id,
      productId: item.productId,
      name: p.name || item.bundleHeader || 'Product ' + item.productId,
      sku: p.sku || item.sku || 'N/A',
      barcode: p.barcode || p.sku || item.barcode || item.sku || '',
      quantity: item.quantity || 1,
      scannedQty: item.scannedQty || 0,
      bestBeforeDate: item.bestBeforeDate || p.bestBeforeDate || '31-May-2027',
      batchNumber: item.batchNumber || p.batchNumber || 'N/A',
      productImageUrl: img,
      isBundleParent: item.isBundleParent || false,
      bundleHeader: item.bundleHeader || null
    };
  }));

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    shipstationOrderId: order.shipstationOrderId,
    checkContentRequired: order.checkContentRequired !== false,
    isBundle: order.isBundle || false,
    status: order.status,
    items
  };
}

async function toggleCheckOrderContent(orderId, checkContentRequired) {
  const order = await SalesOrder.findByPk(orderId);
  if (!order) throw new Error('Sales order not found');
  await order.update({ checkContentRequired: Boolean(checkContentRequired) });
  return { id: order.id, checkContentRequired: order.checkContentRequired };
}

async function scanPackingItem(orderId, skuOrBarcode) {
  const order = await SalesOrder.findByPk(orderId, {
    include: [{ association: 'OrderItems', include: ['Product'] }]
  });
  if (!order) throw new Error('Sales order not found');

  const cleanQuery = String(skuOrBarcode).trim().toLowerCase();

  // Find matching item by SKU or Barcode
  let targetItem = order.OrderItems.find(item => {
    const p = item.Product || {};
    return (
      (p.sku && p.sku.toLowerCase() === cleanQuery) ||
      (p.barcode && p.barcode.toLowerCase() === cleanQuery) ||
      String(item.id) === cleanQuery
    );
  });

  if (!targetItem && order.OrderItems.length > 0) {
    // Fallback: match substring or pick first pending item if exact match not found
    targetItem = order.OrderItems.find(item => {
      const p = item.Product || {};
      return (p.name && p.name.toLowerCase().includes(cleanQuery));
    }) || order.OrderItems.find(item => (item.scannedQty || 0) < item.quantity);
  }

  if (!targetItem) {
    throw new Error('Item not found in this order: ' + skuOrBarcode);
  }

  const currentScanned = targetItem.scannedQty || 0;
  const isOverScan = currentScanned >= targetItem.quantity;
  const newScanned = currentScanned + 1;

  await targetItem.update({ scannedQty: newScanned });

  return {
    success: true,
    itemId: targetItem.id,
    scannedQty: newScanned,
    quantity: targetItem.quantity,
    isComplete: newScanned === targetItem.quantity,
    isOverScan,
    warning: isOverScan ? 'Extra scan detected! Please check picked quantity.' : null
  };
}

async function dispatchPackingOrder(orderId, reqUser, forceOverride = false) {
  const shipstationService = require('../modules/integrations/shipstation.service');
  return await shipstationService.createShippingLabelAndDispatch(orderId, reqUser, forceOverride);
}

module.exports = {
  list,
  getById,
  assignPacker,
  startPacking,
  completePacking,
  rejectAssignment,
  getPackingScanOrderByBarcode,
  toggleCheckOrderContent,
  scanPackingItem,
  dispatchPackingOrder
};
