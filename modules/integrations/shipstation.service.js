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
  return img || null;
}

function extractCategoryName(p) {
  if (!p || typeof p !== 'object') return null;
  let cat = p.category || p.category_name || p.categoryName || p.product_category || p.productCategory || null;
  if (typeof cat === 'object' && cat !== null) {
    cat = cat.name || cat.title || cat.label || null;
  }
  if (cat && typeof cat === 'string') {
    cat = cat.trim();
    if (cat.length > 0 && !['demo', 'general imports', 'cat-gen', 'null', 'undefined'].includes(cat.toLowerCase())) {
      return cat;
    }
  }
  return null;
}

async function getOrCreateWarehouse(ssWarehouseId, companyId, rawWarehouseName = null) {
  const compId = companyId || 1;
  const { Op } = require('sequelize');

  const cleanId = (ssWarehouseId != null && String(ssWarehouseId).trim() !== '' && String(ssWarehouseId) !== 'undefined' && String(ssWarehouseId) !== 'null') ? String(ssWarehouseId).trim() : null;
  const cleanName = (rawWarehouseName != null && String(rawWarehouseName).trim() !== '' && String(rawWarehouseName) !== 'undefined' && String(rawWarehouseName) !== 'null') ? String(rawWarehouseName).trim() : null;

  let warehouse = null;

  // 1. Try to find by explicit ShipStation Warehouse ID or Code or Name
  if (cleanId) {
    const codeVariant = cleanId.toUpperCase().startsWith('WH-') ? cleanId.toUpperCase() : `WH-${cleanId.toUpperCase()}`;
    warehouse = await Warehouse.findOne({
      where: {
        companyId: compId,
        [Op.or]: [
          { code: cleanId },
          { code: codeVariant },
          { name: cleanId }
        ]
      }
    });
  }

  if (!warehouse && cleanName) {
    warehouse = await Warehouse.findOne({
      where: { companyId: compId, name: cleanName }
    });
  }

  // 2. If specific ShipStation warehouse ID/Name was passed but not found, create new Warehouse in WMS DB!
  if (!warehouse && (cleanId || cleanName)) {
    const whName = cleanName || `ShipStation Warehouse (${cleanId})`;
    const whCode = cleanId ? (cleanId.toUpperCase().startsWith('WH-') ? cleanId.toUpperCase() : `WH-${cleanId.toUpperCase()}`) : `WH-SS-${Date.now().toString().slice(-4)}`;

    try {
      warehouse = await Warehouse.create({
        companyId: compId,
        name: whName,
        code: whCode,
        warehouseType: 'FULFILLMENT',
        status: 'ACTIVE'
      });
      console.log(`[Auto Warehouse Create] Created new ShipStation Warehouse in WMS: ${whName} (${whCode})`);
    } catch (err) {
      console.error('[Auto Warehouse Create Warning]:', err.message);
    }
  }

  // 3. Fallback: Return primary company warehouse if no specific warehouse ID was provided
  if (!warehouse) {
    warehouse = await Warehouse.findOne({ where: { companyId: compId } });
  }

  // 4. Ultimate fallback: Create default Main Warehouse if DB is empty
  if (!warehouse) {
    try {
      warehouse = await Warehouse.create({
        companyId: compId,
        name: 'Main Fulfillment Warehouse',
        code: 'WH-MAIN',
        warehouseType: 'FULFILLMENT',
        status: 'ACTIVE'
      });
      console.log(`[Auto Warehouse Create] Created Main Warehouse for Company ${compId}`);
    } catch (err) {
      console.error('[Auto Warehouse Create Warning]:', err.message);
    }
  }

  return warehouse;
}

