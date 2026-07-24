const { PickList, PickListItem, SalesOrder, Product, Warehouse, User } = require('../models');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'picker') {
    if (reqUser.warehouseId) {
      where[Op.or] = [
        { assignedTo: reqUser.id },
        { assignedTo: null, warehouseId: reqUser.warehouseId }
      ];
    } else {
      where[Op.or] = [
        { assignedTo: reqUser.id },
        { assignedTo: null }
      ];
    }
  } else if (query.warehouseId) {
    where.warehouseId = query.warehouseId;
  }
  if (query.status) where.status = query.status;
  const orderInclude = {
    association: 'SalesOrder',
    attributes: ['id', 'orderNumber', 'status', 'companyId', 'recipientName', 'customerId'],
    include: [{ association: 'Client', attributes: ['name'] }]
  };
  if (reqUser.role === 'warehouse_manager' || reqUser.role === 'company_admin') {
    orderInclude.where = { companyId: reqUser.companyId };
    orderInclude.required = true;
  } else if (reqUser.role === 'super_admin' && query.companyId) {
    orderInclude.where = { companyId: query.companyId };
    orderInclude.required = true;
  }
  const pickLists = await PickList.findAll({
    where,
    order: [['id', 'DESC']],
    include: [
      orderInclude,
      { association: 'Warehouse', attributes: ['id', 'name'] },
      { association: 'User', attributes: ['id', 'name', 'email'], required: false },
      { association: 'PickListItems', include: ['Product', 'Location', 'Warehouse'] },
    ],
  });
  return pickLists;
}

async function getById(id, reqUser) {
  const pickList = await PickList.findByPk(id, {
    include: [
      { association: 'SalesOrder', include: ['Client'] },
      { association: 'Warehouse' },
      { association: 'User', attributes: { exclude: ['passwordHash'] }, required: false },
      { association: 'PickListItems', include: ['Product', 'Location', 'Warehouse'] },
    ],
  });
  if (!pickList) throw new Error('Pick list not found');
  const order = await SalesOrder.findByPk(pickList.salesOrderId);
  if (reqUser.role === 'picker' && pickList.assignedTo !== reqUser.id) throw new Error('Pick list not found');
  if (reqUser.role === 'company_admin' && order.companyId !== reqUser.companyId) throw new Error('Pick list not found');
  return pickList;
}

async function assignPicker(pickListId, userId, reqUser) {
  if (reqUser.role !== 'warehouse_manager' && reqUser.role !== 'company_admin' && reqUser.role !== 'super_admin') {
    throw new Error('Only Warehouse Manager can assign picker');
  }
  const pickList = await PickList.findByPk(pickListId, { include: ['SalesOrder'] });
  if (!pickList) throw new Error('Pick list not found');
  const order = await SalesOrder.findByPk(pickList.salesOrderId);
  if (reqUser.role === 'company_admin' && order.companyId !== reqUser.companyId) throw new Error('Pick list not found');
  const user = await User.findByPk(userId);
  if (!user || user.role !== 'picker' || user.companyId !== order.companyId) throw new Error('Invalid picker');

  await pickList.update({ assignedTo: userId, status: 'ASSIGNED' });
  await order.update({ status: 'PICKING' });

  return getById(pickListId, reqUser);
}

