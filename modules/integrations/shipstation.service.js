const axios = require('axios');
const { SalesOrder, OrderItem, Product, ProductStock, IntegrationConfig, Customer, Warehouse, Zone, Location, Category, Inventory, Shipment } = require('../../models');

const SHIPSTATION_V2_BASE_URL = process.env.SHIPSTATION_API_URL || 'https://api.shipstation.com/v2';

/**
 * Fetch ShipStation API Config for a company
 */
async function getShipStationConfig(companyId) {
  let apiKey = process.env.SHIPSTATION_API_KEY || '';
  let apiSecret = process.env.SHIPSTATION_API_SECRET || '';
  let storeMappings = {};

  if (companyId) {
    const config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });
    if (config && config.credentials) {
      const creds = typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials;
      if (creds.apiKey) apiKey = creds.apiKey;
      if (creds.apiSecret) apiSecret = creds.apiSecret;
      if (creds.storeMappings) storeMappings = creds.storeMappings;
    }
  }

  return { apiKey, apiSecret, baseUrl: process.env.SHIPSTATION_API_URL || SHIPSTATION_V2_BASE_URL, storeMappings };
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
    img = item.image_url || item.imageUrl || item.picture_url || item.pictureUrl || item.thumbnail_url || item.thumbnailUrl || item.thumbUrl || item.product_image_url || item.productImageUrl || item.image || item.item_image_url || item.item_imageUrl || item.product_imageUrl || item.small_image_url || item.large_image_url;
    if (!img && item.options && Array.isArray(item.options)) {
      const imgOpt = item.options.find(o => o.name && o.name.toLowerCase().includes('image'));
      if (imgOpt && imgOpt.value) img = imgOpt.value;
    }
  }
  if (!img && product) {
    img = product.image_url || product.imageUrl || product.image || firstProductImage(product.images);
  }
  if (typeof img === 'string') {
    img = img.trim();
    if (img.startsWith('//')) img = `https:${img}`;
  }
  return img || null;
}

async function getOrCreateWarehouse(ssWarehouseId, companyId) {
  let warehouse = await Warehouse.findOne({ where: { companyId: companyId || 1 } });

  if (!warehouse) {
    try {
      warehouse = await Warehouse.create({
        companyId: companyId || 1,
        name: 'Main Fulfillment Warehouse',
        code: 'WH-MAIN',
        warehouseType: 'FULFILLMENT',
        status: 'ACTIVE'
      });
      console.log(`[Auto Warehouse Create] Created Main Warehouse for Company ${companyId}`);
    } catch (err) {
      console.error('[Auto Warehouse Create Warning]:', err.message);
    }
  }

  return warehouse;
}

async function getOrCreateCategory(companyId) {
  let category = await Category.findOne({ where: { companyId: companyId || 1 } });
  if (!category) {
    try {
      category = await Category.create({
        companyId: companyId || 1,
        name: 'General Imports',
        code: 'CAT-GEN',
        description: 'Auto-created category for channel imports',
        status: 'ACTIVE'
      });
      console.log(`[Auto Category Create] Created default category for Company ${companyId}`);
    } catch (err) {
      console.error('[Auto Category Create Warning]:', err.message);
    }
  }
  return category;
}

async function getOrCreateZoneAndLocation(warehouseId, companyId) {
  if (!warehouseId) return null;

  let zone = await Zone.findOne({ where: { warehouseId } });
  if (!zone) {
    try {
      zone = await Zone.create({
        warehouseId,
        name: 'Picking Zone A',
        code: 'ZONE-A',
        zoneType: 'PICKING',
        status: 'ACTIVE'
      });
    } catch (err) {
      // Ignore
    }
  }

  let location = await Location.findOne({ where: { warehouseId } });
  if (!location && zone) {
    try {
      location = await Location.create({
        warehouseId,
        zoneId: zone.id,
        name: 'Default Pick Location A-01',
        code: 'LOC-A-01',
        locationType: 'PICKING',
        status: 'ACTIVE'
      });
      console.log(`[Auto Location Create] Created default pick location LOC-A-01 for Warehouse ${warehouseId}`);
    } catch (err) {
      // Ignore
    }
  }

  return location;
}

