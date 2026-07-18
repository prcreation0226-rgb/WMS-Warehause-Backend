const { Product, Category, ProductStock, Warehouse, Company, Supplier, InventoryAdjustment, CycleCount, Batch, Movement, Customer, InventoryLog, Inventory, Location, Zone, sequelize } = require('../models');
const { Op, Sequelize } = require('sequelize');

/** Ensure product JSON fields from API are proper objects/arrays (e.g. SQLite may return strings) */
function normalizeProductJson(p) {
  if (!p) return p;
  const out = typeof p.get === 'function' ? p.get({ plain: true }) : { ...p };
  if (typeof out.cartons === 'string') {
    try { out.cartons = JSON.parse(out.cartons); } catch (_) { out.cartons = null; }
  }
  // Handle legacy single-object carton format
  if (out.cartons != null && !Array.isArray(out.cartons) && typeof out.cartons === 'object') {
    out.cartons = [out.cartons];
  }
  if (out.cartons != null && !Array.isArray(out.cartons)) out.cartons = null;
  if (typeof out.supplierProducts === 'string') {
    try { out.supplierProducts = JSON.parse(out.supplierProducts); } catch (_) { out.supplierProducts = null; }
  }
  if (out.supplierProducts != null && !Array.isArray(out.supplierProducts)) out.supplierProducts = null;
  if (typeof out.marketplaceSkus === 'string') {
    try { out.marketplaceSkus = JSON.parse(out.marketplaceSkus); } catch (_) { out.marketplaceSkus = {}; }
  }
  if (out.marketplaceSkus == null || typeof out.marketplaceSkus !== 'object') out.marketplaceSkus = {};
  if (Array.isArray(out.marketplaceSkus)) out.marketplaceSkus = {};
  // Coerce dimension/weight to number so frontend always gets consistent types
  if (out.length != null && out.length !== '') out.length = Number(out.length);
  if (out.width != null && out.width !== '') out.width = Number(out.width);
  if (out.height != null && out.height !== '') out.height = Number(out.height);
  if (out.weight != null && out.weight !== '') out.weight = Number(out.weight);
  if (typeof out.images === 'string') {
    try {
      out.images = JSON.parse(out.images);
    } catch (_) {
      // If it's not JSON, treat it as a comma-separated string or a single URL
      if (out.images.trim()) {
        out.images = out.images.split(',').map(u => u.trim()).filter(Boolean);
      } else {
        out.images = null;
      }
    }
  }
  if (typeof out.priceLists === 'string') {
    try { out.priceLists = JSON.parse(out.priceLists); } catch (_) { out.priceLists = null; }
  }
  if (typeof out.alternativeSkus === 'string') {
    try { out.alternativeSkus = JSON.parse(out.alternativeSkus); } catch (_) { out.alternativeSkus = null; }
  }
  if (out.alternativeSkus != null && !Array.isArray(out.alternativeSkus)) out.alternativeSkus = null;
  return out;
}

function isTruthyYes(value) {
  const normalized = String(value == null ? '' : value).trim().toLowerCase();
  return normalized === 'yes' || normalized === 'true' || normalized === '1';
}

async function validateHeatSensitivePlacement({ product, locationId, actionLabel }) {
  if (!locationId || !isTruthyYes(product?.heatSensitive)) return;
  const location = await Location.findByPk(locationId);
  if (!location) throw new Error('Location not found');
  if (!isTruthyYes(location.heatSensitive)) {
    throw new Error(`Heat-sensitive product can only be ${actionLabel} to heat-sensitive locations`);
  }
}

async function scanBarcode(reqUser, barcode) {
  if (!barcode) throw new Error('Invalid barcode');
  const cleanBarcode = barcode.trim();
  const lowerBarcode = cleanBarcode.toLowerCase();

  // 1. Try direct product match (exact case-insensitive match on sku, barcode, or name)
  const directWhere = {
    [Op.or]: [
      { sku: { [Op.like]: cleanBarcode } },
      { barcode: { [Op.like]: cleanBarcode } },
      { name: { [Op.like]: cleanBarcode } }
    ]
  };

  if (reqUser.role !== 'super_admin') {
    directWhere.companyId = reqUser.companyId;
  }
  if (reqUser.clientId) {
    directWhere.clientId = reqUser.clientId;
  }

  const product = await Product.findOne({
    where: directWhere,
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
      { association: 'Client', attributes: ['id', 'name', 'code'] },
      {
        association: 'ProductStocks',
        include: [
          { association: 'Warehouse' },
          { association: 'Location' }
        ]
      },
      { association: 'Batches' }
    ]
  });

  if (product) {
    const normalized = normalizeProductJson(product);
    return { ...normalized, type: 'product', quantity: 1 };
  }

  // 2. Search in cartons JSON for exact match of carton barcode
  const compWhere = {};
  if (reqUser.role !== 'super_admin') {
    compWhere.companyId = reqUser.companyId;
  }
  if (reqUser.clientId) {
    compWhere.clientId = reqUser.clientId;
  }
  const allProducts = await Product.findAll({ where: compWhere });

  for (const p of allProducts) {
    const normalizedP = normalizeProductJson(p);
    const cartons = normalizedP.cartons;
    if (Array.isArray(cartons)) {
      const match = cartons.find(c => String(c.barcode || '').trim().toLowerCase() === lowerBarcode);
      if (match) {
        const fullProduct = await Product.findByPk(p.id, {
          include: [
            { association: 'Category' },
            { association: 'Company', attributes: ['id', 'name', 'code'] },
            { association: 'Supplier', attributes: ['id', 'name', 'code'] },
            { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
            { association: 'Client', attributes: ['id', 'name', 'code'] },
            {
              association: 'ProductStocks',
              include: [
                { association: 'Warehouse' },
                { association: 'Location' }
              ]
            },
            { association: 'Batches' }
          ]
        });
        const normalizedFull = normalizeProductJson(fullProduct);
        const qty = match.quantity ?? match.caseSize ?? match.unitsPerCarton ?? 1;
        return {
          ...normalizedFull,
          type: 'carton',
          quantity: Math.max(1, Number(qty) || 1)
        };
      }
    }
  }

  // 3. Fallback to partial/fuzzy match (case-insensitive) on SKU, barcode, or name
  const partialWhere = {
    [Op.or]: [
      { sku: { [Op.like]: `%${cleanBarcode}%` } },
      { barcode: { [Op.like]: `%${cleanBarcode}%` } },
      { name: { [Op.like]: `%${cleanBarcode}%` } }
    ]
  };
  if (reqUser.role !== 'super_admin') {
    partialWhere.companyId = reqUser.companyId;
  }
  if (reqUser.clientId) {
    partialWhere.clientId = reqUser.clientId;
  }

  const partialProduct = await Product.findOne({
    where: partialWhere,
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
      { association: 'Client', attributes: ['id', 'name', 'code'] },
      {
        association: 'ProductStocks',
        include: [
          { association: 'Warehouse' },
          { association: 'Location' }
        ]
      },
      { association: 'Batches' }
    ]
  });

  if (partialProduct) {
    const normalized = normalizeProductJson(partialProduct);
    return { ...normalized, type: 'product', quantity: 1 };
  }

  // 4. Fallback to partial match on carton barcode
  for (const p of allProducts) {
    const normalizedP = normalizeProductJson(p);
    const cartons = normalizedP.cartons;
    if (Array.isArray(cartons)) {
      const match = cartons.find(c => String(c.barcode || '').trim().toLowerCase().includes(lowerBarcode));
      if (match) {
        const fullProduct = await Product.findByPk(p.id, {
          include: [
            { association: 'Category' },
            { association: 'Company', attributes: ['id', 'name', 'code'] },
            { association: 'Supplier', attributes: ['id', 'name', 'code'] },
            { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
            { association: 'Client', attributes: ['id', 'name', 'code'] },
            {
              association: 'ProductStocks',
              include: [
                { association: 'Warehouse' },
                { association: 'Location' }
              ]
            },
            { association: 'Batches' }
          ]
        });
        const normalizedFull = normalizeProductJson(fullProduct);
        const qty = match.quantity ?? match.caseSize ?? match.unitsPerCarton ?? 1;
        return {
          ...normalizedFull,
          type: 'carton',
          quantity: Math.max(1, Number(qty) || 1)
        };
      }
    }
  }

  throw new Error('Barcode not found');
}

