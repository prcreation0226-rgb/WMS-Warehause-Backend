const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const IntegrationLog = sequelize.define('IntegrationLog', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  platform: { 
    type: DataTypes.STRING(50), 
    allowNull: false 
  },
  actionType: { 
    type: DataTypes.STRING(50), 
    allowNull: false // 'PULL_ORDERS', 'PUSH_STOCK', 'FULFILL_ORDER', 'GENERATE_LABEL'
  },
  status: { 
    type: DataTypes.STRING(20), 
    allowNull: false // 'SUCCESS', 'FAILED'
  },
  message: { 
    type: DataTypes.TEXT, 
    allowNull: true 
  },
  recordsProcessed: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  }
}, {
  tableName: 'integration_logs',
  timestamps: true,
  underscored: true,
});

module.exports = IntegrationLog;
