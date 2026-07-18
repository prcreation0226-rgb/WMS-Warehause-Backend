const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const IntegrationConfig = sequelize.define('IntegrationConfig', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  platform: { 
    type: DataTypes.STRING(50), 
    allowNull: false // 'AMAZON', 'SHOPIFY_FFD', 'SHOPIFY_WHOLESALE', 'EBAY', 'ROYAL_MAIL'
  },
  status: { 
    type: DataTypes.STRING(20), 
    defaultValue: 'INACTIVE' // 'ACTIVE', 'INACTIVE', 'ERROR'
  },
  credentials: { 
    type: DataTypes.TEXT, 
    allowNull: false // JSON string storing keys and domains
  },
  lastSyncTime: { 
    type: DataTypes.DATE, 
    allowNull: true 
  }
}, {
  tableName: 'integration_configs',
  timestamps: true,
  underscored: true,
});

module.exports = IntegrationConfig;
