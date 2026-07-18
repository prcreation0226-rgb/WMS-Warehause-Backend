const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const InventoryLog = sequelize.define('InventoryLog', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  productId: { type: DataTypes.INTEGER, allowNull: false },
  warehouseId: { type: DataTypes.INTEGER, allowNull: false },
  type: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: { isIn: [['IN', 'OUT', 'TRANSFER', 'ALLOCATE', 'DEALLOCATE', 'PENDING_IN']] },
  },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  referenceId: { type: DataTypes.STRING, allowNull: true },
  locationId: { type: DataTypes.INTEGER, allowNull: true },
  batchId: { type: DataTypes.INTEGER, allowNull: true },
  batchNumber: { type: DataTypes.STRING, allowNull: true },
  bestBeforeDate: { type: DataTypes.DATEONLY, allowNull: true },
  userId: { type: DataTypes.INTEGER, allowNull: true },
  reason: { type: DataTypes.STRING, allowNull: true },
  clientId: { type: DataTypes.INTEGER, allowNull: true },
  newStockLevel: { type: DataTypes.INTEGER, allowNull: true, field: 'new_stock_level' },
  newAllocatedLevel: { type: DataTypes.INTEGER, allowNull: true, field: 'new_allocated_level' },
  newOnHandLevel: { type: DataTypes.INTEGER, allowNull: true, field: 'new_on_hand_level' },
  newOffHandLevel: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0, field: 'new_off_hand_level' },
}, {
  tableName: 'inventory_logs',
  timestamps: true,
  underscored: true,
  hooks: {
    beforeCreate: async (log, options) => {
      try {
        const { ProductStock, OrderItem, SalesOrder, Inventory, Product } = log.sequelize.models;

        // Automatically resolve clientId from Product if it is null
        if (!log.clientId && log.productId) {
          const prod = await Product.findByPk(log.productId, { transaction: options.transaction });
          if (prod && prod.clientId) {
            log.clientId = prod.clientId;
          }
        }

        // 1. Calculate physical stock levels from ProductStock (client-specific if clientId is set)
        const psWhere = { productId: log.productId, warehouseId: log.warehouseId, status: 'ACTIVE' };
        if (log.clientId) {
          psWhere.clientId = log.clientId;
        }
        const physicalQty = await ProductStock.sum('quantity', {
          where: psWhere,
          transaction: options.transaction
        }) || 0;

        // 2. Calculate active reservations directly from OrderItems (client-specific if clientId is set)
        const orderWhere = {
          status: ['DRAFT', 'NEW', 'CONFIRMED', 'ALLOCATED', 'PRINTED', 'PICKING_IN_PROGRESS', 'PICKING', 'PICKED', 'PACKING_IN_PROGRESS', 'PACKING', 'PACKED', 'BACKORDER']
        };
        if (log.clientId) {
          orderWhere.customerId = log.clientId;
        }
        const activeReservedQty = await OrderItem.sum('quantity', {
          where: {
            productId: log.productId,
            warehouseId: log.warehouseId
          },
          include: [{
            model: SalesOrder,
            as: 'SalesOrder',
            where: orderWhere,
            attributes: []
          }],
          transaction: options.transaction
        }) || 0;

        // 3. Determine the final physical and reserved levels (for the log)
        let finalPhysical = physicalQty;
        let finalReserved = activeReservedQty;

        // 4. Ensure values are non-negative
        finalPhysical = Math.max(0, finalPhysical);
        finalReserved = Math.max(0, finalReserved);
        const finalOnHand = Math.max(0, finalPhysical - finalReserved);

        // 5. Update/Heal summary Inventory table (always overall across all clients)
        if (Inventory) {
          const overallPhysical = await ProductStock.sum('quantity', {
            where: { productId: log.productId, warehouseId: log.warehouseId, status: 'ACTIVE' },
            transaction: options.transaction
          }) || 0;

          const overallReserved = await OrderItem.sum('quantity', {
            where: {
              productId: log.productId,
              warehouseId: log.warehouseId
            },
            include: [{
              model: SalesOrder,
              as: 'SalesOrder',
              where: {
                status: ['DRAFT', 'NEW', 'CONFIRMED', 'ALLOCATED', 'PRINTED', 'PICKING_IN_PROGRESS', 'PICKING', 'PICKED', 'PACKING_IN_PROGRESS', 'PACKING', 'PACKED', 'BACKORDER']
              },
              attributes: []
            }],
            transaction: options.transaction
          }) || 0;

          const [inv] = await Inventory.findOrCreate({
            where: { productId: log.productId, warehouseId: log.warehouseId },
            defaults: { quantity: overallPhysical, reservedQuantity: overallReserved },
            transaction: options.transaction
          });
          await inv.update({
            quantity: overallPhysical,
            reservedQuantity: overallReserved
          }, { 
            transaction: options.transaction,
            silent: true 
          });
        }

        // 6. Assign levels to log record
        log.newStockLevel = finalPhysical;
        log.newAllocatedLevel = finalReserved;
        log.newOnHandLevel = finalOnHand;
        log.newOffHandLevel = 0;
      } catch (err) {
        console.error('Error calculating stock levels in beforeCreate hook:', err);
      }
    }
  }
});

module.exports = InventoryLog;
