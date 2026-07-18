const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const OrderItem = sequelize.define('OrderItem', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  salesOrderId: { type: DataTypes.INTEGER, allowNull: false },
  productId: { type: DataTypes.INTEGER, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  unitPrice: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  netPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  grossPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  vatRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
  vatAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  warehouseId: { type: DataTypes.INTEGER, allowNull: true },
  locationId: { type: DataTypes.INTEGER, allowNull: true },
  batchNumber: { type: DataTypes.STRING, allowNull: true },
  bestBeforeDate: { type: DataTypes.DATEONLY, allowNull: true },
}, {
  tableName: 'order_items',
  timestamps: true,
  underscored: true,
});

module.exports = OrderItem;