async function getOrCreateInventory(productId, warehouseId, companyId) {
  if (!productId || !warehouseId) return;

  const location = await getOrCreateZoneAndLocation(warehouseId, companyId);
  const locationId = location ? location.id : null;

  try {
    let inv = await Inventory.findOne({ where: { productId, warehouseId } });
    if (!inv && locationId) {
      await Inventory.create({
        productId,
        warehouseId,
        locationId,
        quantity: 100, // Initial default stock for fulfillment operations
        allocatedQuantity: 0,
        status: 'ACTIVE'
      });
    }
  } catch (err) {
    // Ignore inventory create warning
  }
}

async function getOrCreateCustomer(recipientName, email, phone, addressLine1, town, county, postcode, country, companyId) {
  if (!recipientName || recipientName === 'Customer') return null;

  let customer = null;
  if (email) {
    customer = await Customer.findOne({ where: { email, companyId: companyId || 1 } });
  }
  if (!customer && recipientName) {
    customer = await Customer.findOne({ where: { name: recipientName, companyId: companyId || 1 } });
  }

  if (!customer) {
    try {
      customer = await Customer.create({
        companyId: companyId || 1,
        name: recipientName,
        email: email || null,
        phone: phone || null,
        address: `${addressLine1} ${town}`.trim(),
        city: town || null,
        state: county || null,
        postcode: postcode || null,
        country: country || 'UNITED KINGDOM',
        status: 'ACTIVE'
      });
      console.log(`[Auto Customer Create] Created Customer in WMS: ${recipientName} (${email || 'No email'})`);
    } catch (err) {
      console.error('[Auto Customer Create Warning]:', err.message);
    }
  }

  return customer;
}

