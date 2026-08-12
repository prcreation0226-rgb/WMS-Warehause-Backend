const { CustomizationMapping } = require('../models');
const csvParser = require('csv-parser');
const { Readable } = require('stream');

async function list(req, res, next) {
  try {
    const { search, page = 1, pageSize = 50 } = req.query;
    const limit = parseInt(pageSize);
    const offset = (parseInt(page) - 1) * limit;

    const where = {};
    if (req.user && req.user.companyId && req.user.role !== 'super_admin') {
      where.companyId = req.user.companyId;
    }

    const { count, rows } = await CustomizationMapping.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset
    });

    res.json({
      success: true,
      data: {
        items: rows,
        total: count,
        page: parseInt(page),
        pageSize: limit
      }
    });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const companyId = req.user?.companyId || 1;
    const { originalSku, asin, optionValue, processedSku, outOfStock, extra, costPrice } = req.body;

    if (!asin || !optionValue || !processedSku) {
      return res.status(400).json({ success: false, message: 'ASIN, optionValue, and processedSku are required' });
    }

    const item = await CustomizationMapping.create({
      companyId,
      originalSku: originalSku || null,
      asin: asin.trim(),
      optionValue: optionValue.trim(),
      processedSku: processedSku.trim(),
      outOfStock: Boolean(outOfStock),
      extra: extra || null,
      costPrice: costPrice ? parseFloat(costPrice) : null
    });

    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const item = await CustomizationMapping.findByPk(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Mapping not found' });

    const { originalSku, asin, optionValue, processedSku, outOfStock, extra, costPrice } = req.body;
    await item.update({
      originalSku: originalSku !== undefined ? originalSku : item.originalSku,
      asin: asin !== undefined ? asin.trim() : item.asin,
      optionValue: optionValue !== undefined ? optionValue.trim() : item.optionValue,
      processedSku: processedSku !== undefined ? processedSku.trim() : item.processedSku,
      outOfStock: outOfStock !== undefined ? Boolean(outOfStock) : item.outOfStock,
      extra: extra !== undefined ? extra : item.extra,
      costPrice: costPrice !== undefined ? (costPrice ? parseFloat(costPrice) : null) : item.costPrice
    });

    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const item = await CustomizationMapping.findByPk(req.params.id);
    if (!item) return res.status(404).json({ success: false, message: 'Mapping not found' });

    await item.destroy();
    res.json({ success: true, message: 'Mapping deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function uploadCsv(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'CSV file required' });
    }

    const companyId = req.user?.companyId || 1;
    const results = [];
    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    bufferStream
      .pipe(csvParser())
      .on('data', (row) => {
        // Headers matching data.csv: sku, ASIN, optionValue, SKU (processedSku), OUT of Stock, Extra, cost price
        const originalSku = row.sku || row.OriginalSku || row.originalSku || '';
        const asin = row.ASIN || row.asin || '';
        const optionValue = row.optionValue || row.OptionValue || '';
        const processedSku = row.SKU || row.processedSku || row.ProcessedSku || '';
        const outOfStockStr = String(row['OUT of Stock'] || row.outOfStock || '').trim().toUpperCase();
        const extra = row.Extra || row.extra || '';
        const costPriceStr = row['cost price'] || row.costPrice || '';

        if (asin && optionValue && processedSku) {
          results.push({
            companyId,
            originalSku: originalSku.trim() || null,
            asin: asin.trim(),
            optionValue: optionValue.trim(),
            processedSku: processedSku.trim(),
            outOfStock: outOfStockStr === 'TRUE' || outOfStockStr === '1',
            extra: extra.trim() || null,
            costPrice: costPriceStr ? parseFloat(costPriceStr) : null
          });
        }
      })
      .on('end', async () => {
        let inserted = 0;
        for (const record of results) {
          await CustomizationMapping.upsert(record);
          inserted++;
        }
        res.json({ success: true, message: `Successfully processed ${inserted} mapping records.` });
      });
  } catch (err) {
    next(err);
  }
}

async function exportCsv(req, res, next) {
  try {
    const where = {};
    if (req.user && req.user.companyId && req.user.role !== 'super_admin') {
      where.companyId = req.user.companyId;
    }

    const items = await CustomizationMapping.findAll({ where, order: [['id', 'ASC']] });

    let csvContent = 'sku,ASIN,optionValue,SKU,OUT of Stock,Extra,cost price\n';
    for (const item of items) {
      const row = [
        `"${item.originalSku || ''}"`,
        `"${item.asin || ''}"`,
        `"${item.optionValue || ''}"`,
        `"${item.processedSku || ''}"`,
        item.outOfStock ? 'TRUE' : 'FALSE',
        `"${item.extra || ''}"`,
        item.costPrice || ''
      ].join(',');
      csvContent += row + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customization_data.csv');
    res.status(200).send(csvContent);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  create,
  update,
  remove,
  uploadCsv,
  exportCsv
};