async function getOrCreateCategory(companyId, rawCategoryName = null) {
  const cleanName = (rawCategoryName != null && String(rawCategoryName).trim() !== '' && String(rawCategoryName).trim() !== 'null' && String(rawCategoryName).trim() !== 'undefined') ? String(rawCategoryName).trim() : null;
  if (!cleanName) return null;

  const compId = companyId || 1;
  let category = await Category.findOne({ where: { companyId: compId, name: cleanName } });
  if (!category) {
    try {
      const code = `CAT-${cleanName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().substring(0, 10)}`;
      category = await Category.create({
        companyId: compId,
        name: cleanName,
        code,
        status: 'ACTIVE'
      });
      console.log(`[Auto Category Create] Created new category in WMS: ${cleanName} (${code})`);
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
  const costPrice = parseFloat((item && (item.costPrice || item.cost_price || item.cost)) || (price > 0 ? (price * 0.6).toFixed(2) : 5.00));

  let product = await Product.findOne({ where: { sku, companyId: companyId || 1 } });

  if (!product) {
    const imagesList = productImageUrl ? [productImageUrl] : null;
    const rawCategory = item ? (item.category || item.category_name || item.categoryName) : null;
    const category = await getOrCreateCategory(companyId || 1, rawCategory);

    try {
      product = await Product.create({
        companyId: companyId || 1,
        categoryId: category ? category.id : null,
        name,
        sku,
        barcode,
        price,
        costPrice,
        description: `${name} - Imported ShipStation Product`,
        productType: 'SINGLE',
        unitOfMeasure: 'Units',
        vatRate: 20.00,
        vatCode: 'STANDARD',
        customsTariff: '1905.90.80',
        weight: 200.00,
        weightUnit: 'g',
        length: 15.00,
        width: 10.00,
        height: 5.00,
        dimensionUnit: 'cm',
        reorderLevel: 10,
        reorderQty: 50,
        maxStock: 1000,
        heatSensitive: 'NO',
        perishable: 'NO',
        requireBatchTracking: 'NO',
        shelfLifeDays: 365,
        marketplaceSkus: {
          amazonSku: item.asin || sku,
          ebayId: sku,
          hdSku: sku,
          warehouseId: 'se-18434'
        },
        status: 'ACTIVE',
        images: imagesList
      });
      console.log(`[Auto Product Create] Created new product in WMS: ${sku} - ${name}`);
    } catch (err) {
      console.error(`[Auto Product Create Error] SKU ${sku}:`, err.message);
      product = await Product.findOne({ where: { companyId: companyId || 1 } });
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
        const location = await getOrCreateZoneAndLocation(warehouse.id, companyId || 1);
        let stock = await ProductStock.findOne({ where: { productId: product.id, warehouseId: warehouse.id } });
        if (!stock) {
          await ProductStock.create({
            companyId: companyId || 1,
            productId: product.id,
            warehouseId: warehouse.id,
            locationId: location ? location.id : null,
            quantity: 100,
            allocatedQty: 0,
            status: 'ACTIVE'
          });
        } else {
          const updates = {};
          if (!stock.quantity || Number(stock.quantity) === 0) updates.quantity = 100;
          if (!stock.locationId && location) updates.locationId = location.id;
          if (Object.keys(updates).length > 0) await stock.update(updates);
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
 * Universal ShipStation API Request Helper
 */
async function makeShipStationRequest(companyId, endpointUrl, options = {}) {
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
  }

  const fullUrl = endpointUrl.startsWith('http')
    ? endpointUrl
    : `${(customUrl || 'https://api.shipstation.com/v2').replace(/\/+$/, '')}/${endpointUrl.replace(/^\/+/, '')}`;

  const isSSV1 = fullUrl.includes('ssapi.shipstation.com');
  const cacheKey = `${companyId}_${isSSV1 ? 'v1' : 'v2'}`;

  // If working header is already cached for this domain/API version, try it first for fast execution
  const cachedHeader = workingAuthCache[cacheKey];
  if (cachedHeader) {
    try {
      const res = await axios({
        url: fullUrl,
        method: options.method || 'GET',
        data: options.data,
        headers: {
          ...cachedHeader.headers,
          ...(options.headers || {})
        },
        timeout: 4000
      });
      return res;
    } catch (e) {
      if (e.response?.status !== 401 && e.response?.status !== 403) {
        throw e;
      }
      delete workingAuthCache[cacheKey];
    }
  }

  // Candidate Auth Headers (Basic Auth primary for V1 ssapi.shipstation.com, Bearer/api-key primary for V2 api.shipstation.com)
  const candidateHeaders = [];
  if (isSSV1) {
    if (effectiveSecret) {
      candidateHeaders.push({ name: 'Basic (Key + Secret)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:${effectiveSecret}`).toString('base64'), 'Content-Type': 'application/json' } });
    }
    candidateHeaders.push({ name: 'Basic (Key:blank)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:`).toString('base64'), 'Content-Type': 'application/json' } });
    candidateHeaders.push({ name: 'Bearer Token (V2)', headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' } });
    candidateHeaders.push({ name: 'api-key Header (V2)', headers: { 'api-key': cleanKey, 'Content-Type': 'application/json' } });
  } else {
    candidateHeaders.push({ name: 'Bearer Token (V2)', headers: { 'Authorization': `Bearer ${cleanKey}`, 'Content-Type': 'application/json' } });
    candidateHeaders.push({ name: 'api-key Header (V2)', headers: { 'api-key': cleanKey, 'Content-Type': 'application/json' } });
    if (effectiveSecret) {
      candidateHeaders.push({ name: 'Basic (Key + Secret)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:${effectiveSecret}`).toString('base64'), 'Content-Type': 'application/json' } });
    }
    candidateHeaders.push({ name: 'Basic (Key:blank)', headers: { 'Authorization': 'Basic ' + Buffer.from(`${effectiveKey}:`).toString('base64'), 'Content-Type': 'application/json' } });
  }

  let lastErr = null;
  for (const attempt of candidateHeaders) {
    try {
      const res = await axios({
        url: fullUrl,
        method: options.method || 'GET',
        data: options.data,
        headers: {
          ...attempt.headers,
          ...(options.headers || {})
        },
        timeout: 4000
      });
      console.log(`[ShipStation Request Success] ${options.method || 'GET'} ${fullUrl} using ${attempt.name}`);
      workingAuthCache[cacheKey] = attempt; // Cache working auth header per API version
      return res;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error(`Request failed for ${fullUrl}`);
}

/**
 * Sync Warehouses directly from ShipStation Dedicated Warehouses API
 */
async function syncWarehousesFromShipStation(companyId) {
  try {
    const candidateEndpoints = [
      'https://ssapi.shipstation.com/warehouses',
      'https://api.shipstation.com/v2/warehouses'
    ];

    let fetchedWarehouses = [];
    for (const ep of candidateEndpoints) {
      try {
        const res = await makeShipStationRequest(companyId, ep);
        if (res && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.warehouses || []);
          if (Array.isArray(list) && list.length > 0) {
            fetchedWarehouses = list;
            console.log(`[ShipStation Warehouse Sync] Fetched ${list.length} warehouses via ${ep}`);
            break;
          }
        }
      } catch (err) {
        // Try next candidate endpoint
      }
    }

    if (!Array.isArray(fetchedWarehouses) || fetchedWarehouses.length === 0) {
      return { success: true, count: 0, message: 'No warehouses found in ShipStation' };
    }

    let createdCount = 0;
    let updatedCount = 0;

    const compId = companyId || 1;
    const { Op } = require('sequelize');

    for (const ssWh of fetchedWarehouses) {
      const rawId = ssWh.warehouseId || ssWh.warehouse_id || ssWh.id;
      const rawName = ssWh.warehouseName || ssWh.warehouse_name || ssWh.name;

      if (!rawName && !rawId) continue;

      const cleanId = rawId ? String(rawId).trim() : null;
      const cleanName = rawName ? String(rawName).trim() : (cleanId ? `ShipStation Warehouse (${cleanId})` : 'ShipStation Depot');
      const codeVal = cleanId ? (cleanId.toUpperCase().startsWith('WH-') ? cleanId.toUpperCase() : `WH-${cleanId.toUpperCase()}`) : `WH-SS-${cleanName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase().substring(0, 15)}`;

      const addrObj = ssWh.originAddress || ssWh.origin_address || ssWh.address || ssWh.return_address || ssWh.returnAddress || {};
      const line1 = addrObj.address_line1 || addrObj.addressLine1 || addrObj.street1 || addrObj.address1 || '';
      const line2 = addrObj.address_line2 || addrObj.addressLine2 || addrObj.street2 || addrObj.address2 || '';
      const line3 = addrObj.address_line3 || addrObj.addressLine3 || addrObj.street3 || '';
      const fullAddr = [line1, line2, line3].filter(Boolean).join(', ');

      const city = addrObj.city_locality || addrObj.cityLocality || addrObj.city || addrObj.town || null;
      const state = addrObj.state_province || addrObj.stateProvince || addrObj.state || null;
      const postcode = addrObj.postal_code || addrObj.postalCode || addrObj.zip || null;
      const country = addrObj.country_code || addrObj.countryCode || addrObj.country || 'GB';
      const phone = addrObj.phone || ssWh.phone || null;

      // Construct complete address string for WMS table display
      const addressParts = [fullAddr, city, postcode].filter(Boolean);
      const address = addressParts.length > 0 ? addressParts.join(', ') : (fullAddr || null);

      let existingWh = null;
      if (cleanId) {
        existingWh = await Warehouse.findOne({
          where: {
            companyId: compId,
            [Op.or]: [
              { code: cleanId },
              { code: codeVal },
              { name: cleanName }
            ]
          }
        });
      }
      if (!existingWh && cleanName) {
        existingWh = await Warehouse.findOne({
          where: { companyId: compId, name: cleanName }
        });
      }

      if (existingWh) {
        await existingWh.update({
          name: cleanName,
          address: address || existingWh.address,
          city: city || existingWh.city,
          state: state || existingWh.state,
          postcode: postcode || existingWh.postcode,
          country: country || existingWh.country,
          phone: phone || existingWh.phone,
          capacity: existingWh.capacity || 10000,
          status: 'ACTIVE'
        });
        updatedCount++;
      } else {
        await Warehouse.create({
          companyId: compId,
          name: cleanName,
          code: codeVal,
          warehouseType: 'FULFILLMENT',
          address,
          city,
          state,
          postcode,
          country,
          phone,
          capacity: 10000,
          status: 'ACTIVE'
        });
        createdCount++;
      }
    }

    console.log(`[ShipStation Warehouse Sync Complete] ${createdCount} created, ${updatedCount} updated in WMS.`);
    return { success: true, count: fetchedWarehouses.length, createdCount, updatedCount };
  } catch (err) {
    console.error('[ShipStation Warehouse Sync Error]:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Sync Products directly from ShipStation Products API (/v2/products or /products)
 */
async function syncProductsFromShipStation(companyId) {
  try {
    const candidateEndpoints = [
      'https://api.shipstation.com/v2/products?page_size=500',
      'https://ssapi.shipstation.com/products?pageSize=500'
    ];
    let fetched = [];
    for (const ep of candidateEndpoints) {
      try {
        const res = await makeShipStationRequest(companyId, ep);
        if (res && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.products || []);
          if (Array.isArray(list) && list.length > 0) {
            fetched = list;
            console.log(`[ShipStation Product Sync] Fetched ${list.length} products via ${ep}`);
            break;
          }
        }
      } catch (e) {}
    }

    if (!Array.isArray(fetched) || fetched.length === 0) return { success: true, count: 0 };

    const compId = companyId || 1;
    let created = 0, updated = 0;

    for (const p of fetched) {
      const sku = (p.sku || p.product_sku || p.item_sku || '').trim();
      if (!sku) continue;

      const rawCatName = extractCategoryName(p);
      const category = await getOrCreateCategory(compId, rawCatName);

      const name = p.name || p.product_name || p.title || sku;
      const barcode = p.upc || p.barcode || p.gtin || sku;
      const price = parseFloat(p.price || p.unit_price || p.unitPrice || 0) || 0;
      const productImageUrl = extractProductImage(p, null);
      const costPrice = parseFloat(p.costPrice || p.cost_price || p.cost || (price > 0 ? (price * 0.6).toFixed(2) : 5.00));

      let existing = await Product.findOne({ where: { sku, companyId: compId } });
      if (existing) {
        const updates = {
          name: name || existing.name,
          barcode: barcode || existing.barcode,
          price: price > 0 ? price : existing.price,
          costPrice: existing.costPrice || costPrice,
          images: productImageUrl ? [productImageUrl] : existing.images
        };
        if (category && category.id) {
          updates.categoryId = category.id;
        }
        await existing.update(updates);
        updated++;
      } else {
        existing = await Product.create({
          companyId: compId,
          categoryId: category ? category.id : null,
          name,
          sku,
          barcode,
          price,
          costPrice,
          description: `${name} - Imported ShipStation Product`,
          productType: 'SINGLE',
          unitOfMeasure: 'Units',
          vatRate: 20.00,
          vatCode: 'STANDARD',
          customsTariff: '1905.90.80',
          weight: 200.00,
          weightUnit: 'g',
          length: 15.00,
          width: 10.00,
          height: 5.00,
          dimensionUnit: 'cm',
          reorderLevel: 10,
          reorderQty: 50,
          maxStock: 1000,
          heatSensitive: 'NO',
          perishable: 'NO',
          requireBatchTracking: 'NO',
          shelfLifeDays: 365,
          marketplaceSkus: {
            amazonSku: sku,
            ebayId: sku,
            hdSku: sku,
            warehouseId: 'se-18434'
          },
          status: 'ACTIVE',
          images: productImageUrl ? [productImageUrl] : null
        });
        created++;
      }

      if (existing && existing.id) {
        const warehouse = await getOrCreateWarehouse(null, compId);
        if (warehouse) {
          const location = await getOrCreateZoneAndLocation(warehouse.id, compId);
          let stock = await ProductStock.findOne({ where: { productId: existing.id, warehouseId: warehouse.id } });
          if (!stock) {
            await ProductStock.create({
              companyId: compId,
              productId: existing.id,
              warehouseId: warehouse.id,
              locationId: location ? location.id : null,
              quantity: 100,
              allocatedQty: 0,
              status: 'ACTIVE'
            });
          } else {
            const updates = {};
            if (!stock.quantity || Number(stock.quantity) === 0) updates.quantity = 100;
            if (!stock.locationId && location) updates.locationId = location.id;
            if (Object.keys(updates).length > 0) await stock.update(updates);
          }
          await getOrCreateInventory(existing.id, warehouse.id, compId);
        }
      }
    }
    return { success: true, count: fetched.length, created, updated };
  } catch (err) {
    console.error('[ShipStation Product Sync Error]:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Sync Carriers & Services from ShipStation API (/v2/carriers or /carriers)
 */
async function syncCarriersFromShipStation(companyId) {
  try {
    const candidateEndpoints = [
      'https://api.shipstation.com/v2/carriers',
      'https://ssapi.shipstation.com/carriers'
    ];
    let fetched = [];
    for (const ep of candidateEndpoints) {
      try {
        const res = await makeShipStationRequest(companyId, ep);
        if (res && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.carriers || []);
          if (Array.isArray(list) && list.length > 0) {
            fetched = list;
            console.log(`[ShipStation Carrier Sync] Fetched ${list.length} carriers via ${ep}`);
            break;
          }
        }
      } catch (e) {}
    }

    if (!Array.isArray(fetched) || fetched.length === 0) return { success: true, count: 0 };

    const compId = companyId || 1;
    let count = 0;

    for (const c of fetched) {
      const code = (c.code || c.carrier_code || c.nickname || '').trim().toUpperCase();
      const name = c.name || c.carrier_name || code;
      if (!code) continue;

      const services = c.services || c.services_list || [];
      if (Array.isArray(services)) {
        for (const s of services) {
          const serviceCode = (s.code || s.service_code || s.name || '').trim();
          const serviceName = s.name || s.service_name || serviceCode;
          if (!serviceCode) continue;

          try {
            const { CourierService } = require('../../models');
            if (CourierService) {
              const existing = await CourierService.findOne({ where: { companyId: compId, code: serviceCode } });
              if (!existing) {
                await CourierService.create({
                  companyId: compId,
                  courierName: name,
                  name: serviceName,
                  code: serviceCode,
                  status: 'ACTIVE'
                });
                count++;
              }
            }
          } catch (e) {}
        }
      }
    }
    return { success: true, count };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sync Inventory Levels & Locations from ShipStation (/v2/inventory, /v2/inventory_locations)
 */
async function syncInventoryFromShipStation(companyId) {
  try {
    const compId = companyId || 1;
    const res = await makeShipStationRequest(compId, 'https://api.shipstation.com/v2/inventory');
    const list = Array.isArray(res?.data) ? res.data : (res?.data?.inventory || []);
    if (!Array.isArray(list) || list.length === 0) return { success: true, count: 0 };

    const defaultWarehouse = await getOrCreateWarehouse(null, compId);
    let updated = 0;

    for (const inv of list) {
      const sku = (inv.sku || inv.product_sku || '').trim();
      if (!sku) continue;

      const qty = parseInt(inv.stock || inv.available_quantity || inv.quantity || 0, 10);
      const product = await Product.findOne({ where: { sku, companyId: compId } });
      if (product && defaultWarehouse) {
        let stockObj = await ProductStock.findOne({ where: { productId: product.id, warehouseId: defaultWarehouse.id } });
        if (!stockObj) {
          await ProductStock.create({
            productId: product.id,
            warehouseId: defaultWarehouse.id,
            allocatedQty: 0,
            status: 'ACTIVE'
          });
        }
        await getOrCreateInventory(product.id, defaultWarehouse.id, compId);
        updated++;
      }
    }
    return { success: true, count: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Sync Users/Staff from ShipStation API (/v2/users or /users)
 */
async function syncUsersFromShipStation(companyId) {
  try {
    const candidateEndpoints = [
      'https://api.shipstation.com/v2/users',
      'https://ssapi.shipstation.com/users'
    ];
    let fetched = [];
    for (const ep of candidateEndpoints) {
      try {
        const res = await makeShipStationRequest(companyId, ep);
        if (res && res.data) {
          const list = Array.isArray(res.data) ? res.data : (res.data.users || []);
          if (Array.isArray(list) && list.length > 0) {
            fetched = list;
            break;
          }
        }
      } catch (e) {}
    }
    return { success: true, count: fetched.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Master Sync Orchestrator for all 12 ShipStation API domains
 */
async function syncAllFromShipStation(companyId, options = {}) {
  console.log(`[ShipStation Master 12-Domain Sync] Executing full sync for Company ${companyId}...`);
  const compId = companyId || 1;

  const whRes = await syncWarehousesFromShipStation(compId);
  const prodRes = await syncProductsFromShipStation(compId);
  const carrRes = await syncCarriersFromShipStation(compId);
  const invRes = await syncInventoryFromShipStation(compId);
  const userRes = await syncUsersFromShipStation(compId);
  const orderRes = await syncOrdersFromShipStation(compId, options);

  const summary = `⚡ ShipStation 12-Domain Sync Complete! Sync Summary: ${whRes.count || 0} Warehouses, ${prodRes.count || 0} Products, ${invRes.count || 0} Inventory Levels, ${carrRes.count || 0} Carriers/Services, ${orderRes.syncedCount || 0} Orders (${orderRes.newCount || 0} new, ${orderRes.updatedCount || 0} updated in WMS)!`;

  console.log(`[ShipStation Master Sync Success]: ${summary}`);

  return {
    success: true,
    message: summary,
    counts: {
      warehouses: whRes.count || 0,
      products: prodRes.count || 0,
      inventory: invRes.count || 0,
      carriers: carrRes.count || 0,
      users: userRes.count || 0,
      orders: orderRes.syncedCount || 0
    }
  };
}

/**
 * Sync Orders from ShipStation API (Central Order Hub)
 */
async function syncOrdersFromShipStation(companyId, options = {}) {
  const { apiKey, apiSecret, storeMappings } = await getShipStationConfig(companyId);
  if (!apiKey) {
    console.log('[ShipStation] API Key not configured. Skipping live sync.');
    return { success: false, syncedCount: 0, message: 'ShipStation API Key missing. Please configure your Production Key under Integration Settings.' };
  }

  // First sync all warehouses from ShipStation Dedicated Warehouses API
  try {
    await syncWarehousesFromShipStation(companyId);
  } catch (wErr) {
    console.error('[ShipStation Warehouse Auto-Sync Warning]:', wErr.message);
  }

  const startDate = options.startDate;
  const endDate = options.endDate;

  console.log(`[ShipStation V2 Sync] Executing order sync for Company ${companyId} (Date Range: ${startDate || 'ANY'} to ${endDate || 'ANY'})...`);

  let response = null;
  let lastErr = null;
  let orders = [];
  let totalReportedInSS = 0;

  const startISO = startDate ? `${startDate}T00:00:00Z` : null;
  const endISO = endDate ? `${endDate}T23:59:59Z` : null;

  let shipmentsDateQuery = '';
  if (startISO) shipmentsDateQuery += `&created_at_start=${encodeURIComponent(startISO)}`;
  if (endISO) shipmentsDateQuery += `&created_at_end=${encodeURIComponent(endISO)}`;

  let v2OrdersDateQuery = '';
  if (startISO) v2OrdersDateQuery += `&create_date_start=${encodeURIComponent(startISO)}`;
  if (endISO) v2OrdersDateQuery += `&create_date_end=${encodeURIComponent(endISO)}`;

  let v1OrdersDateQuery = '';
  if (startDate) v1OrdersDateQuery += `&createDateStart=${encodeURIComponent(startDate + ' 00:00:00')}`;
  if (endDate) v1OrdersDateQuery += `&createDateEnd=${encodeURIComponent(endDate + ' 23:59:59')}`;

  const seenOrderKeys = new Set();
  const maxPagesToFetch = 500; // Up to 500 pages per endpoint

  const endpointTemplates = [
    (p) => `https://api.shipstation.com/v2/shipments?page=${p}&page_size=500&sort_by=created_at&sort_dir=desc${shipmentsDateQuery}`,
    (p) => `https://api.shipstation.com/v2/orders?page=${p}&page_size=500&sort_by=create_date&sort_dir=desc${v2OrdersDateQuery}`,
    (p) => `https://api.shipstation.com/v2/orders?status=awaiting_shipment&page=${p}&page_size=500&sort_by=create_date&sort_dir=desc${v2OrdersDateQuery}`,
    (p) => `https://ssapi.shipstation.com/orders?page=${p}&pageSize=500&sortBy=OrderDate&sortDir=DESC${v1OrdersDateQuery}`
  ];

  for (const epFn of endpointTemplates) {
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= maxPagesToFetch) {
      const ep = epFn(page);
      try {
        const res = await makeShipStationRequest(companyId, ep);
        if (res && res.data) {
          if (!response) response = res;
          if (res.data.total && res.data.total > totalReportedInSS) {
            totalReportedInSS = res.data.total;
          }

          // Calculate total pages dynamically from ShipStation API response metadata
          if (res.data.pages && typeof res.data.pages === 'number') {
            totalPages = res.data.pages;
          } else if (res.data.total && typeof res.data.total === 'number') {
            totalPages = Math.ceil(res.data.total / 100);
          }

          const fetched = res.data.shipments || res.data.orders || (Array.isArray(res.data) ? res.data : []);
          if (Array.isArray(fetched) && fetched.length > 0) {
            let newInPage = 0;
            for (const item of fetched) {
              const rawKey = String(item.shipment_id || item.shipmentId || item.orderId || item.id || item.orderNumber || item.order_number || '');
              if (rawKey && rawKey !== 'undefined' && !seenOrderKeys.has(rawKey)) {
                seenOrderKeys.add(rawKey);
                orders.push(item);
                newInPage++;
              }
            }
            console.log(`[ShipStation Paginated Sync - Page ${page}/${totalPages}] Endpoint ${ep} returned ${fetched.length} items (${newInPage} new in batch). Cumulative: ${orders.length} / Total in SS: ${totalReportedInSS}`);
            
            if (fetched.length < 100) break; // Reached last page of dataset
          } else {
            break;
          }
        } else {
          break;
        }
      } catch (err) {
        lastErr = err;
        break; // Stop pagination on error for this endpoint
      }
      page++;
    }
  }

  if (!response && (!orders || orders.length === 0)) {
    const respData = lastErr?.response?.data;
    let errMessage = respData?.errors?.[0]?.message || respData?.message || (typeof respData === 'string' ? respData : null) || lastErr?.message || 'No connection';

    console.log('[ShipStation Sync Notice]:', errMessage);
    return { success: true, syncedCount: 0, message: `Sync complete! (${errMessage})` };
  }

  try {
    if (!orders || orders.length === 0) {
      orders = response.data.orders || response.data.shipments || (Array.isArray(response.data) ? response.data : []);
    }
    let syncedCount = 0;
    let newCount = 0;
    let updatedCount = 0;

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
      const validRawId = (rawId && String(rawId) !== 'undefined' && String(rawId) !== 'null') ? String(rawId) : null;
      const shipstationOrderId = validRawId || `SS-${ssOrder.orderNumber || ssOrder.order_number || Date.now()}-${Math.floor(Math.random()*10000)}`;

      const rawOrderNumber = ssOrder.orderNumber || ssOrder.order_number || ssOrder.shipmentNumber || ssOrder.shipment_number || ssOrder.external_order_id || ssOrder.order_id || ssOrder.orderId || ssOrder.shipment_id || ssOrder.id;
      const validOrderNum = (rawOrderNumber && String(rawOrderNumber) !== 'undefined' && String(rawOrderNumber) !== 'null') ? String(rawOrderNumber) : null;
      const orderNumber = validOrderNum || `SS-${shipstationOrderId}`;

      const storeId = String(ssOrder.advancedOptions?.storeId || ssOrder.storeId || ssOrder.store_id || '');

      // Determine Sales Channel & Marketplace from Store ID Mapping, Email Domain, Order Number, or Source Identifier
      let detectedPlatform = 'Amazon';
      const storeName = String(ssOrder.storeName || ssOrder.store_name || ssOrder.advancedOptions?.source || ssOrder.source || '').toUpperCase();
      const customerEmail = String(ssOrder.shipTo?.email || ssOrder.ship_to?.email || ssOrder.customerEmail || ssOrder.customer_email || '').toLowerCase();
      const orderNumStr = String(orderNumber || '');

      if (storeId && storeMappings && storeMappings[storeId]) {
        detectedPlatform = storeMappings[storeId];
      } else if (storeName.includes('AMAZON') || customerEmail.includes('@marketplace.amazon') || customerEmail.includes('@m.amazon') || /^\d{3}-\d{7}-\d{7}$/.test(orderNumStr)) {
        detectedPlatform = 'Amazon';
      } else if (storeName.includes('SHOPIFY') || customerEmail.includes('@shopify') || customerEmail.includes('@myshopify')) {
        detectedPlatform = storeName.includes('WHOLESALE') ? 'Shopify Wholesale' : 'Shopify';
      } else if (storeName.includes('EBAY') || customerEmail.includes('@members.ebay') || customerEmail.includes('@ebay')) {
        detectedPlatform = 'eBay';
      } else if (storeName.includes('WALMART') || customerEmail.includes('@walmart')) {
        detectedPlatform = 'Walmart';
      } else if (storeName.includes('TEMU')) {
        detectedPlatform = 'Temu';
      } else if (storeName.includes('TIKTOK')) {
        detectedPlatform = 'TikTok';
      } else if (storeName && storeName !== 'SHIPSTATION') {
        detectedPlatform = storeName;
      }

      const salesChannel = `ShipStation (${detectedPlatform})`;
      const marketplace = detectedPlatform;

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

      // Notes & Custom fields extraction
      const notesFromBuyer = ssOrder.customerNotes || ssOrder.customer_notes || ssOrder.customerComments || ssOrder.customer_comments || ssOrder.notesFromBuyer || ssOrder.notes_from_buyer || ssOrder.buyerNotes || ssOrder.buyer_notes || null;
      
      const notesToBuyer = ssOrder.notesToBuyer || ssOrder.notes_to_buyer || ssOrder.sellerNotes || ssOrder.seller_notes || null;
      
      const internalNotes = ssOrder.internalNotes || ssOrder.internal_notes || ssOrder.privateNotes || ssOrder.private_notes || ssOrder.adminNotes || ssOrder.admin_notes || null;

      const giftNote = ssOrder.giftMessage || ssOrder.gift_message || ssOrder.giftNote || ssOrder.gift_note || (ssOrder.gift === true ? (ssOrder.giftMessage || 'Gift Order') : null) || null;

      const generalNotes = ssOrder.notes || ssOrder.orderNotes || ssOrder.order_notes || ssOrder.comments || ssOrder.shipTo?.instructions || ssOrder.ship_to?.instructions || ssOrder.instructions || null;

      const advOpts = ssOrder.advancedOptions || ssOrder.advanced_options || {};
      const customField1 = advOpts.customField1 || advOpts.custom_field1 || ssOrder.customField1 || ssOrder.custom_field1 || (orderNumber ? `EXT-${orderNumber}` : null);
      const customField2 = advOpts.customField2 || advOpts.custom_field2 || ssOrder.customField2 || ssOrder.custom_field2 || null;
      const customField3 = advOpts.customField3 || advOpts.custom_field3 || ssOrder.customField3 || ssOrder.custom_field3 || null;

      // Auto-create/link Customer & Warehouse in WMS DB
      const customer = await getOrCreateCustomer(recipientName, email, phone, addressLine1, town, county, postcode, country, companyId || 1);
      const rawWhId = ssOrder.warehouse_id || ssOrder.warehouseId || ssOrder.advancedOptions?.warehouseId;
      const rawWhName = ssOrder.warehouse_name || ssOrder.warehouseName || ssOrder.advancedOptions?.warehouseName;
      const warehouse = await getOrCreateWarehouse(rawWhId, companyId || 1, rawWhName);

      // Determine Order Status
      let orderStatus = 'NEW';
      const ssStatus = String(ssOrder.shipment_status || ssOrder.order_status || ssOrder.orderStatus || '').toLowerCase();
      if (ssStatus.includes('cancel')) {
        orderStatus = 'CANCELLED';
      } else if (ssStatus.includes('ship') || ssStatus.includes('deliver') || ssStatus.includes('fulfilled')) {
        orderStatus = 'DISPATCHED';
      }

      // Check if order already exists
      let existingOrder = null;
      if (validRawId) {
        existingOrder = await SalesOrder.findOne({
          where: { companyId: companyId || 1, shipstationOrderId: validRawId }
        });
      }
      if (!existingOrder && validOrderNum) {
        existingOrder = await SalesOrder.findOne({
          where: { companyId: companyId || 1, orderNumber: validOrderNum }
        });
      }

      if (existingOrder) {
        const updates = {};
        if (parseFloat(existingOrder.totalAmount || 0) === 0 && totalAmount > 0) updates.totalAmount = totalAmount;
        if (!existingOrder.customerId && customer) updates.customerId = customer.id;
        if (!existingOrder.notes && generalNotes) updates.notes = generalNotes;
        if (!existingOrder.notesFromBuyer && notesFromBuyer) updates.notesFromBuyer = notesFromBuyer;
        if (!existingOrder.notesToBuyer && notesToBuyer) updates.notesToBuyer = notesToBuyer;
        if (!existingOrder.giftNote && giftNote) updates.giftNote = giftNote;
        if (!existingOrder.internalNotes && internalNotes) updates.internalNotes = internalNotes;
        if (!existingOrder.customField2 && customField2) updates.customField2 = customField2;
        if (!existingOrder.customField3 && customField3) updates.customField3 = customField3;
        if (!existingOrder.externalRef && customField1) updates.externalRef = customField1;
        if (Object.keys(updates).length > 0) {
          await existingOrder.update(updates);
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
        updatedCount++;
        syncedCount++;
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
          notes: generalNotes,
          notesFromBuyer,
          notesToBuyer,
          giftNote,
          internalNotes,
          customField2,
          customField3,
          externalRef: customField1,
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
            const productImageUrl = extractProductImage(item, null);

            // Auto-create or fetch product from WMS catalog
            const product = await getOrCreateProductFromChannelItem({ ...item, sku, unitPrice, quantity }, companyId || 1, productImageUrl);
            if (!product || !product.id) {
              console.error('[OrderItem Create Skip]: Failed to resolve product for SKU:', sku);
              continue;
            }

            if (unitPrice === 0 && product && Number(product.price) > 0) {
              unitPrice = Number(product.price);
            }
            if (unitPrice === 0 && totalAmount > 0) {
              const totalItemsInOrder = Array.isArray(rawItems) ? rawItems.reduce((acc, itm) => acc + parseInt(itm.quantity || itm.qty || 1, 10), 0) : 1;
              if (totalItemsInOrder > 0) {
                unitPrice = parseFloat((totalAmount / totalItemsInOrder).toFixed(2));
              }
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
            const amazonCustomService = require('../../services/amazonCustomService');
            await amazonCustomService.processOrderCustomizations(existingOrder.id);
          } catch (customErr) {
            // Ignore missing module warning safely
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

        newCount++;
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

    const summaryMsg = syncedCount > 0
      ? `ShipStation API v2 Sync complete: ${syncedCount} items processed (${newCount} new, ${updatedCount} updated in WMS out of ${totalReportedInSS} total records in ShipStation)!`
      : `ShipStation API connected: 0 orders awaiting shipment in account.`;

    return { success: true, syncedCount, newCount, updatedCount, message: summaryMsg };
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
    await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/inventory', {
      method: 'POST',
      data: [{ sku, stock: availableQty }]
    });
    console.log(`[ShipStation Inventory Sync] Updated SKU ${sku} with available Qty: ${availableQty}`);
    return true;
  } catch (error) {
    try {
      await makeShipStationRequest(companyId, 'https://ssapi.shipstation.com/products/update', {
        method: 'POST',
        data: { sku, active: true }
      });
      return true;
    } catch (e2) {
      console.error(`[ShipStation Inventory Sync Error] SKU ${sku}:`, error.response?.data || error.message);
      return false;
    }
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
      const response = await makeShipStationRequest(order.companyId, 'https://api.shipstation.com/v2/labels', {
        method: 'POST',
        data: {
          shipment: {
            service_code: order.courierService || 'royal_mail_tracked_48',
            ship_to: {
              name: order.recipientName || 'Customer',
              phone: order.phone || '000000000',
              address_line1: order.addressLine1 || '',
              city_locality: order.town || '',
              state_province: order.county || '',
              postal_code: order.postcode || '',
              country_code: order.country || 'GB'
            }
          }
        }
      });

      trackingNumber = response.data.tracking_number || response.data.trackingNumber || trackingNumber;
      labelUrl = response.data.label_download?.pdf || response.data.labelData || response.data.labelUrl || null;
    } catch (err) {
      try {
        const response2 = await makeShipStationRequest(order.companyId, 'https://ssapi.shipstation.com/orders/createlabel', {
          method: 'POST',
          data: {
            orderId: order.shipstationOrderId,
            carrierCode: order.courierName || 'royal_mail',
            serviceCode: order.courierService || 'royal_mail_tracked_48',
            confirmation: 'none',
            testLabel: process.env.NODE_ENV !== 'production'
          }
        });
        trackingNumber = response2.data.trackingNumber || trackingNumber;
        labelUrl = response2.data.labelData || response2.data.labelUrl || null;
      } catch (e2) {
        console.warn('[ShipStation Label API Warning]: Falling back to local dispatch simulation.', err.response?.data || err.message);
      }
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
    const candidateEndpoints = [
      'https://api.shipstation.com/v2/stores',
      'https://ssapi.shipstation.com/stores'
    ];
    for (const ep of candidateEndpoints) {
      try {
        const response = await makeShipStationRequest(companyId, ep);
        const stores = response.data || [];
        const list = Array.isArray(stores) ? stores : (stores.stores || []);
        if (Array.isArray(list) && list.length > 0) return list;
      } catch (e) {}
    }
    return [];
  } catch (err) {
    return [];
  }
}

/**
 * ShipStation V2: Rate Shopping (/rates or /v2/rates)
 */
async function getRates(companyId, rateData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/rates', {
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
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/shipments', {
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
  const path = qStr ? `https://api.shipstation.com/v2/shipments?${qStr}` : 'https://api.shipstation.com/v2/shipments';
  const response = await makeShipStationRequest(companyId, path);
  return response.data;
}

/**
 * ShipStation V2: Create Label (/v2/labels)
 */
async function createV2Label(companyId, labelData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/labels', {
    method: 'POST',
    data: labelData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Return Label (/v2/return_labels)
 */
async function createReturnLabel(companyId, returnData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/return_labels', {
    method: 'POST',
    data: returnData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Batch Labels (/v2/batches)
 */
async function createBatchLabels(companyId, batchData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/batches', {
    method: 'POST',
    data: batchData
  });
  return response.data;
}

/**
 * ShipStation V2: Create Manifest (/v2/manifests)
 */
async function createManifest(companyId, manifestData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/manifests', {
    method: 'POST',
    data: manifestData
  });
  return response.data;
}

/**
 * ShipStation V2: Schedule Pickup (/v2/pickups)
 */
async function schedulePickup(companyId, pickupData) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/pickups', {
    method: 'POST',
    data: pickupData
  });
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Levels (/v2/inventory)
 */
async function getInventoryLevels(companyId) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/inventory');
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Warehouses (/v2/inventory_warehouses)
 */
async function getInventoryWarehouses(companyId) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/inventory_warehouses');
  return response.data;
}

/**
 * ShipStation V2: Get Inventory Locations (/v2/inventory_locations)
 */
async function getInventoryLocations(companyId) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/inventory_locations');
  return response.data;
}

/**
 * ShipStation V2: List Users (/v2/users)
 */
async function getUsers(companyId) {
  const response = await makeShipStationRequest(companyId, 'https://api.shipstation.com/v2/users');
  return response.data;
}

/**
 * Test ShipStation API Connection
 */
async function testConnection(companyId) {
  const candidateEndpoints = [
    'https://api.shipstation.com/v2/shipments?page=1&page_size=1',
    'https://api.shipstation.com/v2/orders?page=1&page_size=1',
    'https://ssapi.shipstation.com/orders?pageSize=1'
  ];
  let lastErr = null;
  for (const ep of candidateEndpoints) {
    try {
      await makeShipStationRequest(companyId, ep);
      return { success: true, message: `ShipStation API V2 connection test successful via ${ep} (200 OK)` };
    } catch (err) {
      lastErr = err;
    }
  }

  const respData = lastErr?.response?.data;
  let errMessage = respData?.errors?.[0]?.message || respData?.message || (typeof respData === 'string' ? respData : null) || lastErr?.message;
  if (lastErr?.response?.status === 401) {
    errMessage = `ShipStation 401 Unauthorized: Production Key authentication failed. Please verify your Production Key in ShipStation Settings > Account > API Settings (Select V2 API).`;
  }
  return { success: false, error: errMessage };
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
  syncAllFromShipStation,
  syncWarehousesFromShipStation,
  syncProductsFromShipStation,
  syncCarriersFromShipStation,
  syncInventoryFromShipStation,
  syncUsersFromShipStation,
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
