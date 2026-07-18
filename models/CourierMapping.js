const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CourierMapping = sequelize.define('CourierMapping', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  requestedService: { type: DataTypes.STRING, allowNull: false },
  courierName: { type: DataTypes.STRING, allowNull: false },
  courierService: { type: DataTypes.STRING, allowNull: false }
}, {
  tableName: 'courier_mappings',
  timestamps: true,
  underscored: true
});

module.exports = CourierMapping;