async function startPicking(id, reqUser) {
  const pickList = await PickList.findByPk(id, { include: ['SalesOrder'] });
  if (!pickList) throw new Error('Pick list not found');
  if (reqUser.role === 'picker' && pickList.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

  await pickList.update({ status: 'PARTIALLY_PICKED' });
  await pickList.SalesOrder.update({ status: 'PICKING' });

  return getById(id, reqUser);
}

async function updatePickedQuantity(pickListItemId, quantityPicked, reqUser) {
  const item = await PickListItem.findByPk(pickListItemId, { include: ['PickList'] });
  if (!item) throw new Error('Item not found');
  const pickList = await PickList.findByPk(item.pickListId, { include: ['SalesOrder'] });
  if (reqUser.role === 'picker' && pickList.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

  await item.update({ quantityPicked: quantityPicked ?? item.quantityRequired });

  if (pickList.status === 'NOT_STARTED' || pickList.status === 'ASSIGNED') {
    await pickList.update({ status: 'PARTIALLY_PICKED' });
    await pickList.SalesOrder.update({ status: 'PICKING' });
  }

  return item;
}

async function completePicking(id, reqUser) {
  const pickList = await PickList.findByPk(id, { include: ['PickListItems', 'SalesOrder'] });
  if (!pickList) throw new Error('Pick list not found');
  if (reqUser.role === 'picker' && pickList.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

  if (pickList.status === 'PICKED') {
    return getById(id, reqUser);
  }

  await pickList.update({ status: 'PICKED' });
  await pickList.SalesOrder.update({ status: 'PICKED' });

  // Create Packing Task automatically
  const { PackingTask } = require('../models');

  const existingTask = await PackingTask.findOne({ where: { pickListId: pickList.id } });
  if (!existingTask) {
    await PackingTask.create({
      salesOrderId: pickList.salesOrderId,
      pickListId: pickList.id,
      status: 'NOT_STARTED',
      warehouseId: pickList.warehouseId // Assuming warehouseId exists on PickList
    });
  }

  return getById(id, reqUser);
}

async function rejectAssignment(id, reqUser) {
  const pickList = await PickList.findByPk(id, { include: ['SalesOrder'] });
  if (!pickList) throw new Error('Pick list not found');
  if (reqUser.role === 'picker' && pickList.assignedTo !== reqUser.id) throw new Error('Not assigned to you');

  await pickList.update({ status: 'NOT_STARTED', assignedTo: null });
  // Revert order status to PRINTED if it was PICKING
  // Simply reverting to PRINTED seems correct as it goes back to "Printed / Ready to Pick" state.
  await pickList.SalesOrder.update({ status: 'PRINTED' });

  return { message: 'Assignment rejected', id };
}

async function deletePickList(id, reqUser) {
  console.log(`[pickingService] deletePickList starting for ID: ${id} by user: ${reqUser.id} (${reqUser.role})`);
  
  if (reqUser.role !== 'warehouse_manager' && reqUser.role !== 'company_admin' && reqUser.role !== 'super_admin') {
    console.warn(`[pickingService] Permission denied for user: ${reqUser.id} with role: ${reqUser.role}`);
    throw new Error('Only Managers and Admins can delete pick lists');
  }

  const { PackingTask } = require('../models');
  const pickList = await PickList.findByPk(id);
  if (!pickList) {
    console.warn(`[pickingService] Pick list not found: ${id}`);
    throw new Error('Pick list not found');
  }

  const order = await SalesOrder.findByPk(pickList.salesOrderId);
  if (reqUser.role === 'company_admin' || reqUser.role === 'warehouse_manager') {
    if (order && order.companyId !== reqUser.companyId) {
      console.warn(`[pickingService] Access denied: Pick list company ${order.companyId} doesn't match user company ${reqUser.companyId}`);
      throw new Error('Pick list not found');
    }
  }

  const sequelize = require('../config/db').sequelize;
  const transaction = await sequelize.transaction();

  try {
    console.log(`[pickingService] Deleting pick list items for pick list ID: ${id}`);
    await PickListItem.destroy({ where: { pickListId: id }, transaction });

    console.log(`[pickingService] Deleting packing tasks for pick list ID: ${id}`);
    await PackingTask.destroy({ where: { pickListId: id }, transaction });

    if (order) {
      const pickRelatedStatuses = ['ALLOCATED', 'PRINTED', 'PICKING_IN_PROGRESS', 'PICKING', 'PICKED'];
      if (pickRelatedStatuses.includes((order.status || '').toUpperCase())) {
        console.log(`[pickingService] Reverting SalesOrder ${order.id} status to CONFIRMED (was ${order.status})`);
        await order.update({ status: 'CONFIRMED' }, { transaction });
      }
    }

    console.log(`[pickingService] Deleting PickList ID: ${id}`);
    await pickList.destroy({ transaction });

    await transaction.commit();
    console.log(`[pickingService] Pick list ID: ${id} deleted successfully`);
    return { message: 'Pick list deleted successfully', id };
  } catch (err) {
    await transaction.rollback();
    console.error(`[pickingService] Failed to delete pick list ID: ${id}. Error:`, err);
    throw err;
  }
}

module.exports = { list, getById, assignPicker, startPicking, updatePickedQuantity, completePicking, rejectAssignment, deletePickList };