async function listProducts(reqUser, query = {}) {
  // Dynamic Hot-Backfill: Check if any products have null clientId and backfill them
  try {
    const nullClientProducts = await Product.findAll({ where: { clientId: null } });
    if (nullClientProducts.length > 0) {
      console.log(`[HOT-BACKFILL] Backfilling clientId for ${nullClientProducts.length} legacy products...`);
      let defaultClient = await Customer.findOne({ where: { companyId: nullClientProducts[0].companyId } });
      if (!defaultClient) {
        defaultClient = await Customer.create({
          companyId: nullClientProducts[0].companyId,
          name: 'Default Client',
          code: 'DFTCL',
          status: 'ACTIVE'
        });
      }
      for (const p of nullClientProducts) {
        await p.update({ clientId: defaultClient.id });
      }
      console.log('[HOT-BACKFILL] Product clientId backfill complete.');
    }
  } catch (e) {
    console.warn('[HOT-BACKFILL] Failed to backfill product clientId:', e.message);
  }

  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  else if (query.companyId) where.companyId = query.companyId;

  if (reqUser.clientId) {
    where.clientId = reqUser.clientId;
  } else if (query.clientId) {
    where.clientId = query.clientId;
  }

  if (query.categoryId) where.categoryId = query.categoryId;
  if (query.supplierId) {
    where[Op.or] = [
      { supplierId: query.supplierId },
      { '$SupplierProducts.supplier_id$': query.supplierId }
    ];
  }
  if (query.status) where.status = query.status;
  if (query.search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${query.search}%` } },
      { sku: { [Op.like]: `%${query.search}%` } },
      { barcode: { [Op.like]: `%${query.search}%` } },
      { color: { [Op.like]: `%${query.search}%` } },
      Sequelize.where(
        Sequelize.cast(Sequelize.col('Product.cartons'), 'CHAR'),
        { [Op.like]: `%${query.search}%` }
      )
    ];
  }
  const products = await Product.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'Category', attributes: ['id', 'name', 'code'], required: false },
      { association: 'Company', attributes: ['id', 'name', 'code'], required: false },
      { association: 'Client', attributes: ['id', 'name', 'code'], required: false },
      {
        association: 'ProductStocks',
        attributes: ['id', 'quantity', 'reserved', 'warehouseId', 'locationId', 'clientId', 'bestBeforeDate', 'batchNumber', 'serialNumber', 'lotNumber', 'status', 'updatedAt'],
        required: false,
        include: [
          { association: 'Warehouse', attributes: ['id', 'name'], required: false },
          { association: 'Location', attributes: ['id', 'name', 'code'], required: false },
          { association: 'Client', attributes: ['id', 'name', 'code'], required: false }
        ]
      },
      {
        association: 'SupplierProducts',
        required: false,
        where: query.supplierId ? { supplierId: query.supplierId } : undefined
      },
      { association: 'Supplier', attributes: ['id', 'name'], required: false },
      { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'], required: false }
    ],
    subQuery: false, // Required when using Op.or with includes
  });
  return products;
}

async function exportProductsCsv(reqUser, query = {}) {
  const products = await listProducts(reqUser, query);
  const headers = [
    'SKU', 'Product Name', 'Barcode', 'Description', 'Product Type', 'Status', 'Selling Price', 'Cost Price',
    'Category', 'Supplier', 'Client', 'Unit of Measure', 'VAT Rate', 'VAT Code', 'Customs Tariff',
    'Heat Sensitive', 'Perishable', 'Require Batch Tracking', 'Shelf Life Days',
    'Reorder Level', 'Reorder Qty', 'Max Stock',
    'Length', 'Width', 'Height', 'Dimension Unit', 'Weight', 'Weight Unit',
    'Pack Size', 'Image URL', 'BB Warning Period (Days)',
    'Default Picking Location', 'Discontinued',
    'Carton Barcode', 'Carton Case Size', 'Carton Description',
    'HD SKU', 'HD Sale SKU', 'Warehouse ID', 'eBay ID', 'Amazon SKU', 'Amazon SKU Split Before', 'Amazon MPN SKU', 'Amazon ID SKU'
  ];

  const rows = products.map(p => {
    // Normalize the Sequelize instance so JSON fields (cartons, marketplaceSkus, images)
    // are always proper objects/arrays, not raw strings from the DB driver.
    const prod = normalizeProductJson(p);
    const rawCost = prod.costPrice != null ? Number(prod.costPrice) : 0;
    const packSize = prod.packSize || 1;
    const supplierCost = rawCost * packSize;

    // normalizeProductJson calls p.get({ plain: true }) which includes all associations
    const pickingLoc = prod.DefaultPickingLocation;

    return [
      prod.sku,
      prod.name,
      prod.barcode || '',
      prod.description || '',
      prod.productType || 'SIMPLE',
      prod.status || 'ACTIVE',
      prod.price ?? 0,
      supplierCost,
      prod.Category?.name || '',
      prod.Supplier?.name || '',
      prod.Client?.name || '',
      prod.unitOfMeasure || 'EACH',
      prod.vatRate ?? '',
      prod.vatCode || '',
      prod.customsTariff || '',
      prod.heatSensitive || 'no',
      prod.perishable || 'no',
      prod.requireBatchTracking || 'no',
      prod.shelfLifeDays ?? '',
      prod.reorderLevel ?? 0,
      prod.reorderQty ?? '',
      prod.maxStock ?? '',
      prod.length ?? '',
      prod.width ?? '',
      prod.height ?? '',
      prod.dimensionUnit || 'cm',
      prod.weight ?? '',
      prod.weightUnit || 'kg',
      prod.packSize ?? 1,
      Array.isArray(prod.images) ? prod.images.join(',') : (prod.images || ''),
      prod.bestBeforeDateWarningPeriodDays ?? 0,
      pickingLoc?.code || pickingLoc?.name || '',
      prod.isDiscontinued ? 'yes' : 'no',
      (Array.isArray(prod.cartons) && prod.cartons[0]?.barcode) || '',
      (Array.isArray(prod.cartons) && prod.cartons[0]?.caseSize) || '',
      (Array.isArray(prod.cartons) && prod.cartons[0]?.description) || '',
      prod.marketplaceSkus?.hdSku || '',
      prod.marketplaceSkus?.hdSaleSku || '',
      prod.marketplaceSkus?.warehouseId || '',
      prod.marketplaceSkus?.ebayId || '',
      prod.marketplaceSkus?.amazonSku || '',
      prod.marketplaceSkus?.amazonSkuSplitBefore || '',
      prod.marketplaceSkus?.amazonMpnSku || '',
      prod.marketplaceSkus?.amazonIdSku || ''
    ];
  });

  const toCsvCell = (v) => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };

  const csvContent = [
    headers.join(','),
    ...rows.map(line => line.map(toCsvCell).join(','))
  ].join('\n');

  return csvContent;
}

async function listCategories(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  else if (query.companyId) where.companyId = query.companyId;
  const categories = await Category.findAll({
    where,
    order: [['name']],
    include: [{ association: 'Products', attributes: ['id'], required: false }],
  });
  return categories.map(c => {
    const j = c.toJSON();
    j.productCount = (j.Products && j.Products.length) || 0;
    delete j.Products;
    return j;
  });
}

async function getProductById(id, reqUser) {
  const product = await Product.findByPk(id, {
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'ProductStocks', include: [{ association: 'Warehouse' }, { association: 'Location' }] },
      { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
      { association: 'Client', attributes: ['id', 'name', 'code'] },
    ],
  });
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');
  return normalizeProductJson(product);
}

async function createProduct(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager') {
    throw new Error('Not allowed to create product');
  }

  const clientId = data.clientId || null;
  if (!clientId) throw new Error('Client/Owner is required');

  const client = await Customer.findByPk(clientId);
  if (!client) throw new Error('Selected client not found');
  const companyId = client.companyId;
  if (!companyId) throw new Error('Company not found for the selected client');

  const existing = await Product.findOne({ where: { companyId, clientId, sku: data.sku.trim() } });
  if (existing) throw new Error('SKU already exists for this client');
  const packSize = data.packSize != null ? Number(data.packSize) : 1;
  const rawCost = data.costPrice != null ? Number(data.costPrice) : 0;
  // We store costPrice as unit cost in the database
  const unitCost = packSize > 0 ? (rawCost / packSize) : rawCost;

  const payload = {
    companyId,
    clientId,
    categoryId: data.categoryId || null,
    supplierId: data.supplierId || null,
    name: data.name,
    sku: data.sku.trim(),
    barcode: data.barcode || null,
    description: data.description || null,
    color: data.color || null,
    productType: data.productType || null,
    unitOfMeasure: data.unitOfMeasure || null,
    price: data.price ?? 0,
    costPrice: unitCost,
    packSize: packSize,
    vatRate: data.vatRate != null ? data.vatRate : null,
    vatCode: data.vatCode || null,
    customsTariff: data.customsTariff != null ? String(data.customsTariff) : null,
    marketplaceSkus: data.marketplaceSkus && typeof data.marketplaceSkus === 'object' ? data.marketplaceSkus : null,
    heatSensitive: data.heatSensitive || null,
    perishable: data.perishable || null,
    requireBatchTracking: data.requireBatchTracking || null,
    shelfLifeDays: data.shelfLifeDays != null ? data.shelfLifeDays : null,
    length: data.length != null ? data.length : null,
    width: data.width != null ? data.width : null,
    height: data.height != null ? data.height : null,
    dimensionUnit: data.dimensionUnit || null,
    weight: data.weight != null ? data.weight : null,
    weightUnit: data.weightUnit || null,
    reorderLevel: data.reorderLevel ?? 0,
    reorderQty: data.reorderQty != null ? data.reorderQty : null,
    maxStock: data.maxStock != null ? data.maxStock : null,
    status: data.status || 'ACTIVE',
    images: (function () {
      if (Array.isArray(data.images)) return data.images;
      if (typeof data.images === 'string' && data.images.trim()) {
        return data.images.split(',').map(u => u.trim()).filter(Boolean);
      }
      return null;
    })(),
    cartons: Array.isArray(data.cartons) && data.cartons.length > 0 ? data.cartons : null,
    priceLists: data.priceLists && typeof data.priceLists === 'object' ? data.priceLists : null,
    supplierProducts: Array.isArray(data.supplierProducts) ? data.supplierProducts : null,
    alternativeSkus: Array.isArray(data.alternativeSkus) ? data.alternativeSkus : null,
    bestBeforeDateWarningPeriodDays: data.bestBeforeDateWarningPeriodDays != null ? Number(data.bestBeforeDateWarningPeriodDays) : 0,
    defaultPickingLocationId: data.defaultPickingLocationId || null,
    isDiscontinued: (function () {
      if (data.isDiscontinued != null) {
        const val = String(data.isDiscontinued).toLowerCase().trim();
        return val === 'yes' || val === 'true' || val === '1';
      }
      return false;
    })(),
  };
  console.log('[DEBUG_SERVICE] Creating Product Payload:', JSON.stringify(payload, null, 2));
  const created = await Product.create(payload);
  return normalizeProductJson(created);
}

async function bulkCreateProducts(productsArray, reqUser, explicitCompanyId) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager') {
    throw new Error('Not allowed to import products');
  }
  const companyId = reqUser.companyId || explicitCompanyId;
  if (!companyId) throw new Error('Company required');
  if (!Array.isArray(productsArray) || productsArray.length === 0) {
    throw new Error('No products to import');
  }
  const results = { created: 0, skipped: 0, errors: [] };

  // Cache categories for this company to reduce DB calls and handle case-insensitive matching
  const existingCategories = await Category.findAll({ where: { companyId } });
  const categoryMap = new Map(); // lowercase name -> ID
  const categoryIdSet = new Set();
  existingCategories.forEach(c => {
    categoryMap.set(c.name.toLowerCase().trim(), c.id);
    categoryIdSet.add(c.id);
  });
  console.log(`[BULK_IMPORT] CompanyId=${companyId} Found ${existingCategories.length} existing categories.`);

  // Cache suppliers for this company
  const existingSuppliers = await Supplier.findAll({ where: { companyId } });
  const supplierMap = new Map(); // lowercase name -> ID
  const supplierIdSet = new Set();
  existingSuppliers.forEach(s => {
    supplierMap.set(s.name.toLowerCase().trim(), s.id);
    supplierIdSet.add(s.id);
  });
  console.log(`[BULK_IMPORT] CompanyId=${companyId} Found ${existingSuppliers.length} existing suppliers.`);

  // Cache clients (customers) for this company
  const existingClients = await Customer.findAll({ where: { companyId } });
  const clientMap = new Map(); // lowercase name/code -> ID
  const clientIdSet = new Set();
  existingClients.forEach(c => {
    clientMap.set(c.name.toLowerCase().trim(), c.id);
    if (c.code) {
      clientMap.set(c.code.toLowerCase().trim(), c.id);
    }
    clientIdSet.add(c.id);
  });
  console.log(`[BULK_IMPORT] CompanyId=${companyId} Found ${existingClients.length} existing clients.`);

  for (let i = 0; i < productsArray.length; i++) {
    const data = productsArray[i];
    try {
      if (!data || !data.sku || !data.name) {
        results.skipped++;
        results.errors.push({ row: i + 1, message: 'SKU and Product Name required' });
        continue;
      }

      // Resolve clientId (ID, Name, or Code)
      let resolvedClientId = null;
      const clientInput = data.client != null ? String(data.client).trim() : (data.clientId != null ? String(data.clientId).trim() : null);
      if (clientInput !== null && clientInput !== '') {
        if (!isNaN(clientInput) && clientIdSet.has(Number(clientInput))) {
          resolvedClientId = Number(clientInput);
        } else {
          const lowerClient = clientInput.toLowerCase();
          if (clientMap.has(lowerClient)) {
            resolvedClientId = clientMap.get(lowerClient);
          } else {
            throw new Error(`Client/Owner "${clientInput}" not found`);
          }
        }
      } else {
        if (existingClients.length === 1) {
          resolvedClientId = existingClients[0].id;
        } else {
          throw new Error('Client/Owner is required');
        }
      }

      const clientRecord = await Customer.findByPk(resolvedClientId);
      if (!clientRecord) throw new Error('Resolved client not found');
      const resolvedCompanyId = clientRecord.companyId;
      if (!resolvedCompanyId) throw new Error('Company not found for the client');

      const existing = await Product.findOne({ where: { companyId: resolvedCompanyId, clientId: resolvedClientId, sku: String(data.sku).trim() } });

      // Resolve categoryId (ID or Name)
      let resolvedCategoryId = null;
      const catInput = data.category != null ? String(data.category).trim() : (data.categoryId != null ? String(data.categoryId).trim() : null);
      if (catInput !== null && catInput !== '') {
        // If it's a numeric ID that already exists
        if (!isNaN(catInput) && categoryIdSet.has(Number(catInput))) {
          resolvedCategoryId = Number(catInput);
          console.log(`[BULK_IMPORT] Row ${i + 1}: Matched numeric ID ${resolvedCategoryId}`);
        } else {
          // Treat as Name
          const lowerName = catInput.toLowerCase();
          if (categoryMap.has(lowerName)) {
            resolvedCategoryId = categoryMap.get(lowerName);
            console.log(`[BULK_IMPORT] Row ${i + 1}: Matched category name "${catInput}" to ID ${resolvedCategoryId}`);
          } else {
            console.log(`[BULK_IMPORT] Row ${i + 1}: Category "${catInput}" NOT found. Creating...`);
            // Auto-create category
            const newCat = await Category.create({
              companyId: resolvedCompanyId,
              name: catInput,
              code: catInput.replace(/\s/g, '_').toUpperCase().slice(0, 50)
            });
            resolvedCategoryId = newCat.id;
            categoryMap.set(lowerName, resolvedCategoryId);
            categoryIdSet.add(resolvedCategoryId);
            console.log(`[BULK_IMPORT] Row ${i + 1}: Created new category "${catInput}" with ID ${resolvedCategoryId}`);
          }
        }
      }

      // Resolve supplierId (ID or Name)
      let resolvedSupplierId = null;
      const supInput = data.supplier != null ? String(data.supplier).trim() : (data.supplierId != null ? String(data.supplierId).trim() : null);
      if (supInput !== null && supInput !== '') {
        if (!isNaN(supInput) && supplierIdSet.has(Number(supInput))) {
          resolvedSupplierId = Number(supInput);
        } else {
          const lowerSup = supInput.toLowerCase();
          if (supplierMap.has(lowerSup)) {
            resolvedSupplierId = supplierMap.get(lowerSup);
          } else {
            console.log(`[BULK_IMPORT] Row ${i + 1}: Supplier "${supInput}" NOT found. Creating...`);
            const newSup = await Supplier.create({
              companyId: resolvedCompanyId,
              name: supInput,
              code: supInput.replace(/\s/g, '_').toUpperCase().slice(0, 50)
            });
            resolvedSupplierId = newSup.id;
            supplierMap.set(lowerSup, resolvedSupplierId);
            supplierIdSet.add(resolvedSupplierId);
          }
        }
      }

      // Resolve defaultPickingLocationId
      let resolvedDefaultPickingLocationId = null;
      const defaultLocInput = data.defaultPickingLocation != null ? String(data.defaultPickingLocation).trim() : null;
      if (defaultLocInput !== null && defaultLocInput !== '') {
        const foundLoc = await Location.findOne({
          where: {
            [Op.or]: [
              { code: defaultLocInput },
              { name: defaultLocInput }
            ]
          }
        });
        if (foundLoc) {
          const zone = await Zone.findByPk(foundLoc.zoneId);
          if (zone && zone.companyId === resolvedCompanyId) {
            resolvedDefaultPickingLocationId = foundLoc.id;
          } else {
            console.log(`[BULK_IMPORT] Row ${i + 1}: Default picking location "${defaultLocInput}" does not belong to the resolved company.`);
            resolvedDefaultPickingLocationId = null;
          }
        } else {
          console.log(`[BULK_IMPORT] Row ${i + 1}: Default picking location "${defaultLocInput}" not found.`);
          resolvedDefaultPickingLocationId = null;
        }
      } else if (data.defaultPickingLocation === '') {
        resolvedDefaultPickingLocationId = null;
      } else {
        resolvedDefaultPickingLocationId = existing ? existing.defaultPickingLocationId : null;
      }

      const productData = {
        companyId: resolvedCompanyId,
        clientId: resolvedClientId,
        categoryId: resolvedCategoryId,
        supplierId: resolvedSupplierId,
        name: String(data.name).trim(),
        sku: String(data.sku).trim(),
        barcode: data.barcode ? String(data.barcode).trim() : (existing ? existing.barcode : null),
        description: data.description ? String(data.description).trim() : (existing ? existing.description : null),
        color: data.color ? String(data.color).trim() : (existing ? existing.color : null),
        productType: data.productType || (existing ? existing.productType : 'SIMPLE'),
        unitOfMeasure: data.unitOfMeasure || (existing ? existing.unitOfMeasure : 'EACH'),
        price: data.price != null ? Number(data.price) : (existing ? existing.price : 0),
        costPrice: (function () {
          if (data.costPrice != null) {
            const supplierCost = Number(data.costPrice) || 0;
            const packSize = data.packSize != null ? Number(data.packSize) : 1;
            return packSize > 0 ? (supplierCost / packSize) : supplierCost;
          }
          return existing ? existing.costPrice : 0;
        })(),
        packSize: data.packSize != null ? Number(data.packSize) : (existing ? existing.packSize : 1),
        vatRate: data.vatRate != null ? Number(data.vatRate) : (existing ? existing.vatRate : null),
        vatCode: data.vatCode || (existing ? existing.vatCode : null),
        customsTariff: data.customsTariff != null ? String(data.customsTariff) : (existing ? existing.customsTariff : null),
        marketplaceSkus: (data.marketplaceSkus && typeof data.marketplaceSkus === 'object') ? data.marketplaceSkus : (existing ? existing.marketplaceSkus : null),
        heatSensitive: data.heatSensitive || (existing ? existing.heatSensitive : null),
        perishable: data.perishable || (existing ? existing.perishable : null),
        requireBatchTracking: data.requireBatchTracking || (existing ? existing.requireBatchTracking : null),
        shelfLifeDays: data.shelfLifeDays != null ? Number(data.shelfLifeDays) : (existing ? existing.shelfLifeDays : null),
        length: data.length != null ? Number(data.length) : (existing ? existing.length : null),
        width: data.width != null ? Number(data.width) : (existing ? existing.width : null),
        height: data.height != null ? Number(data.height) : (existing ? existing.height : null),
        dimensionUnit: data.dimensionUnit || (existing ? existing.dimensionUnit : null),
        weight: data.weight != null ? Number(data.weight) : (existing ? existing.weight : null),
        weightUnit: data.weightUnit || (existing ? existing.weightUnit : null),
        reorderLevel: data.reorderLevel != null ? Number(data.reorderLevel) : (existing ? existing.reorderLevel : 0),
        reorderQty: data.reorderQty != null ? Number(data.reorderQty) : (existing ? existing.reorderQty : null),
        maxStock: data.maxStock != null ? Number(data.maxStock) : (existing ? existing.maxStock : null),
        status: data.status && String(data.status).toUpperCase() === 'INACTIVE' ? 'INACTIVE' : (existing ? existing.status : 'ACTIVE'),
        images: (function () {
          if (Array.isArray(data.images)) return data.images;
          if (typeof data.images === 'string' && data.images.trim()) {
            return data.images.split(',').map(u => u.trim()).filter(Boolean);
          }
          return existing ? existing.images : null;
        })(),
        cartons: Array.isArray(data.cartons) && data.cartons.length > 0 ? data.cartons : (existing ? existing.cartons : null),
        priceLists: (data.priceLists && typeof data.priceLists === 'object') ? data.priceLists : (existing ? existing.priceLists : null),
        supplierProducts: Array.isArray(data.supplierProducts) ? data.supplierProducts : (existing ? existing.supplierProducts : null),
        alternativeSkus: Array.isArray(data.alternativeSkus) ? data.alternativeSkus : (existing ? existing.alternativeSkus : null),
        bestBeforeDateWarningPeriodDays: data.bestBeforeDateWarningPeriodDays != null ? Number(data.bestBeforeDateWarningPeriodDays) : (existing ? existing.bestBeforeDateWarningPeriodDays : 0),
        defaultPickingLocationId: resolvedDefaultPickingLocationId,
        isDiscontinued: (function () {
          if (data.discontinued != null) {
            const val = String(data.discontinued).toLowerCase().trim();
            return val === 'yes' || val === 'true' || val === '1';
          }
          return existing ? existing.isDiscontinued : false;
        })(),
      };

      if (existing) {
        await existing.update(productData);
      } else {
        await Product.create(productData);
      }
      results.created++;
    } catch (err) {
      results.skipped++;
      results.errors.push({ row: i + 1, sku: data?.sku, message: err.message || 'Failed' });
    }
  }
  return results;
}

async function updateProduct(id, data, reqUser) {
  const product = await Product.findByPk(id);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');

  const newSku = (data.sku !== undefined) ? data.sku?.trim() : product.sku;
  const newClientId = (data.clientId !== undefined) ? (data.clientId || null) : product.clientId;

  if (!newClientId) {
    throw new Error('Client/Owner is required');
  }

  const client = await Customer.findByPk(newClientId);
  if (!client) throw new Error('Selected client not found');
  const companyId = client.companyId;
  if (!companyId) throw new Error('Company not found for the selected client');

  if (data.sku !== undefined || data.clientId !== undefined) {
    const existing = await Product.findOne({
      where: {
        companyId,
        clientId: newClientId,
        sku: newSku,
        id: { [Op.ne]: product.id }
      }
    });
    if (existing) {
      throw new Error('SKU already exists for this client');
    }
  }

  // Only update fields that are present in data (partial update) – baki data null nahi hoga
  const upd = {};
  upd.companyId = companyId; // Force correct company ID mapping dynamically
  if (data.name !== undefined) upd.name = data.name ?? product.name;
  if (data.categoryId !== undefined) upd.categoryId = data.categoryId;
  if (data.supplierId !== undefined) upd.supplierId = data.supplierId;
  if (data.clientId !== undefined) upd.clientId = data.clientId || null;
  if (data.sku !== undefined) upd.sku = data.sku?.trim() ?? product.sku;
  if (data.barcode !== undefined) upd.barcode = data.barcode;
  if (data.description !== undefined) upd.description = data.description;
  if (data.color !== undefined) {
    console.log(`[DEBUG_SERVICE] Updating color to: "${data.color}"`);
    upd.color = data.color;
  }
  if (data.productType !== undefined) upd.productType = data.productType;
  if (data.unitOfMeasure !== undefined) upd.unitOfMeasure = data.unitOfMeasure;
  if (data.price !== undefined) upd.price = data.price;
  if (data.packSize !== undefined) upd.packSize = data.packSize != null ? Number(data.packSize) : product.packSize;
  if (data.costPrice !== undefined) {
    const newPackSize = upd.packSize !== undefined ? upd.packSize : product.packSize;
    const rawCost = Number(data.costPrice) || 0;
    upd.costPrice = newPackSize > 0 ? (rawCost / newPackSize) : rawCost;
  }
  if (data.vatRate !== undefined) upd.vatRate = data.vatRate;
  if (data.vatCode !== undefined) upd.vatCode = data.vatCode;
  if (data.customsTariff !== undefined) upd.customsTariff = data.customsTariff != null ? String(data.customsTariff) : null;
  if (data.marketplaceSkus !== undefined) upd.marketplaceSkus = data.marketplaceSkus && typeof data.marketplaceSkus === 'object' ? data.marketplaceSkus : product.marketplaceSkus;
  if (data.heatSensitive !== undefined) upd.heatSensitive = data.heatSensitive;
  if (data.perishable !== undefined) upd.perishable = data.perishable;
  if (data.requireBatchTracking !== undefined) upd.requireBatchTracking = data.requireBatchTracking;
  if (data.shelfLifeDays !== undefined) upd.shelfLifeDays = data.shelfLifeDays;
  if (data.length !== undefined) upd.length = data.length;
  if (data.width !== undefined) upd.width = data.width;
  if (data.height !== undefined) upd.height = data.height;
  if (data.dimensionUnit !== undefined) upd.dimensionUnit = data.dimensionUnit;
  if (data.weight !== undefined) upd.weight = data.weight;
  if (data.weightUnit !== undefined) upd.weightUnit = data.weightUnit;
  if (data.reorderLevel !== undefined) upd.reorderLevel = data.reorderLevel;
  if (data.reorderQty !== undefined) upd.reorderQty = data.reorderQty;
  if (data.maxStock !== undefined) upd.maxStock = data.maxStock;
  if (data.status !== undefined) upd.status = data.status ?? product.status;
  if (data.images !== undefined) {
    if (Array.isArray(data.images)) {
      upd.images = data.images;
    } else if (typeof data.images === 'string') {
      upd.images = data.images.trim() ? data.images.split(',').map(u => u.trim()).filter(Boolean) : null;
    } else {
      upd.images = product.images;
    }
  }
  if (data.cartons !== undefined) upd.cartons = Array.isArray(data.cartons) ? data.cartons : (data.cartons && typeof data.cartons === 'object' ? data.cartons : product.cartons);
  if (data.priceLists !== undefined) upd.priceLists = data.priceLists && typeof data.priceLists === 'object' ? data.priceLists : product.priceLists;
  if (data.supplierProducts !== undefined) upd.supplierProducts = Array.isArray(data.supplierProducts) ? data.supplierProducts : product.supplierProducts;
  if (data.alternativeSkus !== undefined) upd.alternativeSkus = Array.isArray(data.alternativeSkus) ? data.alternativeSkus : product.alternativeSkus;

  if (data.bestBeforeDateWarningPeriodDays !== undefined) upd.bestBeforeDateWarningPeriodDays = data.bestBeforeDateWarningPeriodDays != null ? Number(data.bestBeforeDateWarningPeriodDays) : product.bestBeforeDateWarningPeriodDays;
  if (data.defaultPickingLocationId !== undefined) upd.defaultPickingLocationId = data.defaultPickingLocationId || null;
  if (data.isDiscontinued !== undefined) {
    if (typeof data.isDiscontinued === 'boolean') {
      upd.isDiscontinued = data.isDiscontinued;
    } else {
      const val = String(data.isDiscontinued).toLowerCase().trim();
      upd.isDiscontinued = val === 'yes' || val === 'true' || val === '1';
    }
  }

  if (Object.keys(upd).length === 0) return normalizeProductJson(product);
  console.log('[DEBUG_SERVICE] Final Update Object:', JSON.stringify(upd, null, 2));
  await product.update(upd);
  const updated = await Product.findByPk(id, {
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'ProductStocks', include: [{ association: 'Warehouse' }, { association: 'Location' }] },
      { association: 'DefaultPickingLocation', attributes: ['id', 'name', 'code'] },
    ],
  });
  return normalizeProductJson(updated || product);
}

async function addAlternativeSku(productId, payload, reqUser) {
  const product = await Product.findByPk(productId, {
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'ProductStocks', include: [{ association: 'Warehouse' }, { association: 'Location' }] },
    ],
  });
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');
  const list = Array.isArray(product.alternativeSkus) ? [...product.alternativeSkus] : [];
  const newItem = {
    id: payload.id || `alt-${Date.now()}`,
    channelType: payload.channelType || null,
    sku: payload.sku?.trim() || null,
    skuType: payload.skuType || null,
    isPrimary: !!payload.isPrimary,
    active: payload.active !== false,
    notes: payload.notes?.trim() || null,
    leadTimeDays: payload.leadTimeDays != null ? payload.leadTimeDays : null,
    moq: payload.moq != null ? payload.moq : null,
  };
  list.push(newItem);
  await product.update({ alternativeSkus: list });
  const updated = await Product.findByPk(productId, {
    include: [
      { association: 'Category' },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Supplier', attributes: ['id', 'name', 'code'] },
      { association: 'ProductStocks', include: [{ association: 'Warehouse' }, { association: 'Location' }] },
    ],
  });
  return normalizeProductJson(updated || product);
}

async function removeProduct(id, reqUser) {
  const product = await Product.findByPk(id);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');

  const {
    ProductStock,
    OrderItem,
    PurchaseOrderItem,
    GoodsReceiptItem,
    Inventory,
    InventoryLog,
    BundleItem,
    Batch,
    Movement,
    ReplenishmentTask,
    ReplenishmentConfig
  } = require('../models');

  // Check if product is in service
  const stockExists = await ProductStock.findOne({ where: { productId: id } });
  const orderExists = await OrderItem.findOne({ where: { productId: id } });
  const poExists = await PurchaseOrderItem.findOne({ where: { productId: id } });
  const grExists = await GoodsReceiptItem.findOne({ where: { productId: id } });
  const invExists = await Inventory.findOne({ where: { productId: id } });
  const logExists = await InventoryLog.findOne({ where: { productId: id } });
  const bundleExists = await BundleItem.findOne({ where: { productId: id } });
  const batchExists = await Batch.findOne({ where: { productId: id } });
  const movementExists = await Movement.findOne({ where: { productId: id } });
  const repTaskExists = await ReplenishmentTask.findOne({ where: { productId: id } });
  const repConfigExists = await ReplenishmentConfig.findOne({ where: { productId: id } });

  if (
    stockExists ||
    orderExists ||
    poExists ||
    grExists ||
    invExists ||
    logExists ||
    bundleExists ||
    batchExists ||
    movementExists ||
    repTaskExists ||
    repConfigExists
  ) {
    throw new Error("Product is in service.");
  }

  try {
    await sequelize.transaction(async (t) => {
      await ProductStock.destroy({ where: { productId: id }, transaction: t });
      await product.destroy({ transaction: t });
    });
    return { message: 'Product deleted successfully' };
  } catch (err) {
    throw new Error("Product is in service.");
  }
}

async function createCategory(data, reqUser) {
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('companyId required');
  const code = data.code?.trim() || data.name.replace(/\s/g, '_').toUpperCase().slice(0, 50);
  const existing = await Category.findOne({ where: { companyId, code } });
  if (existing) throw new Error('Category code already exists for this company');
  return Category.create({
    companyId,
    name: data.name,
    code,
  });
}

async function updateCategory(id, data, reqUser) {
  const cat = await Category.findByPk(id);
  if (!cat) throw new Error('Category not found');
  if (reqUser.role !== 'super_admin' && cat.companyId !== reqUser.companyId) throw new Error('Category not found');
  await cat.update({
    name: data.name ?? cat.name,
    code: data.code?.trim() ?? cat.code,
  });
  return cat;
}

async function removeCategory(id, reqUser) {
  const cat = await Category.findByPk(id);
  if (!cat) throw new Error('Category not found');
  if (reqUser.role !== 'super_admin' && cat.companyId !== reqUser.companyId) throw new Error('Category not found');
  await cat.destroy();
  return { message: 'Category deleted' };
}

async function listStock(reqUser, query = {}) {
  const { ProductStock, OrderItem, SalesOrder, Product, Warehouse, Customer } = require('../models');
  const { Op } = require('sequelize');

  const where = {};
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    where.companyId = reqUser.companyId;
  }
  // Enforce client-level visibility
  if (reqUser.clientId) {
    where.clientId = reqUser.clientId;
  } else if (query.clientId) {
    where.clientId = query.clientId;
  }

  if (query.warehouseId) where.warehouseId = query.warehouseId;
  if (query.productId) where.productId = query.productId;
  if (query.locationId) where.locationId = query.locationId;
  if (query.batchNumber) where.batchNumber = query.batchNumber;

  const stocks = await ProductStock.findAll({
    where,
    include: [
      { association: 'Product', where: reqUser.role !== 'super_admin' ? { companyId: reqUser.companyId } : undefined, required: reqUser.role !== 'super_admin' },
      { association: 'Warehouse', include: ['Company'] },
      { association: 'Location', required: false },
      { association: 'Client', attributes: ['id', 'name', 'code'], required: false },
    ],
  });

  // Calculate active reservations (all order items linked to active orders)
  // Only query reservations if we are not filtering down to a specific Location or Batch
  if (query.locationId || query.batchNumber) {
    return stocks;
  }

  const orderItemWhere = {};
  if (query.productId) orderItemWhere.productId = query.productId;
  if (query.warehouseId) orderItemWhere.warehouseId = query.warehouseId;

  const salesOrderWhere = {
    status: { [Op.in]: ['DRAFT', 'NEW', 'CONFIRMED', 'ALLOCATED', 'PRINTED', 'PICKING_IN_PROGRESS', 'PICKING', 'PICKED', 'PACKING_IN_PROGRESS', 'PACKING', 'PACKED', 'BACKORDER'] }
  };
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    salesOrderWhere.companyId = reqUser.companyId;
  }
  if (reqUser.clientId) {
    salesOrderWhere.customerId = reqUser.clientId;
  } else if (query.clientId) {
    salesOrderWhere.customerId = query.clientId;
  }

  const activeItems = await OrderItem.findAll({
    where: orderItemWhere,
    include: [{
      model: SalesOrder,
      as: 'SalesOrder',
      where: salesOrderWhere,
      required: true
    }]
  });

  // Group active order items by productId + warehouseId
  const reservationMap = {};
  for (const item of activeItems) {
    const key = `${item.productId}-${item.warehouseId}`;
    reservationMap[key] = (reservationMap[key] || 0) + (Number(item.quantity) || 0);
  }

  // Sort physical stocks by createdAt ASC (FIFO) so oldest stock is reserved first in-memory
  stocks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Initialize and distribute reservations in memory dynamically (so it stays 100% in sync with ledger logs)
  const remainingReservations = { ...reservationMap };
  const mappedStocks = stocks.map(s => {
    const row = s.get({ plain: true });
    row.reserved = 0; // reset/rebuild in memory dynamically
    
    const key = `${row.productId}-${row.warehouseId}`;
    const qtyToDistribute = remainingReservations[key] || 0;
    if (qtyToDistribute > 0) {
      const rowReserved = Math.min(row.quantity, qtyToDistribute);
      row.reserved = rowReserved;
      remainingReservations[key] -= rowReserved;
    }
    return {
      ...row,
      toJSON() { return this; }
    };
  });

  // Find any unassigned soft-allocations (reservations exceeding physical stock rows)
  const mockStocks = [];
  for (const key of Object.keys(remainingReservations)) {
    const diff = remainingReservations[key];
    if (diff > 0) {
      const [pId, whId] = key.split('-').map(Number);

      // Fetch Product, Warehouse, Client metadata for the mock row
      const product = await Product.findByPk(pId);
      if (!product || (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId)) continue;

      const warehouse = await Warehouse.findByPk(whId, { include: ['Company'] });
      let client = null;
      if (reqUser.clientId || query.clientId) {
        client = await Customer.findByPk(reqUser.clientId || query.clientId, { attributes: ['id', 'name', 'code'] });
      } else if (product?.clientId) {
        client = await Customer.findByPk(product.clientId, { attributes: ['id', 'name', 'code'] });
      }

      mockStocks.push({
        id: `mock-${pId}-${whId}`,
        companyId: reqUser.companyId || product.companyId,
        productId: pId,
        warehouseId: whId,
        locationId: null,
        quantity: 0,
        reserved: diff,
        status: 'ACTIVE',
        Product: product,
        Warehouse: warehouse,
        Location: null,
        Client: client,
        toJSON() { return this; }
      });
    }
  }

  return mappedStocks.concat(mockStocks);
}

async function createStock(data, reqUser) {
  const { Product, ProductStock, Inventory, InventoryLog, sequelize } = require('../models');
  const product = await Product.findByPk(data.productId);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');

  const quantity = Number(data.quantity) || 0;
  if (data.warehouseId && quantity > 0) {
    const warehouseService = require('./warehouseService');
    await warehouseService.validateCapacity(data.warehouseId, quantity);
  }

  const transaction = await sequelize.transaction();
  try {
    const stockWhere = {
      productId: data.productId,
      warehouseId: data.warehouseId,
      locationId: (data.locationId && String(data.locationId).trim()) ? data.locationId : null,
      batchNumber: (data.batchNumber && String(data.batchNumber).trim()) ? data.batchNumber : null,
      bestBeforeDate: (data.bestBeforeDate && String(data.bestBeforeDate).trim()) ? data.bestBeforeDate : null,
      clientId: reqUser.clientId || data.clientId || null
    };

    let stock = await ProductStock.findOne({ where: stockWhere, transaction });

    if (stock) {
      await stock.update({
        quantity: (Number(stock.quantity) || 0) + quantity,
        reserved: (Number(stock.reserved) || 0) + (Number(data.reserved) || 0),
        status: data.status || stock.status
      }, { transaction });
    } else {
      stock = await ProductStock.create({
        companyId: reqUser.companyId || product.companyId,
        clientId: reqUser.clientId || data.clientId || null,
        productId: data.productId,
        warehouseId: data.warehouseId,
        locationId: data.locationId || null,
        quantity: quantity,
        reserved: Number(data.reserved) || 0,
        status: data.status || 'ACTIVE',
        lotNumber: data.lotNumber || null,
        batchNumber: data.batchNumber || null,
        serialNumber: data.serialNumber || null,
        bestBeforeDate: data.bestBeforeDate || null,
      }, { transaction });
    }

    // Sync Warehouse Total
    const [inv] = await Inventory.findOrCreate({
      where: { productId: data.productId, warehouseId: data.warehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction
    });
    await inv.increment('quantity', { by: quantity, transaction });

    // Create Log
    await InventoryLog.create({
      productId: data.productId,
      warehouseId: data.warehouseId,
      locationId: data.locationId || null,
      clientId: reqUser.clientId || data.clientId || null,
      type: 'IN',
      quantity,
      batchNumber: data.batchNumber || null,
      bestBeforeDate: data.bestBeforeDate || null,
      reason: 'Manual Stock Creation',
      userId: reqUser.id
    }, { transaction });

    // Re-sync reservations for this product in this warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(data.productId, data.warehouseId, transaction);

    await transaction.commit();

    return ProductStock.findByPk(stock.id, {
      include: [
        { association: 'Product' },
        { association: 'Warehouse' },
        { association: 'Location', required: false },
      ],
    });
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function updateStock(stockId, data, reqUser) {
  const stock = await ProductStock.findByPk(stockId, { include: ['Product'] });
  if (!stock) throw new Error('Stock not found');
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'company_admin') {
    throw new Error('Not allowed');
  }
  if (stock.Product.companyId !== reqUser.companyId && reqUser.role !== 'super_admin') throw new Error('Stock not found');

  const oldQty = Number(stock.quantity) || 0;
  const oldRes = Number(stock.reserved) || 0;
  const oldProductId = stock.productId;
  const oldWarehouseId = stock.warehouseId;

  const newQty = data.quantity !== undefined ? Number(data.quantity) : oldQty;
  const newRes = data.reserved !== undefined ? Number(data.reserved) : oldRes;
  const newProductId = data.productId !== undefined ? data.productId : oldProductId;
  const newWarehouseId = data.warehouseId !== undefined ? data.warehouseId : oldWarehouseId;

  if (newQty > oldQty || oldWarehouseId !== newWarehouseId) {
    const warehouseService = require('./warehouseService');
    const qtyToAdd = oldWarehouseId === newWarehouseId ? newQty - oldQty : newQty;
    await warehouseService.validateCapacity(newWarehouseId, qtyToAdd);
  }

  const transaction = await sequelize.transaction();
  try {
    if (oldProductId !== newProductId || oldWarehouseId !== newWarehouseId || oldQty !== newQty || oldRes !== newRes) {
      const { Inventory } = require('../models');

      // Decrement from old combination
      const [oldInv] = await Inventory.findOrCreate({
        where: { productId: oldProductId, warehouseId: oldWarehouseId },
        defaults: { quantity: 0, reservedQuantity: 0 },
        transaction
      });
      await oldInv.decrement({ quantity: oldQty, reservedQuantity: oldRes }, { transaction });

      // Increment to new combination
      const [newInv] = await Inventory.findOrCreate({
        where: { productId: newProductId, warehouseId: newWarehouseId },
        defaults: { quantity: 0, reservedQuantity: 0 },
        transaction
      });
      await newInv.increment({ quantity: newQty, reservedQuantity: newRes }, { transaction });
    }

    await stock.update({
      productId: newProductId,
      warehouseId: newWarehouseId,
      quantity: newQty,
      reserved: newRes,
      locationId: data.locationId !== undefined ? data.locationId : stock.locationId,
      status: data.status !== undefined ? data.status : stock.status,
      lotNumber: data.lotNumber !== undefined ? data.lotNumber : stock.lotNumber,
      batchNumber: data.batchNumber !== undefined ? data.batchNumber : stock.batchNumber,
      serialNumber: data.serialNumber !== undefined ? data.serialNumber : stock.serialNumber,
      bestBeforeDate: data.bestBeforeDate !== undefined ? data.bestBeforeDate : stock.bestBeforeDate,
    }, { transaction });

    // Re-sync reservations for the new and/or old product in the new/old warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(newProductId, newWarehouseId, transaction);
    if (oldProductId !== newProductId || oldWarehouseId !== newWarehouseId) {
      await orderService.syncReservationsForProduct(oldProductId, oldWarehouseId, transaction);
    }

    await transaction.commit();
    return stock;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function removeStock(stockId, reqUser) {
  const { ProductStock, Inventory, InventoryLog, sequelize } = require('../models');

  const transaction = await sequelize.transaction();
  try {
    const stock = await ProductStock.findByPk(stockId, {
      include: ['Product'],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!stock) throw new Error('Stock not found');
    if (reqUser.role !== 'super_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'company_admin') throw new Error('Not allowed');
    if (stock.Product && stock.Product.companyId !== reqUser.companyId && reqUser.role !== 'super_admin') throw new Error('Stock not found');

    const qty = Number(stock.quantity) || 0;
    const res = Number(stock.reserved) || 0;

    // Decrement from summary inventory
    const inv = await Inventory.findOne({
      where: { productId: stock.productId, warehouseId: stock.warehouseId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (inv) {
      if (qty > 0) await inv.decrement('quantity', { by: qty, transaction });
      if (res > 0) await inv.decrement('reservedQuantity', { by: res, transaction });
    }

    // Log the change
    if (qty > 0) {
      await InventoryLog.create({
        productId: stock.productId,
        warehouseId: stock.warehouseId,
        locationId: stock.locationId,
        clientId: stock.clientId,
        type: 'OUT',
        quantity: -qty,
        reason: 'Stock Record Deleted',
        userId: reqUser.id
      }, { transaction });
    }

    await stock.destroy({ transaction });

    // Re-sync reservations for this product in this warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(stock.productId, stock.warehouseId, transaction);

    await transaction.commit();
    return { message: 'Stock record deleted' };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function listStockByBestBeforeDate(reqUser, query = {}) {
  const where = {};
  if (query.productId) where.productId = query.productId;
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  const hasDateFilter = query.minBbd || query.maxBbd;
  if (hasDateFilter) {
    const bbdCond = [{ [Op.ne]: null }];
    if (query.minBbd) bbdCond.push({ [Op.gte]: query.minBbd });
    if (query.maxBbd) bbdCond.push({ [Op.lte]: query.maxBbd });
    where.bestBeforeDate = { [Op.and]: bbdCond };
  }
  // when no date filter: return all stock (including bestBeforeDate = null) so report shows data
  const productWhere = (reqUser.role !== 'super_admin' && reqUser.companyId) ? { companyId: reqUser.companyId } : undefined;
  const stocks = await ProductStock.findAll({
    where,
    include: [
      { association: 'Product', where: productWhere, required: !!productWhere, attributes: ['id', 'name', 'sku'] },
      { association: 'Warehouse', attributes: ['id', 'name'] },
      { association: 'Location', attributes: ['id', 'name', 'code'], required: false },
    ],
  });
  const byKey = {};
  for (const s of stocks) {
    const locName = s.Location?.code || s.Location?.name || 'Unassigned';
    const key = `${s.productId}-${s.bestBeforeDate || 'no-date'}-${s.batchNumber || 'no-batch'}-${s.warehouseId || '0'}-${s.locationId || '0'}`;
    if (!byKey[key]) {
      byKey[key] = {
        productId: s.productId,
        productName: s.Product?.name,
        productSku: s.Product?.sku,
        bestBeforeDate: s.bestBeforeDate,
        batchNumber: s.batchNumber,
        warehouseName: s.Warehouse?.name || '—',
        locationName: locName,
        totalAvailable: 0,
        bbdCount: 0,
      };
    }
    byKey[key].totalAvailable += Math.max(0, (s.quantity || 0) - (s.reserved || 0));
    byKey[key].bbdCount += 1;
  }
  return Object.values(byKey).sort((a, b) => {
    if (!a.bestBeforeDate) return 1;
    if (!b.bestBeforeDate) return -1;
    return a.bestBeforeDate.localeCompare(b.bestBeforeDate);
  });
}

async function listStockByLocation(reqUser, query = {}) {
  const { Location, Zone } = require('../models');
  const where = {};
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  const productWhere = (reqUser.role !== 'super_admin' && reqUser.companyId) ? { companyId: reqUser.companyId } : undefined;
  const include = [
    { association: 'Product', where: productWhere, required: !!productWhere, attributes: ['id', 'name', 'sku'] },
    { association: 'Warehouse', attributes: ['id', 'name'] },
    { association: 'Location', required: false, include: [{ association: 'Zone', attributes: ['id', 'name', 'code'] }] },
  ];
  const stocks = await ProductStock.findAll({ where, include });
  const byLoc = {};
  for (const s of stocks) {
    const locId = s.locationId || 0;
    const loc = s.Location;
    if (query.locationType && loc && loc.locationType !== query.locationType) continue;
    if (!byLoc[locId]) {
      byLoc[locId] = {
        locationId: locId || null,
        locationName: loc?.name || 'Unassigned',
        locationCode: loc?.code || loc?.name || '',
        locationType: loc?.locationType || '—',
        zoneName: loc?.Zone?.name || loc?.Zone?.code || '—',
        properties: loc?.heatSensitive === 'yes' ? 'Hot Location' : (loc?.heatSensitive ? String(loc.heatSensitive) : '—'),
        pickSequence: loc?.pickSequence ?? null,
        totalItems: 0,
        productIds: new Set(),
        warnings: [],
      };
    }
    byLoc[locId].totalItems += (s.quantity || 0);
    byLoc[locId].productIds.add(s.productId);
    if (s.bestBeforeDate && new Date(s.bestBeforeDate) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)) {
      if (!byLoc[locId].warnings.includes('Expiring soon')) byLoc[locId].warnings.push('Expiring soon');
    }
  }
  return Object.values(byLoc)
    .map((r) => ({ ...r, productCount: r.productIds.size, productIds: undefined, warnings: r.warnings.length ? r.warnings.join('; ') : '—' }))
    .sort((a, b) => (a.pickSequence != null && b.pickSequence != null ? a.pickSequence - b.pickSequence : (a.locationCode || '').localeCompare(b.locationCode || '')));
}

function generateAdjustmentReference() {
  return 'ADJ-' + Buffer.from(Date.now().toString(36) + Math.random().toString(36).slice(2)).toString('base64').replace(/[/+=]/g, '').slice(0, 8).toUpperCase();
}

async function listAdjustments(reqUser, query = {}) {
  const where = {};
  const role = (reqUser.role || '').toString().toLowerCase().replace(/-/g, '_');
  if (role !== 'super_admin' && reqUser.companyId) where.companyId = reqUser.companyId;
  if (query.type) where.type = query.type;
  if (query.status) where.status = query.status;
  if (query.search) {
    where[Op.or] = [
      { referenceNumber: { [Op.like]: `%${query.search}%` } },
      { reason: { [Op.like]: `%${query.search}%` } },
    ];
  }
  const list = await InventoryAdjustment.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
      { association: 'Warehouse', required: false, attributes: ['id', 'name'] },
      { association: 'createdByUser', required: false, attributes: ['id', 'name', 'email'] },
      { association: 'Location', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'Client', required: false, attributes: ['id', 'name'] },
    ],
  });
  return list.map((a) => {
    const j = a.toJSON();
    j.items = [{ product: j.Product, quantity: j.quantity }];
    j.createdBy = j.createdByUser;
    // Keep Product and User for frontend history rendering
    return j;
  });
}


async function createAdjustment(data, reqUser) {
  const role = (reqUser.role || '').toString().toLowerCase().replace(/-/g, '_');
  const allowedRoles = ['super_admin', 'company_admin', 'inventory_manager', 'warehouse_manager', 'picker', 'packer'];
  if (!allowedRoles.includes(role)) {
    throw new Error('Not allowed to create adjustment');
  }
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId && role !== 'super_admin') throw new Error('Company context required');
  const effectiveCompanyId = companyId || (await Product.findByPk(data.productId).then(p => p?.companyId));
  if (!effectiveCompanyId) throw new Error('Company context required');
  const product = await Product.findByPk(data.productId);
  if (!product) throw new Error('Product not found');
  if (effectiveCompanyId && product.companyId !== effectiveCompanyId && role !== 'super_admin') throw new Error('Product not found');
  if (isTruthyYes(product.requireBatchTracking) && !String(data.batchNumber || '').trim()) {
    throw new Error(`${product.name || 'This product'} requires a Batch Number for accurate tracking`);
  }
  if (isTruthyYes(product.perishable) && !data.bestBeforeDate) {
    throw new Error(`${product.name || 'This product'} requires a Best Before (Expiry) Date`);
  }

  // Auto-detect type from quantity sign if not explicitly provided
  const rawQty = parseInt(data.quantity, 10) || 0;
  const type = data.type?.toUpperCase() === 'INCREASE' || (rawQty >= 0 && data.type?.toUpperCase() !== 'DECREASE') ? 'INCREASE' : 'DECREASE';
  const qty = Math.abs(rawQty);
  if (qty < 1) throw new Error('Quantity must be at least 1');

  let warehouseId = data.warehouseId || null;
  let locationId = data.locationId || null;
  let batchId = data.batchId || null;
  let batchNumber = data.batchNumber || null;
  let bestBeforeDate = data.bestBeforeDate || null;
  let clientId = data.clientId || null;

  // New requirement: Stock updates per SKU + Warehouse + Location + Batch
  // If batchId is provided, resolve batchNumber
  if (batchId && !batchNumber) {
    const b = await Batch.findByPk(batchId);
    if (b) batchNumber = b.batchNumber;
  } else if (!batchId && batchNumber) {
    // If batchNumber is provided, try to find batchId
    const b = await Batch.findOne({ where: { productId: data.productId, batchNumber: batchNumber.trim() } });
    if (b) batchId = b.id;
  }

  if (!warehouseId) throw new Error('Warehouse is mandatory for inventory booking');
  if (!locationId) throw new Error('Location is mandatory to ensure stock tracking per bin');
  if (!clientId) throw new Error('Client is mandatory for stock movement mapping');
  if (type === 'INCREASE') {
    await validateHeatSensitivePlacement({ product, locationId, actionLabel: 'booked' });
  }

  if (type === 'INCREASE') {
    const warehouseService = require('./warehouseService');
    await warehouseService.validateCapacity(warehouseId, qty);
  }

  const transaction = await sequelize.transaction();

  try {
    const referenceNumber = generateAdjustmentReference();

    // Find exact stock record for this combination
    const stockWhere = {
      productId: data.productId,
      warehouseId: warehouseId,
      locationId: locationId || null,
      batchNumber: batchNumber ? String(batchNumber).trim() : null,
      bestBeforeDate: bestBeforeDate || null,
      clientId: clientId ? Number(clientId) : null
    };

    let stock = await ProductStock.findOne({ where: stockWhere, transaction });

    if (type === 'DECREASE') {
      if (!stock || (stock.quantity || 0) - (stock.reserved || 0) < qty) {
        throw new Error('Insufficient available stock for this combination (Warehouse/Location/Batch)');
      }
    }

    const adjustment = await InventoryAdjustment.create({
      referenceNumber,
      companyId: effectiveCompanyId,
      productId: data.productId,
      warehouseId,
      locationId,
      batchId,
      batchNumber,
      bestBeforeDate,
      clientId,
      type,
      quantity: qty,
      reason: data.reason || null,
      notes: data.notes || null,
      status: 'PENDING',
      createdBy: reqUser.id,
    }, { transaction });

    // 1. Update ProductStock
    if (stock) {
      if (type === 'INCREASE') {
        await stock.increment('quantity', { by: qty, transaction });
        // Update metadata fields
        await stock.update({
          bestBeforeDate: bestBeforeDate || stock.bestBeforeDate,
          clientId: clientId || stock.clientId,
          userId: reqUser.id,
          reason: data.reason || stock.reason
        }, { transaction });
      } else {
        await stock.decrement('quantity', { by: qty, transaction });
        // Auto-delete zero-quantity rows so ghost records don't linger in inventory
        await stock.reload({ transaction });
        if ((Number(stock.quantity) || 0) <= 0) {
          await stock.destroy({ transaction });
        } else {
          // Update metadata fields only if row survived
          await stock.update({
            bestBeforeDate: bestBeforeDate || stock.bestBeforeDate,
            clientId: clientId || stock.clientId,
            userId: reqUser.id,
            reason: data.reason || stock.reason
          }, { transaction });
        }
      }
    } else if (type === 'INCREASE') {
      await ProductStock.create({
        companyId: effectiveCompanyId,
        productId: data.productId,
        warehouseId,
        locationId,
        batchNumber,
        batchId,
        quantity: qty,
        reserved: 0,
        bestBeforeDate,
        clientId,
        userId: reqUser.id,
        reason: data.reason,
        status: 'ACTIVE',
      }, { transaction });
    }

    // 2. Update Batch if provided
    if (batchId) {
      const b = await Batch.findByPk(batchId, { transaction });
      if (b) {
        const newBatchQty = type === 'INCREASE' ? (b.quantity || 0) + qty : Math.max(0, (b.quantity || 0) - qty);
        await b.update({ quantity: newBatchQty }, { transaction });
      }
    }

    // 3. SYNC Inventory Table (Warehouse Level)
    const { Inventory } = require('../models');
    const [inv] = await Inventory.findOrCreate({
      where: { productId: data.productId, warehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction
    });
    if (type === 'INCREASE') {
      await inv.increment('quantity', { by: qty, transaction });
    } else {
      await inv.decrement('quantity', { by: qty, transaction });
    }

    // 4. Create Entry in InventoryLog for history
    const { InventoryLog } = require('../models');
    await InventoryLog.create({
      productId: data.productId,
      warehouseId,
      locationId,
      batchId,
      batchNumber,
      bestBeforeDate,
      clientId,
      userId: reqUser.id,
      type: type === 'INCREASE' ? 'IN' : 'OUT',
      quantity: qty,
      reason: data.reason || (type === 'INCREASE' ? 'Stock In' : 'Stock Out'),
      referenceId: referenceNumber
    }, { transaction });

    await adjustment.update({ status: 'COMPLETED' }, { transaction });

    // Re-sync reservations for this product in this warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(data.productId, warehouseId, transaction);

    await transaction.commit();

    return InventoryAdjustment.findByPk(adjustment.id, {
      include: [
        { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
        { association: 'Warehouse', required: false, attributes: ['id', 'name'] },
        { association: 'createdByUser', required: false, attributes: ['id', 'name', 'email'] },
        { association: 'Location', required: false, attributes: ['id', 'name', 'code'] },
        { association: 'Client', required: false, attributes: ['id', 'name'] },
      ],
    }).then((a) => {
      const j = a.toJSON();
      j.items = [{ product: j.Product, quantity: j.quantity }];
      j.createdBy = j.createdByUser;
      delete j.createdByUser;
      delete j.Product;
      return j;
    });

  } catch (err) {
    if (transaction) await transaction.rollback();
    throw err;
  }
}

async function listCycleCounts(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  if (query.status) where.status = query.status;
  if (query.search) {
    where[Op.or] = [
      { referenceNumber: { [Op.like]: `%${query.search}%` } },
      { countName: { [Op.like]: `%${query.search}%` } },
    ];
  }
  const list = await CycleCount.findAll({
    where,
    order: [['scheduledDate', 'DESC'], ['createdAt', 'DESC']],
    include: [
      { association: 'Location', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'countedByUser', required: false, attributes: ['id', 'name', 'email'] },
    ],
  });
  return list.map((c) => {
    const j = c.toJSON();
    j.countedBy = j.countedByUser;
    delete j.countedByUser;
    return j;
  });
}

async function createCycleCount(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'warehouse_manager') {
    throw new Error('Not allowed to create cycle count');
  }
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('Company context required');
  const count = await CycleCount.create({
    companyId,
    countName: data.countName || 'Cycle Count',
    countType: data.countType || null,
    locationId: data.locationId || null,
    scheduledDate: data.scheduledDate || null,
    notes: data.notes || null,
    status: 'PENDING',
    itemsCount: 0,
    discrepancies: 0,
    countedBy: null,
  });
  const refNum = 'CC-' + String(count.id).padStart(5, '0');
  await count.update({ referenceNumber: refNum });
  return CycleCount.findByPk(count.id, {
    include: [
      { association: 'Location', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'countedByUser', required: false, attributes: ['id', 'name', 'email'] },
    ],
  }).then((c) => {
    const j = c.toJSON();
    j.countedBy = j.countedByUser;
    delete j.countedByUser;
    return j;
  });
}


async function completeCycleCount(id, data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager') {
    throw new Error('Not allowed to complete cycle count');
  }

  const count = await CycleCount.findByPk(id);
  if (!count) throw new Error('Cycle count not found');
  if (count.status === 'COMPLETED') throw new Error('Cycle count already completed');

  if (reqUser.role !== 'super_admin' && count.companyId !== reqUser.companyId) {
    throw new Error('Cycle count not found');
  }

  // data.products = [{ productId, countedQty }]
  const products = Array.isArray(data.products) ? data.products : [];
  let discrepancies = 0;
  let itemsCount = 0;

  const transaction = await sequelize.transaction();
  try {
    for (const p of products) {
      const pid = p.productId;
      const counted = parseInt(p.countedQty, 10) || 0;
      itemsCount++;

      // Find current system stock
      // We assume CycleCount is for a specific location (count.locationId)
      // If count.locationId is null, it might be a "Whole Warehouse" or "Spot" count?
      // For simplicity, if locationId is present, we adjust stock AT THAT LOCATION.
      // If locationId is NULL, we might skip or fail? 
      // The UI requires locationId for creating cycle count usually, or it's optional?
      // In createCycleCount it says locationId || null.
      // If null, we can't easily auto-adjust stock because we don't know WHERE.
      // Let's assume locationId is REQUIRED for auto-adjustment for now, or throw error if missing.

      if (!count.locationId) {
        // If no location, we can't auto-adjust specific records. Just complete the count.
        continue;
      }

      // Find stock at this location
      // Note: A product might have multiple stocks at same location if Batches exist.
      // This logic is tricky if batches exist.
      // Simplified: We sum up all batches at this location for this product to compare?
      // usage: "Blind Count". User counts 10 units of Product A. System says 8.
      // We need to adjust. Which batch? 
      // If we don't support batch scanning in cycle count, we might default to no-batch or oldest batch?
      // Or we just update the "No Batch" record?
      // Let's try to find a stock record without batch first (or any).
      // Ideally, the "Input" should specify Batch if relevant.
      // For now, let's assume standard stock (null batch) or generic adjustment.

      const where = {
        productId: pid,
        locationId: count.locationId,
        warehouseId: (await (require('../models').Location).findByPk(count.locationId)).warehouseId
      };

      // Aggregated check if multiple batches?
      // For this implementation, let's match exact batch if provided in input, else match 'null' batch?
      // Or simpler: The user input should ideally match existing structure.
      // Let's stick to: Update Total Quantity at Location. 
      // If multiple batches exist, this gets complex. 
      // Plan: If Multiple Batches, we can't easily guess. 
      // For this fix: Assume non-batched or user selects 'No Batch'.
      // If user sends batchId/Number, use it.

      if (p.batchNumber) where.batchNumber = p.batchNumber;

      let stock = await ProductStock.findOne({ where, transaction });
      const systemQty = stock ? stock.quantity : 0;
      const diff = counted - systemQty;

      if (diff !== 0) {
        discrepancies++;
        // Create Adjustment
        const type = diff > 0 ? 'INCREASE' : 'DECREASE';
        const qty = Math.abs(diff);

        await InventoryAdjustment.create({
          referenceNumber: generateAdjustmentReference(),
          companyId: count.companyId,
          productId: pid,
          warehouseId: where.warehouseId,
          type,
          quantity: qty,
          reason: `Cycle Count #${count.referenceNumber}`,
          notes: 'Auto-adjustment from cycle count',
          status: 'COMPLETED',
          createdBy: reqUser.id
        }, { transaction });

        // Update Stock
        if (stock) {
          await stock.increment('quantity', { by: diff, transaction });
        } else if (diff > 0) {
          await ProductStock.create({
            ...where,
            companyId: count.companyId,
            quantity: diff,
            status: 'ACTIVE'
          }, { transaction });
        }

        // [FIX] Also sync Warehouse Level Total (Inventory Table)
        const { Inventory } = require('../models');
        const [inv] = await Inventory.findOrCreate({
          where: { productId: pid, warehouseId: where.warehouseId },
          defaults: { quantity: 0, reservedQuantity: 0 },
          transaction
        });
        if (diff > 0) {
          await inv.increment('quantity', { by: Math.abs(diff), transaction });
        } else {
          await inv.decrement('quantity', { by: Math.abs(diff), transaction });
        }

        // Create InventoryLog entry
        const logType = diff > 0 ? 'IN' : 'OUT';
        const logQty = Math.abs(diff);
        const { InventoryLog } = require('../models');
        await InventoryLog.create({
          productId: pid,
          warehouseId: where.warehouseId,
          locationId: count.locationId,
          batchNumber: p.batchNumber || null,
          clientId: stock ? stock.clientId : null,
          userId: reqUser.id,
          type: logType,
          quantity: logQty,
          reason: `Cycle Count #${count.referenceNumber}`,
          referenceId: count.referenceNumber
        }, { transaction });
      }
    }

    await count.update({
      status: 'COMPLETED',
      itemsCount,
      discrepancies,
      countedBy: reqUser.id
    }, { transaction });

    await transaction.commit();
    return CycleCount.findByPk(id, {
      include: [
        { association: 'Location' },
        { association: 'countedByUser' }
      ]
    });

  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function listBatches(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  if (query.status) where.status = query.status;
  if (query.productId) where.productId = query.productId;
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  if (query.search) {
    where[Op.or] = [
      { batchNumber: { [Op.like]: `%${query.search}%` } },
    ];
  }
  const list = await Batch.findAll({
    where,
    order: [['receivedDate', 'DESC'], ['createdAt', 'DESC']],
    include: [
      { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
      { association: 'Warehouse', attributes: ['id', 'name', 'code'] },
      { association: 'Location', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'Supplier', required: false, attributes: ['id', 'name', 'code'] },
    ],
  });
  return list.map((b) => {
    const j = b.toJSON();
    j.availableQuantity = Math.max(0, (b.quantity || 0) - (b.reserved || 0));
    return j;
  });
}

async function createBatch(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'warehouse_manager') {
    throw new Error('Not allowed to create batch');
  }
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('Company context required');
  const product = await Product.findByPk(data.productId);
  if (!product) throw new Error('Product not found');
  if (product.companyId !== companyId && reqUser.role !== 'super_admin') throw new Error('Product not found');
  /* 
   * [MODIFIED] Now also creates/updates ProductStock so batch inventory is live.
   */
  const packSize = product.packSize || 1;
  if (!packSize || packSize <= 0) {
    throw new Error(`Invalid pack size (${packSize}) for product ${product.sku}. Please check product configuration.`);
  }

  const calculatedUnitCost = data.unitCost != null ? parseFloat(data.unitCost) : 0;

  const transaction = await sequelize.transaction();
  try {
    const batch = await Batch.create({
      companyId,
      batchNumber: data.batchNumber || String(Date.now()),
      productId: data.productId,
      warehouseId: data.warehouseId,
      locationId: data.locationId || null,
      quantity: parseInt(data.quantity, 10) || 0,
      reserved: 0,
      unitCost: calculatedUnitCost,
      receivedDate: data.receivedDate || null,
      expiryDate: data.expiryDate || null,
      manufacturingDate: data.manufacturingDate || null,
      supplierId: data.supplierId || null,
      status: 'ACTIVE',
    }, { transaction });

    if (batch.quantity > 0 && batch.warehouseId) {
      const warehouseService = require('./warehouseService');
      await warehouseService.validateCapacity(batch.warehouseId, batch.quantity);
    }

    // Sync with ProductStock if quantity > 0
    if (batch.quantity > 0) {
      const stockQty = batch.quantity;
      const stockWhere = {
        productId: batch.productId,
        warehouseId: batch.warehouseId,
        locationId: batch.locationId || null,
        batchNumber: batch.batchNumber,
        bestBeforeDate: batch.expiryDate || null,
        clientId: data.clientId || null
      };

      let stock = await ProductStock.findOne({ where: stockWhere, transaction });
      if (stock) {
        await stock.update({
          quantity: (Number(stock.quantity) || 0) + stockQty
        }, { transaction });
      } else {
        await ProductStock.create({
          ...stockWhere,
          companyId: batch.companyId,
          quantity: stockQty,
          reserved: 0,
          status: 'ACTIVE'
        }, { transaction });
      }

      // Sync Warehouse Total
      const { Inventory } = require('../models');
      const [inv] = await Inventory.findOrCreate({
        where: { productId: batch.productId, warehouseId: batch.warehouseId },
        defaults: { quantity: 0, reservedQuantity: 0 },
        transaction
      });
      await inv.increment('quantity', { by: stockQty, transaction });

      // Create Log
      const { InventoryLog } = require('../models');
      await InventoryLog.create({
        productId: batch.productId,
        warehouseId: batch.warehouseId,
        locationId: batch.locationId || null,
        clientId: data.clientId || null,
        type: 'IN',
        quantity: stockQty,
        batchNumber: batch.batchNumber,
        bestBeforeDate: batch.expiryDate || null,
        reason: 'Batch Creation',
        userId: reqUser.id
      }, { transaction });
    }

    await transaction.commit();
    return getBatchById(batch.id, reqUser);
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function getBatchById(id, reqUser) {
  const batch = await Batch.findByPk(id, {
    include: [
      { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
      { association: 'Warehouse', attributes: ['id', 'name', 'code'] },
      { association: 'Location', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'Supplier', required: false, attributes: ['id', 'name', 'code'] },
    ],
  });
  if (!batch) throw new Error('Batch not found');
  if (reqUser.role !== 'super_admin' && batch.companyId !== reqUser.companyId) throw new Error('Batch not found');
  const j = batch.toJSON();
  j.availableQuantity = Math.max(0, (batch.quantity || 0) - (batch.reserved || 0));
  return j;
}

async function updateBatch(id, data, reqUser) {
  const batch = await Batch.findByPk(id, { include: ['Product'] });
  if (!batch) throw new Error('Batch not found');
  if (reqUser.role !== 'super_admin' && batch.companyId !== reqUser.companyId) throw new Error('Batch not found');
  await batch.update({
    batchNumber: data.batchNumber !== undefined ? data.batchNumber : batch.batchNumber,
    locationId: data.locationId !== undefined ? data.locationId : batch.locationId,
    quantity: data.quantity !== undefined ? parseInt(data.quantity, 10) : batch.quantity,
    unitCost: data.unitCost !== undefined ? (data.unitCost == null ? null : parseFloat(data.unitCost)) : batch.unitCost,
    receivedDate: data.receivedDate !== undefined ? data.receivedDate : batch.receivedDate,
    expiryDate: data.expiryDate !== undefined ? data.expiryDate : batch.expiryDate,
    manufacturingDate: data.manufacturingDate !== undefined ? data.manufacturingDate : batch.manufacturingDate,
    supplierId: data.supplierId !== undefined ? data.supplierId : batch.supplierId,
    status: data.status !== undefined ? data.status : batch.status,
  });
  return getBatchById(batch.id, reqUser);
}

async function removeBatch(id, reqUser) {
  const batch = await Batch.findByPk(id);
  if (!batch) throw new Error('Batch not found');
  if (reqUser.role !== 'super_admin' && batch.companyId !== reqUser.companyId) throw new Error('Batch not found');
  await batch.destroy();
  return { message: 'Batch deleted' };
}

async function listMovements(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  if (query.type) where.type = query.type;
  if (query.startDate || query.endDate) {
    const dateCond = {};
    if (query.startDate) dateCond[Op.gte] = new Date(query.startDate + 'T00:00:00');
    if (query.endDate) dateCond[Op.lte] = new Date(query.endDate + 'T23:59:59');
    where.createdAt = dateCond;
  }
  const list = await Movement.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
      { association: 'Batch', required: false, attributes: ['id', 'batchNumber'] },
      { association: 'fromLocation', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'toLocation', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'fromWarehouse', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'toWarehouse', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'createdByUser', required: false, attributes: ['id', 'name', 'email'] },
    ],
  });
  return list.map((m) => {
    const j = m.toJSON();
    j.user = j.createdByUser;
    delete j.createdByUser;
    return j;
  });
}

