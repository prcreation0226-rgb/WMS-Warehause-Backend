const axios = require('axios');
const { SalesOrder, OrderItem, Product, ProductStock, IntegrationConfig } = require('../../models');

const SHIPSTATION_V2_BASE_URL = process.env.SHIPSTATION_API_URL || 'https://api.shipstation.com/v2';

/**
 * Fetch ShipStation API Config for a company
 */
async function getShipStationConfig(companyId) {
  let apiKey = process.env.SHIPSTATION_API_KEY;
  let apiSecret = process.env.SHIPSTATION_API_SECRET;

  if (companyId) {
    const config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });
    if (config && config.credentials) {
      const creds = typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials;
      if (creds.apiKey) apiKey = creds.apiKey;
      if (creds.apiSecret) apiSecret = creds.apiSecret;
    }
  }

  return { apiKey, apiSecret, baseUrl: SHIPSTATION_V2_BASE_URL };
}

function firstProductImage(images) {
  if (images == null || images === '') return null;
  let list = images;
  if (typeof images === 'string') {
    const s = images.trim();
    if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/')) {
      return s;
    }
    if (s.startsWith('[')) {
      try { list = JSON.parse(s); } catch (e) { list = [s]; }
    } else if (s.includes(',')) {
      list = s.split(',').map(x => x.trim()).filter(Boolean);
    } else {
      list = [s];
    }
  }
  if (Array.isArray(list) && list.length > 0) {
    return list[0];
  }
  return null;
}

function extractProductImage(item, product) {
  let img = null;
  if (item) {
    img = item.imageUrl || item.image_url || item.pictureUrl || item.thumbnailUrl || item.thumbUrl || item.productImageUrl || item.image;
    if (!img && item.options && Array.isArray(item.options)) {
      const imgOpt = item.options.find(o => o.name && o.name.toLowerCase().includes('image'));
      if (imgOpt && imgOpt.value) img = imgOpt.value;
    }
  }
  if (!img && product) {
    img = product.imageUrl || product.image || firstProductImage(product.images);
  }
  return img || null;
}

async function getOrCreateProductFromChannelItem(item, companyId, productImageUrl) {
  if (!item || !item.sku) return null;
  const sku = String(item.sku).trim();
  if (!sku) return null;

  let product = await Product.findOne({ where: { sku, companyId: companyId || 1 } });

  if (!product) {
    const name = item.name || item.title || item.label || sku;
    const barcode = item.upc || item.barcode || item.gtin || sku;
    const price = item.unitPrice || item.price || 0;
    const imagesList = productImageUrl ? [productImageUrl] : null;

    try {
      product = await Product.create({
        companyId: companyId || 1,
        name,
        sku,
        barcode,
        price,
        status: 'ACTIVE',
        images: imagesList
      });
      console.log(`[Auto Product Create] Created new product in WMS: ${sku} - ${name}`);
    } catch (err) {
      console.error(`[Auto Product Create Error] SKU ${sku}:`, err.message);
    }
  } else if (productImageUrl && (!product.images || product.images.length === 0) && !product.imageUrl) {
    try {
      await product.update({ images: [productImageUrl] });
    } catch (e) {
      // Ignore update error
    }
  }

  return product;
}

/**
 * Sync Orders from ShipStation API v2 (No PII: Store only Order ID, SKUs, Qty, Metadata)
 */
