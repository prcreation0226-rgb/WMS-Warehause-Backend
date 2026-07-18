const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const SavedAddress = sequelize.define('SavedAddress', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  customerId: { type: DataTypes.INTEGER, allowNull: true },
  recipientName: { type: DataTypes.STRING, allowNull: false },
  addressLine1: { type: DataTypes.STRING, allowNull: false },
  addressLine2: { type: DataTypes.STRING, allowNull: true },
  addressLine3: { type: DataTypes.STRING, allowNull: true },
  town: { type: DataTypes.STRING, allowNull: false },
  county: { type: DataTypes.STRING, allowNull: true },
  postcode: { type: DataTypes.STRING, allowNull: false },
  country: { type: DataTypes.STRING, allowNull: false, defaultValue: 'UNITED KINGDOM' },
  phone: { type: DataTypes.STRING, allowNull: true },
  email: { type: DataTypes.STRING, allowNull: true }
}, {
  tableName: 'saved_addresses',
  timestamps: true,
  underscored: true,
});

module.exports = SavedAddress;