async function createMovement(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'warehouse_manager') {
    throw new Error('Not allowed to create movement');
  }
  const companyId = reqUser.companyId || data.companyId;
  if (!companyId) throw new Error('Company context required');
  const product = await Product.findByPk(data.productId);
  if (!product) throw new Error('Product not found');
  if (product.companyId !== companyId && reqUser.role !== 'super_admin') throw new Error('Product not found');
  const qty = parseInt(data.quantity, 10) || 0;
  if (qty <= 0) throw new Error('Quantity must be greater than 0');

  const type = data.type || 'TRANSFER';
  const batchId = data.batchId || null;
  let batchNumber = null;

  if (batchId) {
    const b = await Batch.findByPk(batchId);
    if (b) batchNumber = b.batchNumber;
  }

  const transaction = await sequelize.transaction();

  try {
    // Resolve warehouses from locations if provided
    let fromWarehouseId = data.fromWarehouseId || null;
    let toWarehouseId = data.toWarehouseId || null;

    if (!fromWarehouseId && data.fromLocationId) {
      const fl = await (require('../models').Location).findByPk(data.fromLocationId);
      if (fl) fromWarehouseId = fl.warehouseId;
    }
    if (!toWarehouseId && data.toLocationId) {
      const tl = await (require('../models').Location).findByPk(data.toLocationId);
      if (tl) toWarehouseId = tl.warehouseId;
    }

    // 1. Log the Movement
    const movement = await Movement.create({
      companyId,
      type,
      productId: data.productId,
      batchId,
      fromWarehouseId,
      toWarehouseId,
      fromLocationId: data.fromLocationId || null,
      toLocationId: data.toLocationId || null,
      quantity: qty,
      reason: data.reason || null,
      notes: data.notes || null,
      createdBy: reqUser.id,
    }, { transaction });

    // 2. Adjust Stock based on Type
    /*
      RECEIVE/RETURN: Add to ToLocation
      PICK: Subtract from FromLocation
      TRANSFER: Subtract from FromLocation, Add to ToLocation
      ADJUST: (Handled via Adjustments usually, but if used here, implies manual +/- ?)
              Let's assume ADJUST here is just logging or behaves like Transfer if both locs exist? 
              For safety, we will restrict ADJUST to use createAdjustment API. 
              But if user uses this UI, we support:
              - If only ToLocation -> Add
              - If only FromLocation -> Subtract
    */

    // Helper to Add Stock
    const addStock = async (locId, q, batchNum) => {
      if (!locId) throw new Error('Destination location required');
      const loc = await (require('../models').Location).findByPk(locId);
      if (!loc) throw new Error(`Location ${locId} not found`);

      const warehouseService = require('./warehouseService');
      await warehouseService.validateCapacity(loc.warehouseId, q, { transaction });

      const where = {
        productId: data.productId,
        warehouseId: loc.warehouseId, // Use resolved warehouseId
        locationId: locId,
        batchNumber: batchNum || null
      };

      // We need to resolve warehouseId efficiently. 
      // Assuming Location belongs to a Warehouse.
      // Optimisation: movement creates usually pass warehouse context? No, just loc IDs.
      // Let's look up location.

      // Check if stock exists
      // Note: ProductStock unique key is usually product+warehouse+location+batch
      // We need to be careful with "null" batchNumber in where clause if DB treats it uniquely.
      // Sequelize "where: { batchNumber: null }" works for finding NULLs.

      let stock = await ProductStock.findOne({ where, transaction });
      if (stock) {
        await stock.increment('quantity', { by: q, transaction });
      } else {
        await ProductStock.create({
          ...where,
          companyId,
          quantity: q,
          status: 'ACTIVE'
        }, { transaction });
      }
    };

    // Helper to Remove Stock
    const removeStock = async (locId, q, batchNum) => {
      if (!locId) throw new Error('Source location required');
      // Resolve warehouse from location
      const loc = await (require('../models').Location).findByPk(locId);
      if (!loc) throw new Error(`Location ${locId} not found`);

      const where = {
        productId: data.productId,
        warehouseId: loc.warehouseId,
        locationId: locId,
        batchNumber: batchNum || null
      };

      const stock = await ProductStock.findOne({ where, transaction });
      if (!stock || (stock.quantity < q)) {
        throw new Error(`Insufficient stock at location ${loc.name || loc.code}`);
      }
      await stock.decrement('quantity', { by: q, transaction });
      // Auto-delete zero-quantity rows after movement so empty records don't persist
      await stock.reload({ transaction });
      if ((Number(stock.quantity) || 0) <= 0) {
        await stock.destroy({ transaction });
      }
    };

    if (type === 'RECEIVE' || type === 'RETURN') {
      await addStock(data.toLocationId, qty, batchNumber);
    }
    else if (type === 'PICK') {
      await removeStock(data.fromLocationId, qty, batchNumber);
    }
    else if (type === 'TRANSFER') {
      await removeStock(data.fromLocationId, qty, batchNumber);
      await addStock(data.toLocationId, qty, batchNumber);
    }

    await transaction.commit();
    return getMovementById(movement.id, reqUser);

  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function getMovementById(id, reqUser) {
  const movement = await Movement.findByPk(id, {
    include: [
      { association: 'Product', attributes: ['id', 'name', 'sku', 'packSize'] },
      { association: 'Batch', required: false, attributes: ['id', 'batchNumber'] },
      { association: 'fromLocation', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'toLocation', required: false, attributes: ['id', 'name', 'code', 'aisle', 'rack', 'shelf', 'bin'] },
      { association: 'fromWarehouse', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'toWarehouse', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'createdByUser', required: false, attributes: ['id', 'name', 'email'] },
    ],
  });
  if (!movement) throw new Error('Movement not found');
  if (reqUser.role !== 'super_admin' && movement.companyId !== reqUser.companyId) throw new Error('Movement not found');
  const j = movement.toJSON();
  j.user = j.createdByUser;
  delete j.createdByUser;
  return j;
}

async function updateMovement(id, data, reqUser) {
  const movement = await Movement.findByPk(id);
  if (!movement) throw new Error('Movement not found');
  if (reqUser.role !== 'super_admin' && movement.companyId !== reqUser.companyId) throw new Error('Movement not found');
  await movement.update({
    type: data.type !== undefined ? data.type : movement.type,
    batchId: data.batchId !== undefined ? data.batchId : movement.batchId,
    fromLocationId: data.fromLocationId !== undefined ? data.fromLocationId : movement.fromLocationId,
    toLocationId: data.toLocationId !== undefined ? data.toLocationId : movement.toLocationId,
    quantity: data.quantity !== undefined ? parseInt(data.quantity, 10) : movement.quantity,
    reason: data.reason !== undefined ? data.reason : movement.reason,
    notes: data.notes !== undefined ? data.notes : movement.notes,
  });
  return getMovementById(movement.id, reqUser);
}

async function removeMovement(id, reqUser) {
  const movement = await Movement.findByPk(id);
  if (!movement) throw new Error('Movement not found');
  if (reqUser.role !== 'super_admin' && movement.companyId !== reqUser.companyId) throw new Error('Movement not found');
  await movement.destroy();
  return { message: 'Movement deleted' };
}

async function listInventory(reqUser, query = {}) {
  const { Inventory, Product, Warehouse } = require('../models');
  const where = {};
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  const productWhere = {};
  if (reqUser.role !== 'super_admin') productWhere.companyId = reqUser.companyId;
  if (query.search) {
    productWhere[Op.or] = [
      { name: { [Op.like]: `%${query.search}%` } },
      { sku: { [Op.like]: `%${query.search}%` } },
      { barcode: { [Op.like]: `%${query.search}%` } },
      Sequelize.where(
        Sequelize.cast(Sequelize.col('Product.cartons'), 'CHAR'),
        { [Op.like]: `%${query.search}%` }
      )
    ];
  }

  const inventory = await Inventory.findAll({
    where,
    include: [
      { model: Product, where: productWhere, attributes: ['id', 'name', 'sku', 'reorderLevel'] },
      { model: Warehouse, attributes: ['id', 'name'] }
    ]
  });

  return inventory.map(item => {
    const status = item.quantity <= 0 ? 'Out of Stock' : (item.quantity < (item.Product?.reorderLevel || 10) ? 'Low Stock' : 'In Stock');
    return {
      ...item.toJSON(),
      status,
      availableQuantity: item.availableQuantity // VIRTUAL field
    };
  });
}

async function listInventoryLogs(reqUser, query = {}) {
  const { InventoryLog, Product, Location, Customer, User, Warehouse } = require('../models');
  const where = {};
  if (query.warehouseId) where.warehouseId = query.warehouseId;
  if (query.type) where.type = query.type;
  if (query.productId) where.productId = query.productId;
  if (query.locationId) where.locationId = query.locationId;
  if (query.clientId) where.clientId = query.clientId;

  const productWhere = {};
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    productWhere.companyId = reqUser.companyId;
  }

  const logs = await InventoryLog.findAll({
    where,
    include: [
      { model: Product, where: productWhere, required: true, attributes: ['id', 'name', 'sku'] },
      { association: 'Location', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'Client', required: false, attributes: ['id', 'name'] },
      { association: 'Warehouse', required: false, attributes: ['id', 'name'] },
      { association: 'User', required: false, attributes: ['id', 'name', 'email'] },
    ],
    order: [['createdAt', 'DESC']],
    limit: query.limit ? parseInt(query.limit) : 100
  });

  return logs.map(l => {
    const j = l.get({ plain: true });
    j.createdBy = j.User;
    // For legacy logs or transfers, ensure product info is available
    if (j.Product) {
      j.product = j.Product; // Backend compatibility
    }
    if (j.type === 'TRANSFER' && j.referenceId) {
      const m = String(j.referenceId).match(/TRANSFER:\s*(\d+):(\d+)\s*->\s*(\d+):(\d+)/i);
      if (m) {
        j.fromWarehouseId = Number(m[1]);
        j.fromLocationId = Number(m[2]);
        j.toWarehouseId = Number(m[3]);
        j.toLocationId = Number(m[4]);
      }
    }
    return j;
  });
}

