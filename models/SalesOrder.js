const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const SalesOrder = sequelize.define('SalesOrder', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  orderNumber: { type: DataTypes.STRING, allowNull: false },
  customerId: { type: DataTypes.INTEGER, allowNull: true },
  orderDate: { type: DataTypes.DATEONLY, allowNull: true },
  requiredDate: { type: DataTypes.DATEONLY, allowNull: true },
  priority: { type: DataTypes.STRING, defaultValue: 'MEDIUM' },
  salesChannel: { type: DataTypes.STRING, defaultValue: 'DIRECT' },
  orderType: { type: DataTypes.STRING, allowNull: true },
  referenceNumber: { type: DataTypes.STRING, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  notesFromBuyer: { type: DataTypes.TEXT, allowNull: true, field: 'notes_from_buyer' },
  notesToBuyer: { type: DataTypes.TEXT, allowNull: true, field: 'notes_to_buyer' },
  giftNote: { type: DataTypes.TEXT, allowNull: true, field: 'gift_note' },
  internalNotes: { type: DataTypes.TEXT, allowNull: true, field: 'internal_notes' },
  customField2: { type: DataTypes.STRING, allowNull: true, field: 'custom_field2' },
  customField3: { type: DataTypes.STRING, allowNull: true, field: 'custom_field3' },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'NEW',
    validate: { isIn: [['DRAFT', 'NEW', 'CONFIRMED', 'ALLOCATED', 'PRINTED', 'PICKING_IN_PROGRESS', 'PICKING', 'PICKED', 'PACKING_IN_PROGRESS', 'PACKING', 'PACKED', 'SHIPPED', 'DISPATCHED', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'BACKORDER']] },
  },
  totalAmount: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
  netAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  vatAmount: { type: DataTypes.DECIMAL(12, 2), allowNull: true, defaultValue: 0 },
  createdBy: { type: DataTypes.INTEGER, allowNull: true },
  
  // New shipping/courier & traceability fields
  externalRef: { type: DataTypes.STRING, allowNull: true },
  parts: { type: DataTypes.STRING, defaultValue: '1of1' },
  postcode: { type: DataTypes.STRING, allowNull: true },
  country: { type: DataTypes.STRING, allowNull: true },
  courierName: { type: DataTypes.STRING, allowNull: true },
  courierService: { type: DataTypes.STRING, allowNull: true },
  requestedShippingService: { type: DataTypes.STRING, allowNull: true },
  requiredDespatchDate: { type: DataTypes.DATEONLY, allowNull: true },
  requiredDeliveryDate: { type: DataTypes.DATEONLY, allowNull: true },
  noOfParcels: { type: DataTypes.INTEGER, defaultValue: 1 },
  totalWeight: { type: DataTypes.DECIMAL(10, 3), defaultValue: 0.0 },
  totalItems: { type: DataTypes.INTEGER, defaultValue: 1 },
  trackingStatus: { type: DataTypes.STRING, allowNull: true },
  trackingNumber: { type: DataTypes.STRING, allowNull: true },
  tags: { type: DataTypes.STRING, allowNull: true },
  batchId: { type: DataTypes.INTEGER, defaultValue: 0 },
  orderLock: { type: DataTypes.BOOLEAN, defaultValue: false },
  sequenceNumber: { type: DataTypes.INTEGER, allowNull: true },
  recipientName: { type: DataTypes.STRING, allowNull: true },
  addressLine1: { type: DataTypes.STRING, allowNull: true },
  addressLine2: { type: DataTypes.STRING, allowNull: true },
  addressLine3: { type: DataTypes.STRING, allowNull: true },
  town: { type: DataTypes.STRING, allowNull: true },
  county: { type: DataTypes.STRING, allowNull: true },
  phone: { type: DataTypes.STRING, allowNull: true },
  email: { type: DataTypes.STRING, allowNull: true },

  // ShipStation API v2 & Packing Workflow fields
  shipstationOrderId: { type: DataTypes.STRING, allowNull: true, field: 'shipstation_order_id' },
  shipstationStoreId: { type: DataTypes.STRING, allowNull: true, field: 'shipstation_store_id' },
  checkContentRequired: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'check_content_required' },
  isBundle: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_bundle' }
}, {
  tableName: 'sales_orders',
  timestamps: true,
  underscored: true,
});

module.exports = SalesOrder;
