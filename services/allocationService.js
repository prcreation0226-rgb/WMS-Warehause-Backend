const { SalesOrder, OrderItem, Product, ProductStock, Location, Inventory, Warehouse, sequelize } = require('../models');
const { Op } = require('sequelize');

/**
 * Automatically allocates stock to unallocated items in a Sales Order.
 * Priority Rules (Option 1):
 * 1. Default picking location (shortest to longest BB date)
 * 2. Shortest BB date in other locations
 * 3. Lowest picking sequence if BB date is identical
 *
 * It will not override already allocated items (Option 2 manual selections).
 */
async function allocateOrder(orderId, transaction = null) {
  const executeAllocation = async (t) => {
    // 1. Fetch Sales Order with its items
    const order = await SalesOrder.findByPk(orderId, {
      include: [{ association: 'OrderItems', include: [Product] }],
      transaction: t,
      lock: t ? t.LOCK.UPDATE : undefined
    });

    if (!order) {
      throw new Error('Order not found');
    }

    const allowedStatuses = ['DRAFT', 'NEW', 'CONFIRMED', 'ALLOCATED', 'PRINTED', 'BACKORDER'];
    if (!allowedStatuses.includes((order.status || '').toUpperCase())) {
      throw new Error(`Order cannot be allocated. Current status is ${order.status}`);
    }

    let allAllocated = true;

    for (const item of order.OrderItems) {
      // If already hard-allocated (locationId is defined), skip this line
      if (item.locationId) {
        continue;
      }

      const product = item.Product;
      if (!product) continue;

      const defaultPickingLocationId = product.defaultPickingLocationId;
      const warehouseId = item.warehouseId;
      
      if (!warehouseId) {
        throw new Error(`Warehouse is not assigned for item SKU: ${product.sku || product.name}. Please select a warehouse first.`);
      }

      let remainingQuantity = item.quantity;

      // 2. Fetch eligible ProductStock lines with Location info
      const stockRows = await ProductStock.findAll({
        where: {
          productId: item.productId,
          warehouseId: warehouseId,
          companyId: order.companyId,
          quantity: { [Op.gt]: sequelize.col('reserved') },
          locationId: { [Op.ne]: null },
          status: 'ACTIVE'
        },
        include: [
          {
            model: Location,
            attributes: ['id', 'pickSequence']
          },
          {
            model: Warehouse,
            where: { status: 'ACTIVE' },
            required: true,
            attributes: []
          }
        ],
        order: [
          // Rule 1: Default picking location first
          [sequelize.literal(`location_id = ${defaultPickingLocationId ? defaultPickingLocationId : -1}`), 'DESC'],
          // Rule 2: Shortest BB date first (earliest expiration). If BB date is null, put it last.
          [sequelize.literal('best_before_date IS NULL'), 'ASC'],
          ['bestBeforeDate', 'ASC'],
          // Rule 3: Lowest picking sequence first
          [sequelize.literal('`Location`.`pick_sequence` IS NULL'), 'ASC'],
          [sequelize.literal('`Location`.`pick_sequence`'), 'ASC'],
          ['createdAt', 'ASC'] // fallback FIFO
        ],
        transaction: t
      });

      const totalAvailable = stockRows.reduce((sum, row) => sum + (Number(row.quantity) - Number(row.reserved)), 0);
      if (totalAvailable < remainingQuantity) {
        // Insufficient stock in this warehouse to allocate fully
        allAllocated = false;
        continue;
      }

      // 3. Allocate quantities to specific locations
      let firstRowUpdated = false;
      for (const row of stockRows) {
        if (remainingQuantity <= 0) break;

        const availableInRow = Number(row.quantity) - Number(row.reserved);
        if (availableInRow <= 0) continue;

        const toReserve = Math.min(availableInRow, remainingQuantity);

        // Hard allocate in ProductStock
        await row.increment('reserved', { by: toReserve, transaction: t });

        if (!firstRowUpdated) {
          // Update the first order item with location details
          await item.update({
            locationId: row.locationId,
            batchNumber: row.batchNumber,
            bestBeforeDate: row.bestBeforeDate,
            quantity: toReserve
          }, { transaction: t });
          firstRowUpdated = true;
        } else {
          // If split, create a new child order item for this split lot
          await OrderItem.create({
            salesOrderId: order.id,
            productId: item.productId,
            quantity: toReserve,
            unitPrice: item.unitPrice,
            warehouseId: warehouseId,
            locationId: row.locationId,
            batchNumber: row.batchNumber,
            bestBeforeDate: row.bestBeforeDate
          }, { transaction: t });
        }

        remainingQuantity -= toReserve;
      }
    }

    // 4. Create PickLists for each warehouse involved if allAllocated is true
    if (allAllocated) {
      const { PickList, PickListItem, PackingTask } = require('../models');
      
      // Delete any existing picklists/packing tasks first to prevent duplicates if re-allocating
      const existingPickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
      for (const pl of existingPickLists) {
        await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
        await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
        await pl.destroy({ transaction: t });
      }
      await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });

      const orderItemsForPick = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
      const warehouseGroups = {};
      orderItemsForPick.forEach(item => {
        if (!warehouseGroups[item.warehouseId]) warehouseGroups[item.warehouseId] = [];
        warehouseGroups[item.warehouseId].push(item);
      });

      for (const whId in warehouseGroups) {
        const pickList = await PickList.create({
          salesOrderId: order.id,
          warehouseId: whId,
          status: 'NOT_STARTED',
        }, { transaction: t });

        for (const item of warehouseGroups[whId]) {
          await PickListItem.create({
            pickListId: pickList.id,
            productId: item.productId,
            quantityRequired: item.quantity,
            quantityPicked: 0,
            locationId: item.locationId,
            batchNumber: item.batchNumber,
            bestBeforeDate: item.bestBeforeDate,
            warehouseId: item.warehouseId,
          }, { transaction: t });
        }
        
        await PackingTask.create({
          salesOrderId: order.id,
          pickListId: pickList.id,
          status: 'NOT_STARTED',
        }, { transaction: t });
      }

      await order.update({ status: 'ALLOCATED' }, { transaction: t });
    } else {
      await order.update({ status: 'BACKORDER' }, { transaction: t });
    }

    return { success: allAllocated, status: order.status };
  };

  if (transaction) {
    return executeAllocation(transaction);
  } else {
    return sequelize.transaction(async (t) => {
      return executeAllocation(t);
    });
  }
}

module.exports = {
  allocateOrder
};