async function listInventoryLedger(reqUser, query = {}) {
  const { InventoryLog, Product, Location, Customer, User, Warehouse } = require('../models');
  const where = {};

  // Date range filter
  if (query.startDate || query.endDate) {
    const dateCond = {};
    if (query.startDate) dateCond[Op.gte] = new Date(query.startDate + 'T00:00:00');
    if (query.endDate) dateCond[Op.lte] = new Date(query.endDate + 'T23:59:59');
    where.createdAt = dateCond;
  }

  // Reference ID filter
  if (query.referenceId) {
    where.referenceId = { [Op.like]: `%${query.referenceId}%` };
  }

  // Warehouse filter
  if (query.warehouseId) {
    where.warehouseId = query.warehouseId;
  }

  // Client filter
  if (reqUser.clientId) {
    where.clientId = reqUser.clientId;
  } else if (query.clientId) {
    where.clientId = query.clientId;
  }

  // Event type filter
  if (query.eventType && query.eventType !== 'all') {
    const selectedTypes = String(query.eventType).split(',').map(t => t.trim());
    const validStandardTypes = selectedTypes.filter(t => ['IN', 'OUT', 'TRANSFER', 'ALLOCATE', 'DEALLOCATE'].includes(t));

    if (validStandardTypes.length > 0) {
      where.type = { [Op.in]: validStandardTypes };
    } else if (query.eventType === 'Shipments') {
      where.type = 'OUT';
      where.reason = {
        [Op.or]: [
          { [Op.like]: '%Shipment%' },
          { [Op.like]: '%Sales Order%' },
          { [Op.like]: '%Scan Out%' }
        ]
      };
    } else if (query.eventType === 'Receipts') {
      where.type = 'IN';
      where.reason = {
        [Op.or]: [
          { [Op.like]: '%Receipt%' },
          { [Op.like]: '%Purchase Order%' },
          { [Op.like]: '%ASN%' },
          { [Op.like]: '%Goods%' },
          { [Op.like]: '%Scan In%' },
          { [Op.like]: '%Manual Stock Creation%' },
          { [Op.like]: '%Batch Creation%' }
        ]
      };
    } else if (query.eventType === 'WhseTransfers') {
      where.type = 'TRANSFER';
    } else if (query.eventType === 'Adjustments') {
      where.reason = {
        [Op.or]: [
          { [Op.like]: '%Adjustment%' },
          { [Op.like]: '%Cycle Count%' },
          { [Op.like]: '%Correction%' },
          { [Op.like]: '%Manual Stock%' },
          { [Op.like]: '%Bulk%' }
        ]
      };
    } else if (query.eventType === 'CustomerReturns') {
      where.reason = {
        [Op.and]: [
          { [Op.like]: '%Return%' },
          { [Op.notLike]: '%Vendor%' },
          { [Op.notLike]: '%Supplier%' }
        ]
      };
    } else if (query.eventType === 'VendorReturns') {
      where.reason = {
        [Op.or]: [
          { [Op.like]: '%Vendor Return%' },
          { [Op.like]: '%Supplier Return%' }
        ]
      };
    }
  }

  // Disposition filter
  if (query.disposition && query.disposition !== 'all') {
    if (query.disposition === 'EXPIRED') {
      where.reason = { [Op.like]: '%Expired%' };
    } else if (query.disposition === 'CARRIER_DAMAGED') {
      where.reason = { [Op.or]: [{ [Op.like]: '%Carrier Damaged%' }, { [Op.like]: '%Carrier_Damaged%' }] };
    } else if (query.disposition === 'CUSTOMER_DAMAGED') {
      where.reason = { [Op.or]: [{ [Op.like]: '%Customer Damaged%' }, { [Op.like]: '%Customer_Damaged%' }] };
    } else if (query.disposition === 'DISTRIBUTOR_DAMAGED') {
      where.reason = { [Op.or]: [{ [Op.like]: '%Distributor Damaged%' }, { [Op.like]: '%Distributor_Damaged%' }] };
    } else if (query.disposition === 'WAREHOUSE_DAMAGED') {
      where.reason = { [Op.or]: [{ [Op.like]: '%Warehouse Damaged%' }, { [Op.like]: '%Warehouse_Damaged%' }, { [Op.like]: '%Damaged%' }] };
    } else if (query.disposition === 'DEFECTIVE') {
      where.reason = { [Op.like]: '%Defective%' };
    } else if (query.disposition === 'UNSELLABLE_OTHER') {
      where.reason = { [Op.or]: [{ [Op.like]: '%Theft%' }, { [Op.like]: '%Waste%' }, { [Op.like]: '%Unsellable%' }] };
    } else if (query.disposition === 'SELLABLE') {
      where.reason = {
        [Op.or]: [
          { [Op.is]: null },
          {
            [Op.and]: [
              { [Op.notLike]: '%Expired%' },
              { [Op.notLike]: '%Carrier Damaged%' },
              { [Op.notLike]: '%Carrier_Damaged%' },
              { [Op.notLike]: '%Customer Damaged%' },
              { [Op.notLike]: '%Customer_Damaged%' },
              { [Op.notLike]: '%Distributor Damaged%' },
              { [Op.notLike]: '%Distributor_Damaged%' },
              { [Op.notLike]: '%Warehouse Damaged%' },
              { [Op.notLike]: '%Warehouse_Damaged%' },
              { [Op.notLike]: '%Damaged%' },
              { [Op.notLike]: '%Defective%' },
              { [Op.notLike]: '%Theft%' },
              { [Op.notLike]: '%Waste%' },
              { [Op.notLike]: '%Unsellable%' }
            ]
          }
        ]
      };
    }
  }

  // Product filters
  const productWhere = {};
  if (reqUser.role !== 'super_admin' && reqUser.companyId) {
    productWhere.companyId = reqUser.companyId;
  }
  if (query.search) {
    productWhere[Op.or] = [
      { sku: { [Op.like]: `%${query.search}%` } },
      { name: { [Op.like]: `%${query.search}%` } },
      { barcode: { [Op.like]: `%${query.search}%` } },
      Sequelize.where(
        Sequelize.cast(Sequelize.col('Product.cartons'), 'CHAR'),
        { [Op.like]: `%${query.search}%` }
      )
    ];
  }
  if (query.sku) {
    productWhere.sku = { [Op.like]: `%${query.sku}%` };
  }
  if (query.asin) {
    productWhere[Op.or] = [
      { marketplaceSkus: { [Op.like]: `%"asin":"${query.asin}"%` } },
      { marketplaceSkus: { [Op.like]: `%${query.asin}%` } }
    ];
  }
  if (query.fnsku) {
    productWhere[Op.or] = [
      { marketplaceSkus: { [Op.like]: `%"fnsku":"${query.fnsku}"%` } },
      { marketplaceSkus: { [Op.like]: `%${query.fnsku}%` } }
    ];
  }

  // Pagination
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.pageSize, 10) || 20;
  const offset = (page - 1) * limit;

  const { rows, count } = await InventoryLog.findAndCountAll({
    where,
    include: [
      {
        model: Product,
        where: productWhere,
        required: true,
        attributes: ['id', 'name', 'sku', 'barcode', 'marketplaceSkus']
      },
      { association: 'Location', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'Client', required: false, attributes: ['id', 'name'] },
      { association: 'Warehouse', required: false, attributes: ['id', 'name', 'code'] },
      { association: 'User', required: false, attributes: ['id', 'name', 'email'] },
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset
  });

  const locationIds = [];
  const warehouseIds = [];
  rows.forEach(r => {
    if (r.type === 'TRANSFER' && r.referenceId) {
      const m = String(r.referenceId).match(/TRANSFER:\s*(\d+):(\d+)\s*->\s*(\d+):(\d+)/i);
      if (m) {
        warehouseIds.push(Number(m[1]), Number(m[3]));
        locationIds.push(Number(m[2]), Number(m[4]));
      }
    }
  });

  const uniqueLocationIds = [...new Set(locationIds.filter(Boolean))];
  const uniqueWarehouseIds = [...new Set(warehouseIds.filter(Boolean))];

  let locationsMap = {};
  let warehousesMap = {};

  if (uniqueLocationIds.length > 0) {
    const locs = await Location.findAll({
      where: { id: uniqueLocationIds },
      attributes: ['id', 'name', 'code']
    });
    locs.forEach(loc => {
      locationsMap[loc.id] = loc.get({ plain: true });
    });
  }

  if (uniqueWarehouseIds.length > 0) {
    const whs = await Warehouse.findAll({
      where: { id: uniqueWarehouseIds },
      attributes: ['id', 'name', 'code']
    });
    whs.forEach(wh => {
      warehousesMap[wh.id] = wh.get({ plain: true });
    });
  }

  const items = rows.map(l => {
    const j = l.get({ plain: true });
    j.createdBy = j.User;

    if (j.type === 'TRANSFER' && j.referenceId) {
      const m = String(j.referenceId).match(/TRANSFER:\s*(\d+):(\d+)\s*->\s*(\d+):(\d+)/i);
      if (m) {
        const fromWhId = Number(m[1]);
        const fromLocId = Number(m[2]);
        const toWhId = Number(m[3]);
        const toLocId = Number(m[4]);

        j.fromWarehouse = warehousesMap[fromWhId] || { id: fromWhId, name: `Warehouse ${fromWhId}`, code: `WH-${fromWhId}` };
        j.fromLocation = locationsMap[fromLocId] || { id: fromLocId, name: `Bin ${fromLocId}`, code: `BIN-${fromLocId}` };
        j.toWarehouse = warehousesMap[toWhId] || { id: toWhId, name: `Warehouse ${toWhId}`, code: `WH-${toWhId}` };
        j.toLocation = locationsMap[toLocId] || { id: toLocId, name: `Bin ${toLocId}`, code: `BIN-${toLocId}` };
      }
    }

    // Determine Event Type
    let eventType = 'Adjustments';
    const reasonLower = (j.reason || '').toLowerCase();
    if (j.type === 'TRANSFER' || reasonLower.includes('transfer')) {
      eventType = 'WhseTransfers';
    } else if (reasonLower.includes('return')) {
      if (reasonLower.includes('vendor') || reasonLower.includes('supplier')) {
        eventType = 'VendorReturns';
      } else {
        eventType = 'CustomerReturns';
      }
    } else if (j.type === 'IN' && (
      reasonLower.includes('receipt') ||
      reasonLower.includes('purchase order') ||
      reasonLower.includes('goods') ||
      reasonLower.includes('asn') ||
      reasonLower.includes('scan in') ||
      reasonLower.includes('manual stock creation') ||
      reasonLower.includes('batch creation')
    )) {
      eventType = 'Receipts';
    } else if (j.type === 'OUT' && (
      reasonLower.includes('shipment') ||
      reasonLower.includes('sales order') ||
      reasonLower.includes('scan out')
    )) {
      eventType = 'Shipments';
    }

    // Determine Disposition
    let disposition = 'SELLABLE';
    if (j.reason) {
      const rLower = j.reason.toLowerCase();
      if (rLower.includes('expired')) {
        disposition = 'EXPIRED';
      } else if (rLower.includes('carrier damaged') || rLower.includes('carrier_damaged')) {
        disposition = 'CARRIER_DAMAGED';
      } else if (rLower.includes('customer damaged') || rLower.includes('customer_damaged')) {
        disposition = 'CUSTOMER_DAMAGED';
      } else if (rLower.includes('distributor damaged') || rLower.includes('distributor_damaged')) {
        disposition = 'DISTRIBUTOR_DAMAGED';
      } else if (rLower.includes('warehouse damaged') || rLower.includes('warehouse_damaged')) {
        disposition = 'WAREHOUSE_DAMAGED';
      } else if (rLower.includes('defective')) {
        disposition = 'DEFECTIVE';
      } else if (rLower.includes('theft') || rLower.includes('waste') || rLower.includes('unsellable')) {
        disposition = 'UNSELLABLE_OTHER';
      } else if (rLower.includes('damaged')) {
        disposition = 'WAREHOUSE_DAMAGED';
      }
    }

    // Force negative sign for deductions
    if (j.type === 'OUT') {
      j.quantity = -Math.abs(j.quantity);
    } else if (j.type === 'IN') {
      j.quantity = Math.abs(j.quantity);
    }

    j.fulfillmentCentre = j.Warehouse?.code || j.Warehouse?.name || '—';

    return {
      ...j,
      eventType,
      disposition
    };
  });

  return {
    items,
    total: count,
    page,
    pageSize: limit
  };
}



