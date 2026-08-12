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
  
  // Packing & Bundle fields
  scannedQty: { type: DataTypes.INTEGER, defaultValue: 0, field: 'scanned_qty' },
  isBundleParent: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_bundle_parent' },
  bundleHeader: { type: DataTypes.STRING, allowNull: true, field: 'bundle_header' },
  productImageUrl: { type: DataTypes.TEXT, allowNull: true, field: 'product_image_url' },
  
  // Amazon Customization fields
  originalSku: { type: DataTypes.STRING, allowNull: true, field: 'original_sku' },
  customizedUrl: { type: DataTypes.TEXT, allowNull: true, field: 'customized_url' },
}, {
  tableName: 'order_items',
  timestamps: true,
  underscored: true,
});

module.exports = OrderItem;
