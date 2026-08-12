const axios = require('axios');
const zlib = require('zlib');
const { CustomizationMapping, SalesOrder, OrderItem, Product } = require('../models');

/**
 * Extract files from a ZIP buffer natively in Node.js using built-in zlib
 */
function extractZipFiles(buffer) {
  const files = {};
  let offset = 0;

  while (offset < buffer.length - 30) {
    // Local File Header Signature: 0x04034b50 ("PK\x03\x04")
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const fileNameOffset = offset + 30;
    const fileName = buffer.toString('utf8', fileNameOffset, fileNameOffset + fileNameLen);
    const dataOffset = fileNameOffset + fileNameLen + extraLen;

    const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
    let fileBuffer;

    if (compressionMethod === 0) {
      // Stored (uncompressed)
      fileBuffer = compressedData;
    } else if (compressionMethod === 8) {
      // Deflate
      try {
        fileBuffer = zlib.inflateRawSync(compressedData);
      } catch (err) {
        console.error(`Decompression error for file ${fileName}:`, err.message);
        fileBuffer = null;
      }
    }

    if (fileBuffer) {
      files[fileName] = fileBuffer;
    }

    offset = dataOffset + compressedSize;
  }

  return files;
}

/**
 * Download and parse Amazon Customization ZIP URL
 */
async function parseAmazonCustomizationZip(customizedUrl) {
  if (!customizedUrl || typeof customizedUrl !== 'string') return [];

  const matchedSkus = [];
  try {
    const response = await axios.get(customizedUrl.trim(), {
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const zipBuffer = Buffer.from(response.data);
    const extractedFiles = extractZipFiles(zipBuffer);

    for (const [fileName, fileBuffer] of Object.entries(extractedFiles)) {
      // Skip media/image/html files
      if (fileName.endsWith('.jpg') || fileName.endsWith('.png') || fileName.endsWith('.svg') || fileName.endsWith('.html')) {
        continue;
      }

      let data;
      try {
        data = JSON.parse(fileBuffer.toString('utf8'));
      } catch (e) {
        continue;
      }

      const asin = data.asin || data.ASIN || '';
      const customizationInfo = data.customizationInfo || {};
      const version = customizationInfo['version3.0'] || customizationInfo['version2.0'] || {};
      const surfaces = version.surfaces || [];

      const optionValues = [];
      for (const surface of surfaces) {
        const areas = surface.areas || [];
        for (const area of areas) {
          if (area.customizationType === 'Options' || area.optionValue) {
            const optVal = area.optionValue || area.optionName;
            if (optVal) {
              optionValues.append ? optionValues.append(optVal) : optionValues.push(optVal);
            }
          }
        }
      }

      // Match ASIN + optionValue in DB CustomizationMapping table
      for (const optionValue of optionValues) {
        if (!optionValue || optionValue === 'DISP_No_thx') continue;

        let mapping = await CustomizationMapping.findOne({
          where: {
            asin,
            optionValue
          }
        });

        // Auto-create mapping entry if not exists so it appears in Custom Data page without manual typing!
        if (!mapping) {
          try {
            mapping = await CustomizationMapping.create({
              companyId: 1,
              asin,
              optionValue,
              processedSku: 'PENDING_SKU',
              outOfStock: false,
              extra: 'Auto-captured from Amazon Order'
            });
            console.log(`[Auto-Capture Customization] Captured new ASIN: ${asin} | Option: ${optionValue}`);
          } catch (e) {
            // Ignore duplicate insert error
          }
        }

        if (mapping && mapping.processedSku && mapping.processedSku !== 'PENDING_SKU') {
          const sku = mapping.processedSku.trim();
          if (sku !== 'DISP_No_thx') {
            matchedSkus.push({
              asin,
              optionValue,
              processedSku: sku,
              outOfStock: mapping.outOfStock,
              costPrice: mapping.costPrice
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('Error fetching/parsing Amazon Customization ZIP:', err.message);
  }

  return matchedSkus;
}

/**
 * Process Amazon Order Customizations for a SalesOrder
 */
async function processOrderCustomizations(salesOrderId) {
  const order = await SalesOrder.findByPk(salesOrderId, {
    include: [{ association: 'OrderItems', include: ['Product'] }]
  });

  if (!order || !order.OrderItems) return;

  for (const item of order.OrderItems) {
    // Detect customized URL from order item customizedUrl, notes, or product description
    const customUrl = item.customizedUrl || (order.notes && order.notes.includes('CustomizedURL:') ? order.notes.split('CustomizedURL:')[1]?.trim()?.split(/\s+/)[0] : null);

    if (customUrl) {
      const matches = await parseAmazonCustomizationZip(customUrl);
      if (matches && matches.length > 0) {
        const firstMatch = matches[0];
        const newSku = firstMatch.processedSku;

        // Find or associate matching product in WMS by processedSku
        let targetProduct = await Product.findOne({ where: { sku: newSku, companyId: order.companyId } });
        if (!targetProduct) {
          // Fallback search across company
          targetProduct = await Product.findOne({ where: { sku: newSku } });
        }

        // Store originalSku and update processed SKU
        const originalSku = item.originalSku || (item.Product ? item.Product.sku : item.sku) || 'N/A';
        await item.update({
          originalSku,
          customizedUrl: customUrl,
          productId: targetProduct ? targetProduct.id : item.productId,
          batchNumber: firstMatch.optionValue || item.batchNumber
        });
      }
    }
  }
}

module.exports = {
  extractZipFiles,
  parseAmazonCustomizationZip,
  processOrderCustomizations
};