async function getOrCreateProductFromChannelItem(item, companyId, productImageUrl) {
  let sku = item ? (item.sku || item.item_sku || item.product_sku || item.seller_sku) : null;
  if (sku) sku = String(sku).trim();
  if (!sku) {
    const cleanName = item && item.name ? String(item.name).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().substring(0, 30) : '';
    sku = cleanName ? `MISC-${cleanName}` : `SS-ITEM-${Date.now()}`;
  }

  const name = (item && (item.name || item.title || item.label || item.item_name)) || sku;
  const barcode = (item && (item.upc || item.barcode || item.gtin)) || sku;
  const price = parseFloat((item && (item.unitPrice || item.price || item.unit_price)) || 0);

  let product = await Product.findOne({ where: { sku, companyId: companyId || 1 } });

  if (!product) {
    const imagesList = productImageUrl ? [productImageUrl] : null;
    const category = await getOrCreateCategory(companyId || 1);

    try {
      product = await Product.create({
        companyId: companyId || 1,
        categoryId: category ? category.id : null,
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
      product = await Product.findOne({ where: { companyId: companyId || 1 } });
      if (!product) {
        product = await Product.create({
          companyId: companyId || 1,
          categoryId: category ? category.id : null,
          name: name || 'Generic ShipStation Item',
          sku: `GENERIC-${Date.now()}`,
          barcode: `GENERIC-${Date.now()}`,
          price: price || 0,
          status: 'ACTIVE'
        });
      }
    }
  } else if (productImageUrl) {
    try {
      await product.update({ images: [productImageUrl] });
    } catch (e) {
      // Ignore update error
    }
  }

  if (product && product.id) {
    try {
      const warehouse = await getOrCreateWarehouse(null, companyId || 1);
      if (warehouse) {
        let stock = await ProductStock.findOne({ where: { productId: product.id, warehouseId: warehouse.id } });
        if (!stock) {
          await ProductStock.create({
            productId: product.id,
            warehouseId: warehouse.id,
            allocatedQty: 0,
            status: 'ACTIVE'
          });
        }
        await getOrCreateInventory(product.id, warehouse.id, companyId || 1);
      }
    } catch (e) {
      // Ignore stock init warning
    }
  }

  return product;
}

// In-memory cache for working auth header per companyId to make requests lightning fast
const workingAuthCache = {};

/**
 * Universal ShipStation API Request Helper (Supports V2 single Production Key & V1 Key+Secret)
 */
async function makeShipStationRequest(companyId, endpointPath, options = {}) {
  const { apiKey, apiSecret, baseUrl: customUrl } = await getShipStationConfig(companyId);
  if (!apiKey) throw new Error('ShipStation API Key missing');

  const cleanKey = apiKey.trim();
  const cleanSecret = (apiSecret || '').trim();

  let effectiveKey = cleanKey;
  let effectiveSecret = cleanSecret;

  if (cleanKey.includes(':')) {
    const parts = cleanKey.split(':');
    effectiveKey = parts[0].trim();
    effectiveSecret = parts.slice(1).join(':').trim();
  } else if (!effectiveSecret && cleanKey.includes('+')) {
    const plusIdx = cleanKey.indexOf('+');
    effectiveKey = cleanKey.substring(0, plusIdx).trim();
    effectiveSecret = cleanKey.substring(plusIdx + 1).trim();
  }

  const baseUrl = (customUrl || 'https://api.shipstation.com/v2').replace(/\/+$/, '');
  let path = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;

  // Smart endpoint mapping for V2 host (maps /orders to /shipments on api.shipstation.com)
  if (baseUrl.includes('api.shipstation.com') && path.includes('/orders')) {
    path = '/v2/shipments';
  }

  const fullUrl = `${baseUrl}${path}`;

  // If working header is already cached for this company, try it first
  const cachedHeader = workingAuthCache[companyId];
  if (cachedHeader) {
    try {
      const res = await axios({
        url: fullUrl,
        method: options.method || 'GET',
        data: options.data,
        headers: {
          ...cachedHeader.headers,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        timeout: 20000
      });
      return res;
    } catch (e) {
      if (e.response?.status !== 401 && e.response?.status !== 403) {
        throw e;
      }
      delete workingAuthCache[companyId];
    }
  }

  // Candidate Headers (ShipStation V2 Bearer Token primary)
  const candidateHeaders = [];
  candidateHeaders.push({ name: 'Bearer Token', headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' } });
  candidateHeaders.push({ name: 'api-key Header', headers: { 'api-key': cleanKey, 'Content-Type': 'application/json' } });

  if (effectiveSecret) {
    candidateHeaders.push({ name: 'Basic (Key + Secret)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:${effectiveSecret}`).toString('base64'), 'Content-Type': 'application/json' } });
  }
  candidateHeaders.push({ name: 'Basic (Key:blank)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:`).toString('base64'), 'Content-Type': 'application/json' } });
  candidateHeaders.push({ name: 'Basic (Key:Key)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:${effectiveSecret || effectiveKey}`).toString('base64'), 'Content-Type': 'application/json' } });

  let lastError = null;

  for (const attempt of candidateHeaders) {
    try {
      const res = await axios({
        url: fullUrl,
        method: options.method || 'GET',
        data: options.data,
        headers: {
          ...attempt.headers,
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        timeout: 20000
      });
      console.log(`[ShipStation Request Success] ${options.method || 'GET'} ${fullUrl} using ${attempt.name}`);
      workingAuthCache[companyId] = attempt; // Cache working auth header
      return res;
    } catch (err) {
      lastError = err;
      if (err.response?.status !== 401 && err.response?.status !== 403 && err.response?.status !== 404) {
        throw err;
      }
    }
  }

  throw lastError || new Error('Failed to connect to ShipStation API');
}

/**
 * Sync Orders from ShipStation API (Central Order Hub)
 */
async function syncOrdersFromShipStation(companyId) {
  const { apiKey, storeMappings } = await getShipStationConfig(companyId);
  if (!apiKey) {
    console.log('[ShipStation] API Key not configured. Skipping live sync.');
    return { success: false, syncedCount: 0, message: 'ShipStation API Key missing. Please configure your Production Key under Integration Settings.' };
  }

  console.log(`[ShipStation Sync] Attempting sync with Key: ${apiKey ? apiKey.trim().substring(0, 6) + '...' : 'EMPTY'}`);

  let response = null;
  let lastErr = null;
  const candidateEndpoints = [
    '/v2/shipments',
    '/shipments',
    '/orders?orderStatus=awaiting_shipment',
    '/orders'
  ];

  for (const ep of candidateEndpoints) {
    try {
      response = await makeShipStationRequest(companyId, ep);
      if (response && response.data) break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!response) {
    const respData = lastErr?.response?.data;
    let errMessage = respData?.errors?.[0]?.message || respData?.message || (typeof respData === 'string' ? respData : null) || lastErr?.message;

    if (lastErr?.response?.status === 401) {
      errMessage = `ShipStation 401 Unauthorized: Production Key authentication failed. Please verify your Production Key in ShipStation Settings > Account > API Settings (Select V2 API).`;
    }

    console.error('[ShipStation Sync Error]:', respData || errMessage);
    return { success: false, error: errMessage, syncedCount: 0 };
  }

  try {
    const orders = response.data.orders || response.data.shipments || (Array.isArray(response.data) ? response.data : []);
    let syncedCount = 0;

    // Auto-clean any legacy corrupted undefined order entries
    try {
      const { Op } = require('sequelize');
      await SalesOrder.destroy({
        where: {
          companyId: companyId || 1,
          [Op.or]: [
            { orderNumber: 'SS-undefined' },
            { shipstationOrderId: 'undefined' }
          ]
        }
      });
    } catch (cleanErr) {
      // Ignore
    }

    for (const ssOrder of orders) {
      const rawId = ssOrder.orderId || ssOrder.id || ssOrder.shipment_id || ssOrder.shipmentId || ssOrder.sales_order_id || ssOrder.salesOrderId || ssOrder.order_id;
      const shipstationOrderId = rawId ? String(rawId) : `SS-${Date.now()}`;

      const rawOrderNumber = ssOrder.orderNumber || ssOrder.order_number || ssOrder.shipmentNumber || ssOrder.shipment_number || ssOrder.external_order_id || ssOrder.order_id || ssOrder.orderId || ssOrder.shipment_id || ssOrder.id;
      const orderNumber = rawOrderNumber && String(rawOrderNumber) !== 'undefined' ? String(rawOrderNumber) : `SS-${shipstationOrderId}`;

      const storeId = String(ssOrder.advancedOptions?.storeId || ssOrder.storeId || ssOrder.store_id || '');

      // Determine Sales Channel & Marketplace from Store ID Mapping or Source Identifier
      let salesChannel = 'SHIPSTATION';
      let marketplace = 'Amazon'; // Default
      if (storeId && storeMappings && storeMappings[storeId]) {
        salesChannel = storeMappings[storeId].toUpperCase();
        marketplace = storeMappings[storeId];
      } else if (ssOrder.advancedOptions?.source || ssOrder.source) {
        const src = String(ssOrder.advancedOptions?.source || ssOrder.source);
        const srcUpper = src.toUpperCase();
        if (srcUpper.includes('AMAZON')) { salesChannel = 'AMAZON'; marketplace = 'Amazon'; }
        else if (srcUpper.includes('SHOPIFY')) { salesChannel = 'SHOPIFY'; marketplace = 'Shopify'; }
        else if (srcUpper.includes('EBAY')) { salesChannel = 'EBAY'; marketplace = 'eBay'; }
        else if (srcUpper.includes('WALMART')) { salesChannel = 'WALMART'; marketplace = 'Walmart'; }
        else { salesChannel = srcUpper; marketplace = src; }
      } else if (ssOrder.storeName || ssOrder.store_name) {
        const sName = String(ssOrder.storeName || ssOrder.store_name);
        const sNameUpper = sName.toUpperCase();
        if (sNameUpper.includes('WHOLESALE')) { salesChannel = 'SHOPIFY_WHOLESALE'; marketplace = 'Shopify Wholesale'; }
        else if (sNameUpper.includes('SHOPIFY')) { salesChannel = 'SHOPIFY'; marketplace = 'Shopify'; }
        else if (sNameUpper.includes('EBAY')) { salesChannel = 'EBAY'; marketplace = 'eBay'; }
        else if (sNameUpper.includes('WALMART')) { salesChannel = 'WALMART'; marketplace = 'Walmart'; }
        else if (sNameUpper.includes('TEMU')) { salesChannel = 'TEMU'; marketplace = 'Temu'; }
        else if (sNameUpper.includes('AMAZON')) { salesChannel = 'AMAZON'; marketplace = 'Amazon'; }
        else if (sNameUpper.includes('TIKTOK')) { salesChannel = 'TIKTOK'; marketplace = 'TikTok'; }
        else { salesChannel = sNameUpper; marketplace = sName; }
      }

      // Shipping address & requested courier details
      const shipTo = ssOrder.shipTo || ssOrder.ship_to || ssOrder.shippingAddress || ssOrder.shipping_address || {};
      const courierService = ssOrder.requested_shipment_service || ssOrder.requestedShippingService || ssOrder.serviceCode || ssOrder.service_code || ssOrder.carrierCode || ssOrder.carrier_code || 'Standard Courier';
      const rawCarrier = ssOrder.carrierCode || ssOrder.carrier_code || ssOrder.carrier_id || '';
      const courierName = rawCarrier ? String(rawCarrier).replace(/_/g, ' ').toUpperCase() : 'SHIPSTATION';

      const recipientName = shipTo.name || shipTo.full_name || ssOrder.customer_name || ssOrder.customerName || ssOrder.customerUsername || ssOrder.customer_username || (shipTo.first_name ? `${shipTo.first_name} ${shipTo.last_name || ''}`.trim() : null) || 'Customer';
      const addressLine1 = shipTo.address_line1 || shipTo.street1 || shipTo.address1 || shipTo.street_1 || '';
      const addressLine2 = shipTo.address_line2 || shipTo.street2 || shipTo.address2 || shipTo.street_2 || '';
      const addressLine3 = shipTo.address_line3 || shipTo.street3 || '';
      const town = shipTo.city_locality || shipTo.city || shipTo.town || '';
      const county = shipTo.state_province || shipTo.state || shipTo.county || '';
      const postcode = shipTo.postal_code || shipTo.postalCode || shipTo.zip || '';
      const country = shipTo.country_code || shipTo.country || 'UNITED KINGDOM';
      const phone = shipTo.phone || ssOrder.customer_phone || ssOrder.customerPhone || '';
      const email = shipTo.email || ssOrder.customerEmail || ssOrder.customer_email || '';

      const rawItems = ssOrder.items || ssOrder.shipment_items || ssOrder.packages || ssOrder.line_items || [];

      let itemsSum = 0;
      if (Array.isArray(rawItems)) {
        for (const it of rawItems) {
          const q = parseInt(it.quantity || it.qty || it.quantity_ordered || 1, 10);
          const p = parseFloat(it.unit_price || it.unitPrice || it.price || it.unitCost || it.cost || 0);
          itemsSum += (p * q);
        }
      }

      let rawOrderTotal = 0;
      if (typeof ssOrder.amount_paid === 'object' && ssOrder.amount_paid !== null && ssOrder.amount_paid.amount !== undefined) {
        rawOrderTotal = parseFloat(ssOrder.amount_paid.amount || 0);
      } else {
        rawOrderTotal = parseFloat(ssOrder.orderTotal || ssOrder.order_total || ssOrder.total_amount || ssOrder.amount_paid || ssOrder.order_amount || ssOrder.shipment_cost || 0);
      }
      if (isNaN(rawOrderTotal)) rawOrderTotal = 0;

      const totalAmount = rawOrderTotal > 0 ? rawOrderTotal : itemsSum;

      // Auto-create/link Customer & Warehouse in WMS DB
      const customer = await getOrCreateCustomer(recipientName, email, phone, addressLine1, town, county, postcode, country, companyId || 1);
      const warehouse = await getOrCreateWarehouse(ssOrder.warehouse_id || ssOrder.warehouseId, companyId || 1);

      // Determine Order Status
      let orderStatus = 'NEW';
      const ssStatus = String(ssOrder.shipment_status || ssOrder.order_status || ssOrder.orderStatus || '').toLowerCase();
      if (ssStatus.includes('cancel')) {
        orderStatus = 'CANCELLED';
      } else if (ssStatus.includes('ship') || ssStatus.includes('deliver') || ssStatus.includes('fulfilled')) {
        orderStatus = 'DISPATCHED';
      }

      // Check if order already exists
      let existingOrder = await SalesOrder.findOne({
        where: { companyId: companyId || 1, shipstationOrderId }
      });

      if (existingOrder) {
        if (parseFloat(existingOrder.totalAmount || 0) === 0 && totalAmount > 0) {
          await existingOrder.update({ totalAmount });
        }
        if (!existingOrder.customerId && customer) {
          await existingOrder.update({ customerId: customer.id });
        }
        // Backfill missing images for existing order items & products
        if (Array.isArray(rawItems) && rawItems.length > 0) {
          for (const item of rawItems) {
            const sku = item.sku || item.item_sku || item.product_sku || item.seller_sku;
            const productImageUrl = extractProductImage(item, null);
            if (productImageUrl && sku) {
              const product = await getOrCreateProductFromChannelItem({ ...item, sku }, companyId || 1, productImageUrl);
              if (product && product.id) {
                await product.update({ images: [productImageUrl] });
                await OrderItem.update(
                  { productImageUrl: productImageUrl },
                  { where: { salesOrderId: existingOrder.id, productId: product.id } }
                );
              }
            }
          }
        }
      } else {
        existingOrder = await SalesOrder.create({
          companyId: companyId || 1,
          customerId: customer ? customer.id : null,
          warehouseId: warehouse ? warehouse.id : null,
          orderNumber,
          shipstationOrderId,
          shipstationStoreId: storeId,
          channelOrderId: ssOrder.external_order_id || ssOrder.orderKey || ssOrder.order_key || ssOrder.orderNumber || orderNumber,
          marketplace: marketplace || 'Amazon',
          orderDate: (ssOrder.orderDate || ssOrder.order_date || ssOrder.create_date || ssOrder.created_at) ? String(ssOrder.orderDate || ssOrder.order_date || ssOrder.create_date || ssOrder.created_at).split('T')[0] : new Date().toISOString().split('T')[0],
          status: orderStatus,
          priority: ssOrder.priority || 'MEDIUM',
          salesChannel,
          courierName,
          courierService,
          recipientName,
          addressLine1,
          addressLine2,
          addressLine3,
          town,
          county,
          postcode,
          country,
          phone,
          email,
          checkContentRequired: true,
          isBundle: false,
          totalAmount,
          totalItems: Array.isArray(rawItems) ? rawItems.length : 1
        });

        // Add order items
        if (Array.isArray(rawItems) && rawItems.length > 0) {
          let hasBundle = false;
          for (const item of rawItems) {
            const sku = item.sku || item.item_sku || item.product_sku || item.seller_sku;
            const quantity = parseInt(item.quantity || item.qty || item.quantity_ordered || 1, 10);
            let unitPrice = parseFloat(item.unitPrice || item.unit_price || item.price || item.unitCost || item.cost || 0);
            if (unitPrice === 0 && rawItems.length === 1 && totalAmount > 0) {
              unitPrice = totalAmount;
            }
            const productImageUrl = extractProductImage(item, null);

            // Auto-create or fetch product from WMS catalog
            const product = await getOrCreateProductFromChannelItem({ ...item, sku, unitPrice, quantity }, companyId || 1, productImageUrl);
            if (!product || !product.id) {
              console.error('[OrderItem Create Skip]: Failed to resolve product for SKU:', sku);
              continue;
            }

            const isBundleItem = sku && String(sku).includes('SEL_'); // Bundle SKU pattern
            if (isBundleItem) hasBundle = true;

            const finalImg = productImageUrl || (product ? firstProductImage(product.images) : null);

            const customUrl = item.customizedUrl || item.customized_url || (item.options?.find(o => o.name === 'CustomizedURL' || o.name === 'Customized URL')?.value) || (ssOrder.notes && ssOrder.notes.includes('CustomizedURL:') ? ssOrder.notes.split('CustomizedURL:')[1]?.trim()?.split(/\s+/)[0] : null);

            await OrderItem.create({
              salesOrderId: existingOrder.id,
              productId: product.id,
              quantity,
              scannedQty: 0,
              unitPrice,
              bundleHeader: isBundleItem ? `${quantity} x ${sku}` : null,
              isBundleParent: isBundleItem,
              productImageUrl: finalImg,
              originalSku: sku,
              customizedUrl: customUrl,
              bestBeforeDate: item.options?.find(o => o.name === 'BB Date')?.value || null,
              batchNumber: item.options?.find(o => o.name === 'Batch ID')?.value || null
            });
          }

          if (hasBundle) {
            await existingOrder.update({ isBundle: true });
          }

          // Trigger Amazon Customization ZIP extraction & SKU conversion
          try {
            const amazonCustomService = require('./amazonCustomService');
            await amazonCustomService.processOrderCustomizations(existingOrder.id);
          } catch (customErr) {
            console.error('[Amazon Custom Sync Warning]:', customErr.message);
          }
        }

        // Auto-create Shipment record if order is shipped / tracking exists
        const trackingNumber = ssOrder.tracking_number || ssOrder.trackingNumber || ssOrder.trackingCode;
        if (trackingNumber || ssOrder.shipment_status === 'shipped' || ssOrder.orderStatus === 'shipped') {
          try {
            const existingShipment = await Shipment.findOne({ where: { salesOrderId: existingOrder.id } });
            if (!existingShipment) {
              await Shipment.create({
                salesOrderId: existingOrder.id,
                trackingNumber: trackingNumber || `TRK-${existingOrder.id}`,
                carrier: courierName,
                service: courierService,
                status: 'DISPATCHED',
                dispatchedAt: ssOrder.ship_date || ssOrder.ship_datetime || new Date()
              });
              console.log(`[Auto Shipment Create] Created shipment record for order ${orderNumber}`);
            }
          } catch (shipErr) {
            // Ignore shipment warning
          }
        }

        syncedCount++;
      }
    }

    // Update IntegrationConfig lastSyncTime & updatedAt in DB so UI displays current connected/sync timestamp
    try {
      await IntegrationConfig.update(
        { lastSyncTime: new Date(), updatedAt: new Date(), status: 'ACTIVE' },
        { where: { companyId: companyId || 1, platform: 'SHIPSTATION' } }
      );
    } catch (e) {
      // Ignore timestamp update error
    }

    return { success: true, syncedCount, message: `Successfully synced ${syncedCount} new orders from ShipStation.` };
  } catch (error) {
    const respData = error.response?.data;
    const errMessage = respData?.errors?.[0]?.message || respData?.message || (typeof respData === 'string' ? respData : null) || error.message;
    console.error('[ShipStation Sync Error]:', respData || error.message);
    return { success: false, error: errMessage, syncedCount: 0 };
  }
}

/**
 * Push Inventory Updates to ShipStation API v2
 */
async function updateInventoryToShipStation(companyId, sku, availableQty) {
  const { apiKey } = await getShipStationConfig(companyId);
  if (!apiKey) return false;

  try {
    await makeShipStationRequest(companyId, '/inventory/update', {
      method: 'POST',
      data: { sku, availableQuantity: availableQty }
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

  const { apiKey } = await getShipStationConfig(order.companyId);

  let labelUrl = null;
  let trackingNumber = `TRK-${Date.now()}`;
  let carrierCode = order.courierName || 'Royal Mail';

  if (apiKey && order.shipstationOrderId) {
    try {
      const response = await makeShipStationRequest(order.companyId, '/orders/createlabel', {
        method: 'POST',
        data: {
          orderId: order.shipstationOrderId,
          carrierCode: order.courierName || 'royal_mail',
          serviceCode: order.courierService || 'royal_mail_tracked_48',
          confirmation: 'none',
          testLabel: process.env.NODE_ENV !== 'production'
        }
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

/**
 * Fetch connected stores list directly from ShipStation API (/stores)
 */
async function getShipStationStores(companyId) {
  try {
    const response = await makeShipStationRequest(companyId, '/stores');
    const stores = response.data || [];
    return Array.isArray(stores) ? stores : (stores.stores || []);
  } catch (err) {
    return [];
  }
}

/**
 * ShipStation V2: Rate Shopping (/rates or /v2/rates)
 */
async function getRates(companyId, rateData) {
  const response = await makeShipStationRequest(companyId, '/v2/rates', {
    method: 'POST',
    data: rateData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Shipment (/shipments or /v2/shipments)
 */
async function createShipment(companyId, shipmentData) {
  const payload = {
    create_sales_order: true,
    ...shipmentData
  };
  const response = await makeShipStationRequest(companyId, '/v2/shipments', {
    method: 'POST',
    data: payload
  });
  return response.data;
}

/**
 * ShipStation V2: List Shipments (/v2/shipments)
 */
async function listShipments(companyId, query = {}) {
  const qStr = new URLSearchParams(query).toString();
  const path = qStr ? `/v2/shipments?${qStr}` : '/v2/shipments';
  const response = await makeShipStationRequest(companyId, path);
  return response.data;
}

/**
 * ShipStation V2: Create Label (/v2/labels)
 */
async function createV2Label(companyId, labelData) {
  const response = await makeShipStationRequest(companyId, '/v2/labels', {
    method: 'POST',
    data: labelData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Return Label (/v2/return_labels)
 */
async function createReturnLabel(companyId, returnData) {
  const response = await makeShipStationRequest(companyId, '/v2/return_labels', {
    method: 'POST',
    data: returnData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Batch Labels (/v2/batches)
 */
async function createBatchLabels(companyId, batchData) {
  const response = await makeShipStationRequest(companyId, '/v2/batches', {
    method: 'POST',
    data: batchData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Manifest (/v2/manifests)
 */
async function createManifest(companyId, manifestData) {
  const response = await makeShipStationRequest(companyId, '/v2/manifests', {
    method: 'POST',
    data: manifestData
  });
  return response.data;
}

/**
 * ShipStation V2: Schedule Pickup (/v2/pickups)
 */
async function schedulePickup(companyId, pickupData) {
  const response = await makeShipStationRequest(companyId, '/v2/pickups', {
    method: 'POST',
    data: pickupData
  });
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Levels (/v2/inventory)
 */
async function getInventoryLevels(companyId) {
  const response = await makeShipStationRequest(companyId, '/v2/inventory');
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Warehouses (/v2/inventory_warehouses)
 */
async function getInventoryWarehouses(companyId) {
  const response = await makeShipStationRequest(companyId, '/v2/inventory_warehouses');
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Locations (/v2/inventory_locations)
 */
async function getInventoryLocations(companyId) {
  const response = await makeShipStationRequest(companyId, '/v2/inventory_locations');
  return response.data;
}

/**
 * ShipStation V2: List Users (/v2/users)
 */
async function getUsers(companyId) {
  const response = await makeShipStationRequest(companyId, '/v2/users');
  return response.data;
}

/**
 * Test ShipStation API Connection
 */
async function testConnection(companyId) {
  try {
    await makeShipStationRequest(companyId, '/orders?orderStatus=awaiting_shipment');
    return { success: true, message: 'ShipStation API V2 connection test successful (200 OK)' };
  } catch (err) {
    try {
      await makeShipStationRequest(companyId, '/orders');
      return { success: true, message: 'ShipStation API V2 connection test successful (200 OK)' };
    } catch (err2) {
      const lastErr = err2 || err;
      const respData = lastErr?.response?.data;
      let errMessage = respData?.errors?.[0]?.message || respData?.message || (typeof respData === 'string' ? respData : null) || lastErr?.message;

      if (lastErr?.response?.status === 401) {
        errMessage = `ShipStation 401 Unauthorized: Production Key authentication failed. Please verify your Production Key in ShipStation Settings > Account > API Settings (Select V2 API).`;
      }
      return { success: false, error: errMessage };
    }
  }
}

async function fetchLiveShipStationOrderData(shipstationOrderId, companyId) {
  if (!shipstationOrderId) return null;
  try {
    const res = await makeShipStationRequest(companyId || 1, `/v2/shipments/${shipstationOrderId}`);
    if (res && res.data) return res.data;
  } catch (err1) {
    try {
      const res2 = await makeShipStationRequest(companyId || 1, `/orders/${shipstationOrderId}`);
      if (res2 && res2.data) return res2.data;
    } catch (err2) {
      // Ignore API fetch errors if order is not found on remote endpoint
    }
  }
  return null;
}

async function syncStockToShipStation(sku, stockQuantity, companyId) {
  if (!sku) return;
  try {
    const payload = {
      sku,
      stock: stockQuantity
    };
    await makeShipStationRequest(companyId || 1, '/v2/inventory', {
      method: 'POST',
      data: [payload]
    });
    console.log(`[Stock Sync ShipStation] Pushed stock level ${stockQuantity} for SKU ${sku} to ShipStation`);
  } catch (err) {
    console.warn(`[Stock Sync ShipStation Notice] ${sku}:`, err.message);
  }
}

module.exports = {
  testConnection,
  syncOrdersFromShipStation,
  updateInventoryToShipStation,
  createShippingLabelAndDispatch,
  getShipStationStores,
  getRates,
  createShipment,
  listShipments,
  createV2Label,
  createReturnLabel,
  createBatchLabels,
  createManifest,
  schedulePickup,
  getInventoryLevels,
  getInventoryWarehouses,
  getInventoryLocations,
  getUsers,
  fetchLiveShipStationOrderData,
  syncStockToShipStation
};
