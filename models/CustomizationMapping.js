const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const CustomizationMapping = sequelize.define('CustomizationMapping', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  companyId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 1
  },
  originalSku: {
    type: DataTypes.STRING,
    allowNull: true
  },
  asin: {
    type: DataTypes.STRING,
    allowNull: false
  },
  optionValue: {
    type: DataTypes.STRING,
    allowNull: false
  },
  processedSku: {
    type: DataTypes.STRING,
    allowNull: false
  },
  outOfStock: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  extra: {
    type: DataTypes.STRING,
    allowNull: true
  },
  costPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  }
}, {
  tableName: 'customization_mappings',
  timestamps: true
});

module.exports = CustomizationMapping;
