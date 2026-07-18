const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CourierService = sequelize.define('CourierService', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  courier: { type: DataTypes.STRING, allowNull: false },
  serviceCode: { type: DataTypes.STRING, allowNull: false },
  serviceName: { type: DataTypes.STRING, allowNull: false }
}, {
  tableName: 'courier_services',
  timestamps: true,
  underscored: true
});

module.exports = CourierService;
