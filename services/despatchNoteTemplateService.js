const { DespatchNoteTemplate, Customer } = require('../models');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') {
    where.companyId = reqUser.companyId;
  } else if (query.companyId) {
    where.companyId = query.companyId;
  }

  if (query.customerId) {
    where.customerId = query.customerId;
  }

  const templates = await DespatchNoteTemplate.findAll({
    where,
    order: [['channel', 'ASC']],
    include: [
      { association: 'Client', attributes: ['id', 'name', 'code'] }
    ]
  });
  return templates;
}

async function getById(id, reqUser) {
  const template = await DespatchNoteTemplate.findByPk(id, {
    include: [
      { association: 'Client', attributes: ['id', 'name', 'code'] }
    ]
  });
  if (!template) throw new Error('Template not found');
  if (reqUser.role !== 'super_admin' && template.companyId !== reqUser.companyId) {
    throw new Error('Template not found');
  }
  return template;
}

async function create(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId is required');
  if (!data.customerId) throw new Error('Client (customerId) is required');

  // Verify client belongs to same company
  const client = await Customer.findByPk(data.customerId);
  if (!client || (reqUser.role !== 'super_admin' && client.companyId !== reqUser.companyId)) {
    throw new Error('Invalid Client');
  }

  // Prevent duplicate templates for same client and channel combo
  const existing = await DespatchNoteTemplate.findOne({
    where: {
      companyId,
      customerId: data.customerId,
      channel: data.channel || 'ALL'
    }
  });
  if (existing) {
    throw new Error(`A template configuration for this Client and Channel (${data.channel || 'ALL'}) already exists.`);
  }

  return DespatchNoteTemplate.create({
    companyId,
    customerId: data.customerId,
    channel: data.channel || 'ALL',
    templateStyle: data.templateStyle || 'Classic',
    showPricing: !!data.showPricing,
    groupByBundle: !!data.groupByBundle,
    groupByBundleShowTopLevelOnly: !!data.groupByBundleShowTopLevelOnly,
    topImageUrl: data.topImageUrl || null,
    promoImageUrl: data.promoImageUrl || null,
    returnAddress: data.returnAddress || null,
    infoTitle: data.infoTitle || null,
    info: data.info || null,
    pickingTableSortOrder: data.pickingTableSortOrder || 'DEFAULT',
    highlightQuantities: !!data.highlightQuantities,
    showFooterImage: data.showFooterImage !== undefined ? !!data.showFooterImage : true,
    showFooterMessage: data.showFooterMessage !== undefined ? !!data.showFooterMessage : true
  });
}

async function update(id, data, reqUser) {
  const template = await DespatchNoteTemplate.findByPk(id);
  if (!template) throw new Error('Template not found');
  if (reqUser.role !== 'super_admin' && template.companyId !== reqUser.companyId) {
    throw new Error('Template not found');
  }

  // Check client switch validation
  if (data.customerId && data.customerId !== template.customerId) {
    const client = await Customer.findByPk(data.customerId);
    if (!client || (reqUser.role !== 'super_admin' && client.companyId !== reqUser.companyId)) {
      throw new Error('Invalid Client');
    }
  }

  const cid = data.customerId !== undefined ? data.customerId : template.customerId;
  const chan = data.channel !== undefined ? data.channel : template.channel;

  // Prevent duplicate templates for same client and channel combo if either changed
  if (cid !== template.customerId || chan !== template.channel) {
    const existing = await DespatchNoteTemplate.findOne({
      where: {
        companyId: template.companyId,
        customerId: cid,
        channel: chan,
        id: { [Op.ne]: id }
      }
    });
    if (existing) {
      throw new Error(`A template configuration for this Client and Channel (${chan}) already exists.`);
    }
  }

  const updates = {
    customerId: cid,
    channel: chan,
    templateStyle: data.templateStyle !== undefined ? data.templateStyle : template.templateStyle,
    showPricing: data.showPricing !== undefined ? !!data.showPricing : template.showPricing,
    groupByBundle: data.groupByBundle !== undefined ? !!data.groupByBundle : template.groupByBundle,
    groupByBundleShowTopLevelOnly: data.groupByBundleShowTopLevelOnly !== undefined ? !!data.groupByBundleShowTopLevelOnly : template.groupByBundleShowTopLevelOnly,
    topImageUrl: data.topImageUrl !== undefined ? data.topImageUrl : template.topImageUrl,
    promoImageUrl: data.promoImageUrl !== undefined ? data.promoImageUrl : template.promoImageUrl,
    returnAddress: data.returnAddress !== undefined ? data.returnAddress : template.returnAddress,
    infoTitle: data.infoTitle !== undefined ? data.infoTitle : template.infoTitle,
    info: data.info !== undefined ? data.info : template.info,
    pickingTableSortOrder: data.pickingTableSortOrder !== undefined ? data.pickingTableSortOrder : template.pickingTableSortOrder,
    highlightQuantities: data.highlightQuantities !== undefined ? !!data.highlightQuantities : template.highlightQuantities,
    showFooterImage: data.showFooterImage !== undefined ? !!data.showFooterImage : template.showFooterImage,
    showFooterMessage: data.showFooterMessage !== undefined ? !!data.showFooterMessage : template.showFooterMessage
  };

  await template.update(updates);
  return getById(id, reqUser);
}

async function remove(id, reqUser) {
  const template = await DespatchNoteTemplate.findByPk(id);
  if (!template) throw new Error('Template not found');
  if (reqUser.role !== 'super_admin' && template.companyId !== reqUser.companyId) {
    throw new Error('Template not found');
  }
  await template.destroy();
  return { success: true, message: 'Template deleted' };
}

module.exports = { list, getById, create, update, remove };
