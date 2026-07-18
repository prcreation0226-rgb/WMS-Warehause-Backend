const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

const DespatchNoteTemplate = sequelize.define('DespatchNoteTemplate', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  companyId: { type: DataTypes.INTEGER, allowNull: false },
  customerId: { type: DataTypes.INTEGER, allowNull: false }, // Client reference
  channel: { type: DataTypes.STRING, allowNull: false, defaultValue: 'ALL' },
  templateStyle: { type: DataTypes.STRING, allowNull: false, defaultValue: 'Classic' },
  showPricing: { type: DataTypes.BOOLEAN, defaultValue: false },
  groupByBundle: { type: DataTypes.BOOLEAN, defaultValue: false },
  groupByBundleShowTopLevelOnly: { type: DataTypes.BOOLEAN, defaultValue: false },
  topImageUrl: { type: DataTypes.TEXT, allowNull: true },
  promoImageUrl: { type: DataTypes.TEXT, allowNull: true },
  returnAddress: { type: DataTypes.TEXT, allowNull: true },
  infoTitle: { type: DataTypes.STRING, allowNull: true },
  info: { type: DataTypes.TEXT, allowNull: true },
  pickingTableSortOrder: { type: DataTypes.STRING, allowNull: false, defaultValue: 'DEFAULT' },
  highlightQuantities: { type: DataTypes.BOOLEAN, defaultValue: false },
  showFooterImage: { type: DataTypes.BOOLEAN, defaultValue: true },
  showFooterMessage: { type: DataTypes.BOOLEAN, defaultValue: true }
}, {
  tableName: 'despatch_note_templates',
  timestamps: true,
  underscored: true,
});

module.exports = DespatchNoteTemplate;