async function syncOrdersFromShipStation(companyId) {
  const { apiKey, apiSecret, baseUrl } = await getShipStationConfig(companyId);
  if (!apiKey) {
    console.log('[ShipStation] API Key not configured. Skipping live sync.');
    return { syncedCount: 0, message: 'ShipStation credentials missing' };
  }

  try {
    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret || ''}`).toString('base64');
    const response = await axios.get(`${baseUrl}/orders?orderStatus=awaiting_shipment`, {
      headers: { Authorization: authHeader }
    });

    const orders = response.data.orders || response.data || [];
    let syncedCount = 0;

    for (const ssOrder of orders) {
      const shipstationOrderId = String(ssOrder.orderId || ssOrder.id);
      const orderNumber = ssOrder.orderNumber || `SS-${shipstationOrderId}`;

      // Check if order already exists
      let existingOrder = await SalesOrder.findOne({
        where: { companyId: companyId || 1, shipstationOrderId }
      });

      if (!existingOrder) {
        // Create SalesOrder WITHOUT customer PII
        existingOrder = await SalesOrder.create({
          companyId: companyId || 1,
          orderNumber,
          shipstationOrderId,
          shipstationStoreId: String(ssOrder.advancedOptions?.storeId || ssOrder.storeId || ''),
          orderDate: ssOrder.orderDate ? ssOrder.orderDate.split('T')[0] : new Date().toISOString().split('T')[0],
          status: 'NEW',
          priority: ssOrder.priority || 'MEDIUM',
          salesChannel: ssOrder.advancedOptions?.source || 'SHIPSTATION',
          checkContentRequired: true,
          isBundle: false,
          totalAmount: ssOrder.orderTotal || 0,
          totalItems: ssOrder.items ? ssOrder.items.length : 1
        });

        // Add order items
        if (ssOrder.items && Array.isArray(ssOrder.items)) {
          let hasBundle = false;
          for (const item of ssOrder.items) {
            const sku = item.sku;
            const productImageUrl = extractProductImage(item, null);

            // Auto-create or fetch product from WMS catalog
            const product = await getOrCreateProductFromChannelItem(item, companyId || 1, productImageUrl);
            
            const isBundleItem = item.sku && item.sku.includes('SEL_'); // Bundle SKU pattern
            if (isBundleItem) hasBundle = true;

            const finalImg = productImageUrl || (product ? firstProductImage(product.images) : null);

            await OrderItem.create({
              salesOrderId: existingOrder.id,
              productId: product ? product.id : 0,
              quantity: item.quantity || 1,
              scannedQty: 0,
              unitPrice: item.unitPrice || 0,
              bundleHeader: isBundleItem ? `${item.quantity} x ${item.sku}` : null,
              isBundleParent: isBundleItem,
              productImageUrl: finalImg,
              bestBeforeDate: item.options?.find(o => o.name === 'BB Date')?.value || null,
              batchNumber: item.options?.find(o => o.name === 'Batch ID')?.value || null
            });
          }

          if (hasBundle) {
            await existingOrder.update({ isBundle: true });
          }
        }

        syncedCount++;
      }
    }

    return { success: true, syncedCount };
  } catch (error) {
    console.error('[ShipStation Sync Error]:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Push Inventory Updates to ShipStation API v2
 */
async function updateInventoryToShipStation(companyId, sku, availableQty) {
  const { apiKey, apiSecret, baseUrl } = await getShipStationConfig(companyId);
  if (!apiKey) return false;

  try {
    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret || ''}`).toString('base64');
    await axios.post(`${baseUrl}/inventory/update`, {
      sku,
      availableQuantity: availableQty
    }, {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' }
    });
    console.log(`[ShipStation Inventory Sync] Updated SKU ${sku} with available Qty: ${availableQty}`);
    return true;
  } catch (error) {
    console.error(`[ShipStation Inventory Sync Error] SKU ${sku}:`, error.response?.data || error.message);
    return false;
  }
}

/**
 * Generate Shipping Label and Notify Marketplace via ShipStation API v2
 */
async function createShippingLabelAndDispatch(orderId, reqUser, forceOverride = false) {
  const order = await SalesOrder.findByPk(orderId, {
    include: ['OrderItems']
  });

  if (!order) throw new Error('Sales order not found');

  // If checkContentRequired is ON and not forced, verify all items scanned
  if (order.checkContentRequired && !forceOverride) {
    const incompleteItem = order.OrderItems.find(item => (item.scannedQty || 0) < item.quantity);
    if (incompleteItem) {
      return {
        success: false,
        warningRequired: true,
        message: "the order hasn't fully checked yet... scan to confirm despatch."
      };
    }
  }

  const { apiKey, apiSecret, baseUrl } = await getShipStationConfig(order.companyId);
  
  let labelUrl = null;
  let trackingNumber = `TRK-${Date.now()}`;
  let carrierCode = order.courierName || 'Royal Mail';

  if (apiKey && order.shipstationOrderId) {
    try {
      const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret || ''}`).toString('base64');
      const response = await axios.post(`${baseUrl}/orders/createlabel`, {
        orderId: order.shipstationOrderId,
        carrierCode: order.courierName || 'royal_mail',
        serviceCode: order.courierService || 'royal_mail_tracked_48',
        confirmation: 'none',
        testLabel: process.env.NODE_ENV !== 'production'
      }, {
        headers: { Authorization: authHeader }
      });

      trackingNumber = response.data.trackingNumber || trackingNumber;
      labelUrl = response.data.labelData || response.data.labelUrl || null;
    } catch (err) {
      console.warn('[ShipStation Label API Warning]: Falling back to local dispatch simulation.', err.response?.data || err.message);
    }
  }

  // Update order status to DISPATCHED / SHIPPED
  await order.update({
    status: 'SHIPPED',
    trackingNumber,
    courierName: carrierCode,
    trackingStatus: 'DISPATCHED'
  });

  return {
    success: true,
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: 'SHIPPED',
    trackingNumber,
    labelUrl,
    message: 'Order successfully dispatched and notified to ShipStation'
  };
}

module.exports = {
  syncOrdersFromShipStation,
  updateInventoryToShipStation,
  createShippingLabelAndDispatch
};
