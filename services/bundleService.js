const { Bundle, BundleItem, Product } = require('../models');
const { Op } = require('sequelize');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  else if (query.companyId) where.companyId = query.companyId;
  if (query.search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.search}%` } },
      { sku: { [Op.like]: `%${query.search}%` } },
    ];
  }
  const bundles = await Bundle.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [{
      association: 'BundleItems',
      include: [{ association: 'Product', attributes: ['id', 'name', 'sku'] }],
    }],
  });
  return bundles.map(b => {
    const j = b.toJSON();
    if (j.BundleItems) {
      j.bundleItems = j.BundleItems.map(it => ({
        id: it.id,
        productId: it.productId,
        quantity: it.quantity,
        child: it.Product,
      }));
      delete j.BundleItems;
    }
    return j;
  });
}

async function getById(id, reqUser) {
  const bundle = await Bundle.findByPk(id, {
    include: [{
      association: 'BundleItems',
      include: [{ association: 'Product', attributes: ['id', 'name', 'sku'] }],
    }],
  });
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  const j = bundle.toJSON();
  if (j.BundleItems) {
    j.bundleItems = j.BundleItems.map(it => ({ id: it.id, productId: it.productId, quantity: it.quantity, child: it.Product }));
    delete j.BundleItems;
  }
  return j;
}

async function create(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId required');
  const existing = await Bundle.findOne({ where: { companyId, sku: (data.sku || '').trim() } });
  if (existing) throw new Error('Bundle SKU already exists for this company');
  const bundle = await Bundle.create({
    companyId,
    sku: (data.sku || '').trim(),
    name: data.name,
    description: data.description || null,
    costPrice: data.costPrice ?? 0,
    sellingPrice: data.sellingPrice ?? 0,
    status: data.status || 'ACTIVE',
  });
  const items = Array.isArray(data.bundleItems) ? data.bundleItems.filter(i => i.productId && i.quantity > 0) : [];
  for (const it of items) {
    await BundleItem.create({ bundleId: bundle.id, productId: it.productId, quantity: it.quantity });
  }
  return getById(bundle.id, reqUser);
}

async function update(id, data, reqUser) {
  const bundle = await Bundle.findByPk(id);
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  await bundle.update({
    name: data.name ?? bundle.name,
    sku: data.sku !== undefined ? data.sku.trim() : bundle.sku,
    description: data.description !== undefined ? data.description : bundle.description,
    costPrice: data.costPrice !== undefined ? data.costPrice : bundle.costPrice,
    sellingPrice: data.sellingPrice !== undefined ? data.sellingPrice : bundle.sellingPrice,
    status: data.status ?? bundle.status,
  });
  if (Array.isArray(data.bundleItems)) {
    await BundleItem.destroy({ where: { bundleId: bundle.id } });
    for (const it of data.bundleItems.filter(i => i.productId && i.quantity > 0)) {
      await BundleItem.create({ bundleId: bundle.id, productId: it.productId, quantity: it.quantity });
    }
  }
  return getById(bundle.id, reqUser);
}

async function remove(id, reqUser) {
  const bundle = await Bundle.findByPk(id);
  if (!bundle) throw new Error('Bundle not found');
  if (reqUser.role !== 'super_admin' && bundle.companyId !== reqUser.companyId) throw new Error('Bundle not found');
  await BundleItem.destroy({ where: { bundleId: bundle.id } });
  await bundle.destroy();
  return { message: 'Bundle deleted' };
}

async function bulkUpload(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId required');

  const rawBundles = Array.isArray(data.bundles) ? data.bundles : [];
  if (rawBundles.length === 0) throw new Error('No bundles data provided for bulk upload');

  const companyProducts = await Product.findAll({
    where: { companyId },
    attributes: ['id', 'sku', 'name', 'costPrice', 'price'],
  });

  const skuToProductMap = new Map();
  companyProducts.forEach(p => {
    if (p.sku) {
      skuToProductMap.set(p.sku.trim().toLowerCase(), p);
    }
  });

  const results = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (let idx = 0; idx < rawBundles.length; idx++) {
    const row = rawBundles[idx];
    const rowNum = idx + 1;
    const sku = (row.sku || '').trim();
    const name = (row.name || '').trim();

    if (!sku || !name) {
      results.skipped++;
      results.errors.push({ row: rowNum, message: 'Missing SKU or Name' });
      continue;
    }

    const resolvedItems = [];
    const itemsInput = Array.isArray(row.bundleItems) ? row.bundleItems : [];

    for (const item of itemsInput) {
      const q = Number(item.quantity) || 0;
      if (q <= 0) continue;

      let pId = item.productId;
      if (!pId && item.productSku) {
        const prod = skuToProductMap.get(String(item.productSku).trim().toLowerCase());
        if (prod) {
          pId = prod.id;
        }
      }

      if (pId) {
        resolvedItems.push({ productId: pId, quantity: q });
      } else if (item.productSku) {
        results.errors.push({
          row: rowNum,
          message: `Product SKU "${item.productSku}" not found in company inventory.`,
        });
      }
    }

    let costPrice = row.costPrice != null && row.costPrice !== '' ? Number(row.costPrice) : 0;
    if ((costPrice === 0 || isNaN(costPrice)) && resolvedItems.length > 0) {
      let calcCost = 0;
      for (const it of resolvedItems) {
        const p = companyProducts.find(pr => pr.id === it.productId);
        if (p && p.costPrice != null) {
          calcCost += Number(p.costPrice) * it.quantity;
        }
      }
      if (calcCost > 0) costPrice = Math.round(calcCost * 100) / 100;
    }

    const sellingPrice = Number(row.sellingPrice) || 0;
    const status = (row.status || 'ACTIVE').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const description = row.description || null;

    try {
      const existing = await Bundle.findOne({ where: { companyId, sku } });
      if (existing) {
        await existing.update({
          name,
          description,
          costPrice,
          sellingPrice,
          status,
        });

        await BundleItem.destroy({ where: { bundleId: existing.id } });
        for (const it of resolvedItems) {
          await BundleItem.create({
            bundleId: existing.id,
            productId: it.productId,
            quantity: it.quantity,
          });
        }
        results.updated++;
      } else {
        const newBundle = await Bundle.create({
          companyId,
          sku,
          name,
          description,
          costPrice,
          sellingPrice,
          status,
        });

        for (const it of resolvedItems) {
          await BundleItem.create({
            bundleId: newBundle.id,
            productId: it.productId,
            quantity: it.quantity,
          });
        }
        results.created++;
      }
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: rowNum, message: err.message || 'Failed to save bundle' });
    }
  }

  return results;
}

module.exports = { list, getById, create, update, remove, bulkUpload };