async function stockIn(data, reqUser) {
  const { Inventory, InventoryLog, Product, ProductStock, sequelize } = require('../models');
  const {
    productId, warehouseId, locationId, clientId,
    quantity, referenceId, batchNumber, bestBeforeDate, reason
  } = data;

  if (!clientId) throw new Error('Client is required for stock entry');

  const product = await Product.findByPk(productId);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');

  const normalizedBatch = batchNumber && String(batchNumber).trim() !== '' ? String(batchNumber).trim() : null;

  if (isTruthyYes(product.requireBatchTracking) && !normalizedBatch) {
    throw new Error(`${product.name || 'This product'} requires a Batch Number for accurate tracking`);
  }
  if (isTruthyYes(product.perishable) && !bestBeforeDate) {
    throw new Error(`${product.name || 'This product'} requires a Best Before (Expiry) Date`);
  }
  await validateHeatSensitivePlacement({ product, locationId, actionLabel: 'booked' });

  const transaction = await sequelize.transaction();
  try {
    // 1. Sync Warehouse Level Total
    const [inventory] = await Inventory.findOrCreate({
      where: { productId, warehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction
    });
    await inventory.increment('quantity', { by: quantity, transaction });

    // 2. Sync Granular Stock (Batch + Location + BBD)
    const stockWhere = {
      productId,
      warehouseId,
      locationId: locationId || null,
      batchNumber: normalizedBatch,
      bestBeforeDate: bestBeforeDate || null,
      clientId: clientId || null
    };

    let stock = await ProductStock.findOne({ where: stockWhere, transaction });

    if (stock) {
      await stock.update({
        quantity: (Number(stock.quantity) || 0) + Number(quantity)
      }, { transaction });
    } else {
      await ProductStock.create({
        companyId: product.companyId,
        productId,
        warehouseId,
        locationId: locationId || null,
        batchNumber: normalizedBatch,
        clientId: clientId || null,
        quantity: quantity,
        reserved: 0,
        bestBeforeDate,
        status: 'ACTIVE'
      }, { transaction });
    }

    // 3. Create Audit Log
    await InventoryLog.create({
      productId,
      warehouseId,
      locationId: locationId || null,
      clientId: clientId || null,
      type: 'IN',
      quantity,
      referenceId: referenceId || 'SCAN_IN',
      batchNumber: normalizedBatch,
      bestBeforeDate,
      reason: reason || 'Scan In',
      userId: reqUser.id
    }, { transaction });

    // Re-sync reservations for this product in this warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(productId, warehouseId, transaction);

    await transaction.commit();
    return inventory.reload();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function stockOut(data, reqUser) {
  const { Inventory, InventoryLog, ProductStock } = require('../models');
  const { productId, warehouseId, quantity, referenceId } = data;

  const transaction = await sequelize.transaction();
  try {
    const inventory = await Inventory.findOne({
      where: { productId, warehouseId },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!inventory) {
      throw new Error('Inventory record not found');
    }

    const available = (inventory.quantity || 0) - (inventory.reservedQuantity || 0);
    if (available < quantity) {
      throw new Error(`Insufficient available stock. Total: ${inventory.quantity}, Reserved: ${inventory.reservedQuantity}, Available: ${available}`);
    }

    // Deduct from ProductStock rows (FIFO)
    const stockRows = await ProductStock.findAll({
      where: {
        productId,
        warehouseId,
        quantity: { [Op.gt]: 0 },
        status: 'ACTIVE'
      },
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    let remaining = quantity;
    for (const row of stockRows) {
      if (remaining <= 0) break;
      const rowQty = Number(row.quantity);
      const toDeduct = Math.min(rowQty, remaining);
      await row.decrement('quantity', { by: toDeduct, transaction });

      // Auto-delete zero-quantity rows so ghost records don't linger
      await row.reload({ transaction });
      if ((Number(row.quantity) || 0) <= 0) {
        await row.destroy({ transaction });
      }

      remaining -= toDeduct;
    }

    await inventory.decrement('quantity', { by: quantity, transaction });

    await InventoryLog.create({
      productId,
      warehouseId,
      type: 'OUT',
      quantity: -quantity, // Represent stock out as a negative quantity in the log
      referenceId,
      reason: 'Manual Stock Out',
      userId: reqUser.id
    }, { transaction });

    // Re-sync reservations for this product in this warehouse
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(productId, warehouseId, transaction);

    await transaction.commit();
    return inventory.reload();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function transferStock(data, reqUser) {
  const { ProductStock, InventoryLog, sequelize } = require('../models');
  const { productId, fromLocationId, toLocationId, clientId, quantity, batchNumber, bestBeforeDate, reason } = data;

  const fromWarehouseId = data.fromWarehouseId || data.warehouseId;
  const toWarehouseId = data.toWarehouseId || fromWarehouseId;

  if (!clientId) throw new Error('Client is required for stock transfer');
  if (fromLocationId === toLocationId && fromWarehouseId === toWarehouseId) {
    throw new Error('Source and destination must be different');
  }

  const qty = parseInt(quantity);
  if (!qty || qty <= 0) throw new Error('Quantity must be greater than 0');
  const product = await Product.findByPk(productId);
  if (!product) throw new Error('Product not found');
  if (reqUser.role !== 'super_admin' && product.companyId !== reqUser.companyId) throw new Error('Product not found');

  const normalizedBatch = batchNumber && String(batchNumber).trim() !== '' ? String(batchNumber).trim() : null;
  const normalizedBbd = bestBeforeDate && String(bestBeforeDate).trim() !== '' ? String(bestBeforeDate).trim() : null;

  // Check if source stock row actually has a batch number
  const sourceStockCheck = await ProductStock.findOne({
    where: {
      productId,
      warehouseId: fromWarehouseId,
      locationId: fromLocationId,
      clientId: clientId || null,
      status: 'ACTIVE'
    }
  });

  // Only enforce batch tracking if product requires it AND source stock actually has a batch
  if (isTruthyYes(product.requireBatchTracking) && !normalizedBatch) {
    const sourceBatch = sourceStockCheck?.batchNumber;
    const hasSourceBatch = sourceBatch && String(sourceBatch).trim() !== '' && String(sourceBatch).toLowerCase() !== 'null';

    if (hasSourceBatch) {
      throw new Error(`${product.name || 'This product'} requires a Batch Number for this transfer because the source stock has one.`);
    }
  }
  if (isTruthyYes(product.perishable) && !bestBeforeDate) {
    throw new Error(`${product.name || 'This product'} requires a Best Before (Expiry) Date for this transfer`);
  }
  await validateHeatSensitivePlacement({ product, locationId: toLocationId, actionLabel: 'transferred' });

  return sequelize.transaction(async (t) => {
    // 1. Check Source
    const sourceBaseWhere = {
      productId,
      warehouseId: fromWarehouseId,
      locationId: fromLocationId,
      clientId: clientId || null,
      status: 'ACTIVE'
    };
    let source = null;
    if (normalizedBatch) {
      source = await ProductStock.findOne({
        where: { ...sourceBaseWhere, batchNumber: normalizedBatch },
        transaction: t,
      });
    }
    if (!source) {
      source = await ProductStock.findOne({
        where: sourceBaseWhere,
        order: [['quantity', 'DESC']],
        transaction: t,
      });
    }

    if (!source) {
      throw new Error('Insufficient stock in source location/warehouse');
    }

    // Bug Fix: Only fetch sourceRows matching the EXACT batch and bestBeforeDate of resolved source row
    const sourceRows = await ProductStock.findAll({
      where: {
        ...sourceBaseWhere,
        batchNumber: source.batchNumber,
        bestBeforeDate: source.bestBeforeDate
      },
      order: [['quantity', 'DESC']],
      transaction: t,
    });
    const availableTotal = sourceRows.reduce((sum, row) => sum + Math.round((Number(row.quantity) || 0) - (Number(row.reserved) || 0)), 0);
    if (availableTotal < qty) {
      throw new Error(`Insufficient available stock in source location for this product. Available: ${availableTotal}, Attempted: ${qty}`);
    }

    // 2. Add/Find Destination
    // Unique stock is defined by: Product, Location, Batch, BB Date, and Client.
    // If any of these differ, a new stock entry is created rather than consolidating.
    const [dest, created] = await ProductStock.findOrCreate({
      where: {
        productId,
        warehouseId: toWarehouseId,
        locationId: toLocationId,
        batchNumber: normalizedBatch || source.batchNumber || null,
        bestBeforeDate: normalizedBbd || source.bestBeforeDate || null,
        clientId: clientId || source.clientId || null,
        status: 'ACTIVE'
      },
      defaults: {
        companyId: product.companyId,
        quantity: 0,
        reserved: 0,
        status: 'ACTIVE'
      },
      transaction: t
    });

    // 3. Update Quantities (supports stock split across multiple batch rows)
    let remaining = qty;
    for (const row of sourceRows) {
      if (remaining <= 0) break;
      const rowQty = Number(row.quantity) || 0;
      if (rowQty <= 0) continue;
      const consume = Math.min(rowQty, remaining);

      // Safe subtraction in-memory & save instead of DB expression reload
      const newQty = Math.max(0, rowQty - consume);
      row.quantity = newQty;
      await row.save({ transaction: t });

      // Auto-delete zero-quantity source rows after transfer
      if (newQty <= 0) {
        await row.destroy({ transaction: t });
      }
      remaining -= consume;
    }
    await dest.increment('quantity', { by: qty, transaction: t });

    // SYNC Inventory Table (Warehouse Level)
    const { Inventory } = require('../models');

    // Decrement from source warehouse total
    const [sourceInv] = await Inventory.findOrCreate({
      where: { productId, warehouseId: fromWarehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction: t
    });
    await sourceInv.decrement('quantity', { by: qty, transaction: t });

    // Increment to destination warehouse total
    const [destInv] = await Inventory.findOrCreate({
      where: { productId, warehouseId: toWarehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction: t
    });
    await destInv.increment('quantity', { by: qty, transaction: t });


    // 4. Create Logs
    const logBase = {
      productId,
      clientId,
      userId: reqUser.id,
      batchNumber: normalizedBatch || source.batchNumber,
      bestBeforeDate: normalizedBbd || source.bestBeforeDate,
      referenceId: `TRANSFER: ${fromWarehouseId}:${fromLocationId} -> ${toWarehouseId}:${toLocationId}`,
      reason: reason || 'Internal Transfer'
    };

    // Source Log (OUT)
    await InventoryLog.create({
      ...logBase,
      warehouseId: fromWarehouseId,
      locationId: fromLocationId,
      type: 'TRANSFER',
      quantity: -qty
    }, { transaction: t });

    // Destination Log (IN)
    await InventoryLog.create({
      ...logBase,
      warehouseId: toWarehouseId,
      locationId: toLocationId,
      type: 'TRANSFER',
      quantity: qty
    }, { transaction: t });

    // Create a Movement record for the transfer
    const effectiveCompanyId = reqUser.companyId || product.companyId;
    if (!effectiveCompanyId) throw new Error('Company context required for movement tracking');

    await Movement.create({
      companyId: effectiveCompanyId,
      type: 'TRANSFER',
      productId,
      fromWarehouseId,
      toWarehouseId,
      fromLocationId,
      toLocationId,
      quantity: qty,
      reason: reason || 'Internal Transfer',
      createdBy: reqUser.id,
    }, { transaction: t });

    // Re-sync reservations for this product in the source and destination warehouses
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(productId, fromWarehouseId, t);
    if (fromWarehouseId !== toWarehouseId) {
      await orderService.syncReservationsForProduct(productId, toWarehouseId, t);
    }

    return { success: true };
  });
}


async function transfer(data, reqUser) {
  const { Inventory, InventoryLog, sequelize } = require('../models');
  const { fromWarehouseId, toWarehouseId, productId, quantity } = data;

  if (fromWarehouseId === toWarehouseId) {
    throw new Error('Source and destination warehouses must be different');
  }

  return sequelize.transaction(async (t) => {
    const source = await Inventory.findOne({
      where: { productId, warehouseId: fromWarehouseId },
      transaction: t
    });

    if (!source || source.quantity < quantity) {
      throw new Error('Insufficient stock in source warehouse');
    }

    const [dest] = await Inventory.findOrCreate({
      where: { productId, warehouseId: toWarehouseId },
      defaults: { quantity: 0, reservedQuantity: 0 },
      transaction: t
    });

    await source.decrement('quantity', { by: quantity, transaction: t });
    await dest.increment('quantity', { by: quantity, transaction: t });

    await InventoryLog.create({
      productId,
      warehouseId: fromWarehouseId,
      type: 'TRANSFER',
      quantity,
      referenceId: `To WH: ${toWarehouseId}`
    }, { transaction: t });

    await InventoryLog.create({
      productId,
      warehouseId: toWarehouseId,
      type: 'TRANSFER',
      quantity,
      referenceId: `From WH: ${fromWarehouseId}`
    }, { transaction: t });

    // Re-sync reservations for this product in the source and destination warehouses
    const orderService = require('./orderService');
    await orderService.syncReservationsForProduct(productId, fromWarehouseId, t);
    await orderService.syncReservationsForProduct(productId, toWarehouseId, t);

    return { success: true };
  });
}

async function reserveStock(data, t) {
  const { productId, companyId, warehouseId, clientId, quantity } = data;

  if (!productId || !warehouseId || !quantity || quantity <= 0) {
    throw new Error('Missing required fields for reservation');
  }

  // 1. Find available stock rows (FIFO: order by createdAt)
  const stockRows = await ProductStock.findAll({
    where: {
      productId,
      warehouseId,
      companyId,
      quantity: { [Op.gt]: sequelize.col('reserved') }
    },
    order: [
      [sequelize.literal('client_id IS NULL'), 'ASC'], // Non-null (specific client) first
      ['createdAt', 'ASC']
    ],
    transaction: t
  });

  const totalAvailable = stockRows.reduce((sum, row) => sum + (Number(row.quantity) - Number(row.reserved)), 0);
  if (totalAvailable < quantity) {
    throw new Error(`Insufficient available stock for reservation. Requested: ${quantity}, Available: ${totalAvailable}`);
  }

  let remaining = quantity;
  for (const row of stockRows) {
    if (remaining <= 0) break;
    const availableInRow = Number(row.quantity) - Number(row.reserved);
    const toReserve = Math.min(availableInRow, remaining);

    await row.increment('reserved', { by: toReserve, transaction: t });
    remaining -= toReserve;
  }

  // 2. Sync Warehouse Inventory
  const [inv] = await Inventory.findOrCreate({
    where: { productId, warehouseId },
    defaults: { quantity: 0, reservedQuantity: 0 },
    transaction: t
  });
  await inv.increment('reservedQuantity', { by: quantity, transaction: t });

  return { success: true };
}

async function unreserveStock(data, t) {
  const { productId, companyId, warehouseId, clientId, quantity } = data;

  // Find reserved rows (LIFO: reverse of reserve)
  const stockRows = await ProductStock.findAll({
    where: {
      productId,
      warehouseId,
      companyId,
      reserved: { [Op.gt]: 0 }
    },
    order: [
      [sequelize.literal('client_id IS NULL'), 'DESC'], // General stock last for unreserve
      ['createdAt', 'DESC']
    ],
    transaction: t
  });

  let remaining = quantity;
  for (const row of stockRows) {
    if (remaining <= 0) break;
    const reservedInRow = Number(row.reserved);
    const toUnreserve = Math.min(reservedInRow, remaining);

    await row.decrement('reserved', { by: toUnreserve, transaction: t });
    remaining -= toUnreserve;
  }

  // Sync Warehouse Inventory
  const inv = await Inventory.findOne({
    where: { productId, warehouseId },
    transaction: t
  });
  if (inv) {
    const toDeduct = Math.min(Number(inv.reservedQuantity), quantity);
    await inv.decrement('reservedQuantity', { by: toDeduct, transaction: t });
  }

  return { success: true };
}

async function shipStock(data, t) {
  const { productId, companyId, warehouseId, clientId, quantity, referenceId, userId } = data;

  if (!productId || !warehouseId || !quantity || quantity <= 0) {
    throw new Error('Missing required fields for shipping');
  }

  // 1. Find stock rows. Prioritize rows with reservations for this client/product.
  console.log(`[DEBUG_STOCK] Searching stock for Product: ${productId}, WH: ${warehouseId}, Company: ${companyId}`);
  const stockRows = await ProductStock.findAll({
    where: {
      productId,
      warehouseId,
      companyId,
      quantity: { [Op.gt]: 0 }
    },
    order: [
      [sequelize.literal('reserved DESC')], // Prioritize rows that have reservations
      [sequelize.literal('client_id IS NULL'), 'ASC'], // Then non-null client stock
      ['createdAt', 'ASC'] // Then FIFO
    ],
    transaction: t,
    lock: t.LOCK.UPDATE
  });

  const totalAvailable = stockRows.reduce((sum, row) => sum + Number(row.quantity), 0);
  console.log(`[DEBUG_STOCK] Found ${stockRows.length} rows for this company. Total Physical: ${totalAvailable}, Requested: ${quantity}`);

  if (stockRows.length === 0) {
    const allWhRows = await ProductStock.findAll({ where: { productId, quantity: { [Op.gt]: 0 } }, transaction: t });
    if (allWhRows.length > 0) {
      const locations = allWhRows.map(r => `WH:${r.warehouseId}(Qty:${r.quantity})`).join(', ');
      console.log(`[DEBUG_STOCK] Product ${productId} found in OTHER warehouses: ${locations}`);
    } else {
      console.log(`[DEBUG_STOCK] Product ${productId} NOT FOUND in ANY warehouse.`);
    }
  }

  if (totalAvailable < quantity) {
    throw new Error(`Insufficient physical stock for shipment. Requested: ${quantity}, Total Physical: ${totalAvailable}`);
  }

  let remaining = quantity;
  for (const row of stockRows) {
    if (remaining <= 0) break;
    const rowQty = Number(row.quantity);
    const rowRes = Number(row.reserved);
    const toDeduct = Math.min(rowQty, remaining);

    // Deduct from reserved as much as possible, then from free stock
    const resDeduct = Math.min(rowRes, toDeduct);

    await row.decrement('quantity', { by: toDeduct, transaction: t });
    if (resDeduct > 0) {
      await row.decrement('reserved', { by: resDeduct, transaction: t });
    }

    remaining -= toDeduct;
  }

  // 2. Sync Warehouse Inventory
  const inv = await Inventory.findOne({
    where: { productId, warehouseId },
    transaction: t,
    lock: t.LOCK.UPDATE
  });
  if (inv) {
    await inv.decrement('quantity', { by: quantity, transaction: t });
    const invResDeduct = Math.min(Number(inv.reservedQuantity), quantity);
    if (invResDeduct > 0) {
      await inv.decrement('reservedQuantity', { by: invResDeduct, transaction: t });
    }
  }

  // 3. Create Log
  await InventoryLog.create({
    productId,
    warehouseId,
    clientId: clientId || null,
    type: 'OUT',
    quantity: -quantity,
    referenceId: referenceId || 'SHIPMENT',
    userId,
    reason: 'Sales Order Shipment'
  }, { transaction: t });

  return { success: true };
}

async function bulkImportStock(stocksArray, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager' && reqUser.role !== 'warehouse_manager') {
    throw new Error('Not allowed to import inventory');
  }
  const companyId = reqUser.companyId;
  if (!companyId) throw new Error('Company context required');
  if (!Array.isArray(stocksArray) || stocksArray.length === 0) {
    throw new Error('No stocks to import');
  }

  const { Product, ProductStock, Warehouse, Zone, Location, Customer, Inventory, InventoryLog, sequelize } = require('../models');
  const results = { successCount: 0, failedCount: 0, errors: [] };

  // Pre-load all entities for the company to avoid database roundtrips inside the loop
  const products = await Product.findAll({ where: { companyId } });
  const warehouses = await Warehouse.findAll({ where: { companyId } });
  const customers = await Customer.findAll({ where: { companyId } });

  const zones = await Zone.findAll({ where: { companyId } });
  const zoneIds = zones.map(z => z.id);
  const locations = await Location.findAll({
    where: {
      zoneId: { [Op.in]: zoneIds }
    },
    include: [{ association: 'Zone' }]
  });

  const productMapBySku = new Map();
  const productMapByName = new Map();
  products.forEach(p => {
    productMapBySku.set(p.sku.toLowerCase().trim(), p);
    productMapByName.set(p.name.toLowerCase().trim(), p);
  });

  const warehouseMapByName = new Map();
  const warehouseMapByCode = new Map();
  warehouses.forEach(w => {
    warehouseMapByName.set(w.name.toLowerCase().trim(), w);
    warehouseMapByCode.set(w.code.toLowerCase().trim(), w);
  });

  const customerMapByName = new Map();
  const customerMapByCode = new Map();
  customers.forEach(c => {
    customerMapByName.set(c.name.toLowerCase().trim(), c);
    if (c.code) {
      customerMapByCode.set(c.code.toLowerCase().trim(), c);
    }
  });

  const locationMap = new Map();
  locations.forEach(l => {
    const whId = l.Zone?.warehouseId;
    if (whId) {
      if (l.code) locationMap.set(`${whId}-${l.code.toLowerCase().trim()}`, l);
      if (l.name) locationMap.set(`${whId}-${l.name.toLowerCase().trim()}`, l);
    }
  });

  for (let i = 0; i < stocksArray.length; i++) {
    const row = stocksArray[i];
    let transaction = null;
    try {
      // 1. Resolve Product
      const prodSearch = String(row.product || row.sku || '').toLowerCase().trim();
      let product = productMapBySku.get(prodSearch) || productMapByName.get(prodSearch);
      if (!product) {
        throw new Error(`Product SKU/Name "${row.product || row.sku || ''}" not found`);
      }

      // 2. Resolve Warehouse
      const whSearch = String(row.warehouse || '').toLowerCase().trim();
      let warehouse = warehouseMapByCode.get(whSearch) || warehouseMapByName.get(whSearch);
      if (!warehouse) {
        throw new Error(`Warehouse "${row.warehouse || ''}" not found`);
      }

      // 3. Resolve Location
      const locSearch = String(row.location || '').toLowerCase().trim();
      let location = null;
      if (locSearch) {
        location = locationMap.get(`${warehouse.id}-${locSearch}`);
        if (!location) {
          throw new Error(`Location "${row.location}" not found in warehouse "${warehouse.name}"`);
        }
      } else {
        throw new Error(`Location is mandatory to ensure stock tracking per bin`);
      }

      // 4. Resolve Client (Customer)
      const clientSearch = String(row.client || row.Client || '').toLowerCase().trim();
      let client = null;
      if (clientSearch) {
        client = customerMapByCode.get(clientSearch) || customerMapByName.get(clientSearch);
        if (!client) {
          throw new Error(`Client/Customer "${row.client || row.Client || ''}" not found`);
        }
      } else {
        throw new Error(`Client is mandatory for stock movement mapping`);
      }

      // 5. Parse Quantity
      const rawQty = parseInt(row.quantity, 10);
      if (isNaN(rawQty)) {
        throw new Error(`Invalid Quantity "${row.quantity}"`);
      }
      const qty = Math.abs(rawQty);
      if (qty === 0) {
        throw new Error('Quantity cannot be zero');
      }

      const type = rawQty > 0 ? 'INCREASE' : 'DECREASE';

      // 6. Validation for Perishable / Batch Tracking
      const requireBatchTracking = String(product.requireBatchTracking || '').toLowerCase() === 'yes' || product.requireBatchTracking === true || String(product.requireBatchTracking) === '1';
      const perishable = String(product.perishable || product.isPerishable || '').toLowerCase() === 'yes' || product.perishable === true || String(product.perishable) === '1';

      let batchNumber = row.batchNumber || row.batchId || row.BatchId || row['Batch Number'] || row['Batch ID'] || null;
      if (batchNumber) batchNumber = String(batchNumber).trim();

      if (requireBatchTracking && !batchNumber) {
        throw new Error(`Product "${product.sku}" requires a Batch Number for accurate tracking`);
      }

      let bestBeforeDate = row.bestBeforeDate || row.bbDate || row['BB Date'] || row['Best Before Date'] || null;
      if (bestBeforeDate) {
        const dateStr = String(bestBeforeDate).trim();
        const dmyMatch = dateStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (dmyMatch) {
          bestBeforeDate = `${dmyMatch[3]}-${dmyMatch[2].padStart(2, '0')}-${dmyMatch[1].padStart(2, '0')}`;
        } else {
          const parsed = new Date(dateStr);
          if (isNaN(parsed.getTime())) {
            bestBeforeDate = null;
          } else {
            bestBeforeDate = parsed.toISOString().slice(0, 10);
          }
        }
      }

      if (perishable && !bestBeforeDate) {
        throw new Error(`Perishable product "${product.sku}" requires a Best Before Date`);
      }

      // Check Heat Sensitive placement
      if (type === 'INCREASE' && String(product.heatSensitive || '').toLowerCase() === 'yes') {
        if (location.heatSensitive !== 'yes') {
          throw new Error(`Heat-sensitive product "${product.sku}" can only be booked to heat-sensitive locations`);
        }
      }

      transaction = await sequelize.transaction();

      const referenceNumber = 'BULK-' + Buffer.from(Date.now().toString(36) + Math.random().toString(36).slice(2)).toString('base64').replace(/[/+=]/g, '').slice(0, 8).toUpperCase();

      // Find or create exact stock record for this combination
      const stockWhere = {
        productId: product.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        batchNumber: batchNumber ? String(batchNumber).trim() : null,
        bestBeforeDate: bestBeforeDate || null,
        clientId: client.id
      };

      let stock = await ProductStock.findOne({ where: stockWhere, transaction });

      if (type === 'DECREASE') {
        if (!stock || (stock.quantity || 0) - (stock.reserved || 0) < qty) {
          throw new Error(`Insufficient available stock for this combination (${product.sku} at ${warehouse.name} ${location.name})`);
        }
      }

      // 1. Update ProductStock
      if (stock) {
        if (type === 'INCREASE') {
          await stock.increment('quantity', { by: qty, transaction });
        } else {
          await stock.decrement('quantity', { by: qty, transaction });
        }
        await stock.update({
          userId: reqUser.id,
          reason: `Bulk CSV adjustment (${type})`
        }, { transaction });
      } else if (type === 'INCREASE') {
        await ProductStock.create({
          companyId,
          productId: product.id,
          warehouseId: warehouse.id,
          locationId: location.id,
          batchNumber,
          quantity: qty,
          reserved: 0,
          bestBeforeDate,
          clientId: client.id,
          userId: reqUser.id,
          reason: 'Bulk CSV Import',
          status: 'ACTIVE',
        }, { transaction });
      }

      // 2. Sync Warehouse Level Total (Inventory Table)
      const [inv] = await Inventory.findOrCreate({
        where: { productId: product.id, warehouseId: warehouse.id },
        defaults: { quantity: 0, reservedQuantity: 0 },
        transaction
      });
      if (type === 'INCREASE') {
        await inv.increment('quantity', { by: qty, transaction });
      } else {
        await inv.decrement('quantity', { by: qty, transaction });
      }

      // 3. Create Entry in InventoryLog for history
      await InventoryLog.create({
        productId: product.id,
        warehouseId: warehouse.id,
        locationId: location.id,
        batchNumber,
        bestBeforeDate,
        clientId: client.id,
        userId: reqUser.id,
        type: type === 'INCREASE' ? 'IN' : 'OUT',
        quantity: qty,
        reason: `Bulk Import ${type === 'INCREASE' ? 'Stock In' : 'Stock Out'}`,
        referenceId: referenceNumber
      }, { transaction });

      await transaction.commit();
      results.successCount++;
    } catch (err) {
      if (transaction) await transaction.rollback();
      results.failedCount++;
      results.errors.push({
        row: i + 2, // 1-based, +1 for header
        product: row.product || row.sku || '',
        warehouse: row.warehouse || '',
        location: row.location || '',
        quantity: row.quantity || 0,
        message: err.message || 'Import failed'
      });
    }
  }

  return results;
}

async function bulkActionProducts(action, productIds, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin' && reqUser.role !== 'inventory_manager') {
    throw new Error('Not allowed to perform bulk actions');
  }

  const whereClause = { id: { [Op.in]: productIds } };
  if (reqUser.role !== 'super_admin') {
    whereClause.companyId = reqUser.companyId;
  }

  if (action === 'DELETE') {
    let deletedCount = 0;
    let deactivatedCount = 0;
    const products = await Product.findAll({ where: whereClause });

    for (const product of products) {
      try {
        await sequelize.transaction(async (t) => {
          await ProductStock.destroy({ where: { productId: product.id }, transaction: t });
          await product.destroy({ transaction: t });
        });
        deletedCount++;
      } catch (err) {
        await product.update({ status: 'INACTIVE' });
        deactivatedCount++;
      }
    }
    return { message: `Successfully deleted ${deletedCount} products. Deactivated ${deactivatedCount} products due to linked records.` };
  } else if (action === 'Mark Discontinued') {
    const updatedCount = await Product.update({ status: 'INACTIVE' }, { where: whereClause });
    return { message: `Successfully marked ${updatedCount[0]} products as discontinued (INACTIVE).` };
  } else {
    throw new Error('Invalid bulk action');
  }
}

async function reserveStockSoft(data, t) {
  const { productId, warehouseId, quantity } = data;
  const { Inventory, InventoryLog, ProductStock } = require('../models');

  // 1. Update warehouse-level summary (Inventory table) — for display on Inventory page
  const [inv] = await Inventory.findOrCreate({
    where: { productId, warehouseId },
    defaults: { quantity: 0, reservedQuantity: 0 },
    transaction: t
  });
  await inv.increment('reservedQuantity', { by: quantity, transaction: t });

  // 2. FIFO soft-reserve on granular ProductStock rows — prevents overselling
  // This ensures that even if two orders are created simultaneously, each ProductStock row
  // tracks its own reservation so the same physical stock can't be double-booked.
  const stockRows = await ProductStock.findAll({
    where: {
      productId,
      warehouseId,
      status: 'ACTIVE',
      quantity: { [Op.gt]: sequelize.col('reserved') }
    },
    order: [
      ['createdAt', 'ASC'] // FIFO — oldest stock reserved first
    ],
    transaction: t,
    lock: t ? t.LOCK.UPDATE : undefined
  });

  let remaining = quantity;
  for (const row of stockRows) {
    if (remaining <= 0) break;
    const availableInRow = Number(row.quantity) - Number(row.reserved);
    if (availableInRow <= 0) continue;
    const toReserve = Math.min(availableInRow, remaining);
    await row.increment('reserved', { by: toReserve, transaction: t });
    remaining -= toReserve;
  }
  // Note: if remaining > 0 after FIFO scan, it means stock is insufficient.
  // The caller (orderService) validates this BEFORE calling reserveStockSoft,
  // so we allow a soft "best effort" here without throwing.

  // 3. Audit log
  await InventoryLog.create({
    productId,
    warehouseId,
    type: 'ALLOCATE',
    quantity,
    referenceId: data.referenceId || null,
    reason: data.reason || 'Stock Reservation',
    userId: data.userId || null
  }, { transaction: t });

  return { success: true };
}

async function unreserveStockSoft(data, t) {
  const { productId, warehouseId, quantity } = data;
  const { Inventory, InventoryLog, ProductStock } = require('../models');

  // 1. Roll back warehouse-level summary (Inventory table)
  const inv = await Inventory.findOne({
    where: { productId, warehouseId },
    transaction: t
  });
  if (inv) {
    const toDeduct = Math.min(Number(inv.reservedQuantity), quantity);
    if (toDeduct > 0) {
      await inv.decrement('reservedQuantity', { by: toDeduct, transaction: t });
    }
  }

  // 2. LIFO roll-back on granular ProductStock rows (reverse of reservation)
  const stockRows = await ProductStock.findAll({
    where: {
      productId,
      warehouseId,
      status: 'ACTIVE',
      reserved: { [Op.gt]: 0 }
    },
    order: [
      ['createdAt', 'DESC'] // LIFO — most recently reserved row, unreserve first
    ],
    transaction: t,
    lock: t ? t.LOCK.UPDATE : undefined
  });

  let remaining = quantity;
  for (const row of stockRows) {
    if (remaining <= 0) break;
    const reservedInRow = Number(row.reserved);
    const toUnreserve = Math.min(reservedInRow, remaining);
    await row.decrement('reserved', { by: toUnreserve, transaction: t });
    remaining -= toUnreserve;
  }

  // 3. Audit log
  if (inv) {
    const logged = Math.min(Number(inv.reservedQuantity) + quantity, quantity); // Always log requested qty
    await InventoryLog.create({
      productId,
      warehouseId,
      type: 'DEALLOCATE',
      quantity: -quantity,
      referenceId: data.referenceId || null,
      reason: data.reason || 'Stock Unreservation',
      userId: data.userId || null
    }, { transaction: t });
  }

  return { success: true };
}

// Standard Exports
const inventoryService = {
  listProducts,
  listCategories,
  scanBarcode,
  getProductById,
  createProduct,
  bulkCreateProducts,
  bulkActionProducts,
  updateProduct,
  addAlternativeSku,
  removeProduct,
  createCategory,
  updateCategory,
  removeCategory,
  listStock,
  createStock,
  updateStock,
  removeStock,
  listStockByBestBeforeDate,
  listStockByLocation,
  listAdjustments,
  createAdjustment,
  listCycleCounts,
  createCycleCount,
  completeCycleCount,
  listBatches,
  createBatch,
  getBatchById,
  updateBatch,
  removeBatch,
  listMovements,
  createMovement,
  getMovementById,
  updateMovement,
  removeMovement,
  listInventory,
  listInventoryLogs,
  listInventoryLedger,
  stockIn,
  stockOut,
  transfer,
  transferStock,
  reserveStock,
  unreserveStock,
  reserveStockSoft,
  unreserveStockSoft,
  shipStock,
  exportProductsCsv,
  bulkImportStock,
};

module.exports = inventoryService;