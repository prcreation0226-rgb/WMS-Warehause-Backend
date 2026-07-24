require('dotenv').config();
// RESTART REQUIRED: Syncing scanBarcode implementation in inventoryService.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const uploadsDir = path.join(__dirname, 'uploads');
try {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
} catch (_) {
  /* multer may still work if dir exists elsewhere */
}

const { sequelize } = require('./models');
const routes = require('./routes');
const superadminController = require('./controllers/superadminController');
const purchaseOrderController = require('./controllers/purchaseOrderController');
const goodsReceiptController = require('./controllers/goodsReceiptController');
const orderController = require('./controllers/orderController');
const inventoryController = require('./controllers/inventoryController');
const { authenticate, requireSuperAdmin, requireRole, requireAdmin, requireStaff, requireClient } = require('./middlewares/auth');
const dashboardController = require('./controllers/dashboardController');
const reportController = require('./controllers/reportController');
const analyticsController = require('./controllers/analyticsController');
const cronService = require('./services/cronService');

const app = express();
const PORT = process.env.PORT || 3001;

function getBrokenMySqlTableName(err) {
  const errno = err?.errno ?? err?.original?.errno ?? err?.parent?.errno;
  const sql = err?.sql || err?.original?.sql || err?.parent?.sql || '';
  if (errno !== 1932 || !sql) return null;

  const match = sql.match(/SHOW\s+INDEX\s+FROM\s+`?([a-zA-Z0-9_]+)`?/i);
  return match ? match[1] : null;
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    // Allow all origins for now to fix user's Railway connection issue
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(uploadsDir));

// Sales orders - register FIRST so DELETE /api/orders/sales/:id never 404s
const soRoles = ['super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'];
const soWriteRoles = ['super_admin', 'company_admin'];
app.get('/api/orders/sales', authenticate, requireRole(...soRoles), orderController.list);
app.post('/api/orders/sales', authenticate, requireRole(...soWriteRoles), orderController.create);
app.post('/api/orders/sales/bulk-action', authenticate, requireRole(...soWriteRoles), orderController.bulkAction);
app.post('/api/orders/sales/import-csv', authenticate, requireRole(...soWriteRoles), orderController.importCsv);
app.get('/api/orders/saved-addresses', authenticate, requireRole(...soRoles), orderController.listSavedAddresses);
app.post('/api/orders/saved-addresses', authenticate, requireRole(...soWriteRoles), orderController.saveAddress);
app.put('/api/orders/saved-addresses/:id', authenticate, requireRole(...soWriteRoles), orderController.updateSavedAddress);
app.delete('/api/orders/saved-addresses/:id', authenticate, requireRole(...soWriteRoles), orderController.deleteSavedAddress);
app.post('/api/orders/sales/allocate-all', authenticate, requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), orderController.allocateAll);
app.get('/api/orders/sales/:id', authenticate, requireRole(...soRoles), orderController.getById);
app.get('/api/orders/sales/:id/pdf', authenticate, requireRole(...soRoles), orderController.downloadPdf);
app.post('/api/orders/sales/:id/printed', authenticate, requireRole(...soRoles), orderController.markAsPrinted);
app.put('/api/orders/sales/:id', authenticate, requireRole(...soWriteRoles), orderController.update);
app.put('/api/orders/sales/:id/notes', authenticate, requireRole(...soRoles), orderController.updateNotes);
app.delete('/api/orders/sales/:id', authenticate, requireRole(...soWriteRoles), orderController.remove);
app.post('/api/orders/sales/:id/allocate', authenticate, requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), orderController.allocate);


// Dashboard - single route /api/dashboard/:type so stats + charts dono chalenge
const dashboardRoles = ['super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'viewer', 'picker', 'packer'];
app.get('/api/dashboard/:type', authenticate, requireRole(...dashboardRoles), (req, res, next) => {
  const type = (req.params.type || '').toLowerCase();
  if (type === 'stats') return dashboardController.stats(req, res, next);
  if (type === 'charts') return dashboardController.charts(req, res, next);
  if (type === 'notifications') return dashboardController.notifications(req, res, next);
  res.status(404).json({ success: false, message: 'Not found. Use /api/dashboard/stats, /api/dashboard/charts or /api/dashboard/notifications' });
});
app.get('/api/reports', authenticate, requireRole(...dashboardRoles), reportController.list);
app.get('/api/reports/:id', authenticate, requireRole(...dashboardRoles), reportController.getById);
app.get('/api/reports/:id/download', authenticate, requireRole(...dashboardRoles), reportController.download);
app.post('/api/reports', authenticate, requireRole(...dashboardRoles), reportController.create);
app.put('/api/reports/:id', authenticate, requireRole(...dashboardRoles), reportController.update);
app.delete('/api/reports/:id', authenticate, requireRole(...dashboardRoles), reportController.remove);

// AI / Predictions
const predictionController = require('./controllers/predictionController');
app.get('/api/predictions', authenticate, requireRole(...dashboardRoles), predictionController.list);

// Analytics
app.post('/api/analytics/pricing-calculate', authenticate, requireRole(...dashboardRoles), analyticsController.pricingCalculate);
app.get('/api/analytics/margins', authenticate, requireRole(...dashboardRoles), analyticsController.marginsReport);

// Super admin APIs - register first so they always work
app.get('/api/superadmin/stats', authenticate, requireSuperAdmin, superadminController.stats);
app.get('/api/superadmin/reports', authenticate, requireSuperAdmin, superadminController.reports);

// Purchase orders - explicit routes so 404 doesn't happen
const poRoles = ['super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'viewer'];
const poWriteRoles = ['super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'];
app.get('/api/purchase-orders', authenticate, requireClient, purchaseOrderController.list);
app.get('/api/purchase-orders/:id', authenticate, requireClient, purchaseOrderController.getById);
app.post('/api/purchase-orders', authenticate, requireStaff, purchaseOrderController.create);
app.put('/api/purchase-orders/:id', authenticate, requireStaff, purchaseOrderController.update);
app.delete('/api/purchase-orders/:id', authenticate, requireAdmin, purchaseOrderController.remove);
app.post('/api/purchase-orders/:id/approve', authenticate, requireAdmin, purchaseOrderController.approve);

// Goods receiving - explicit routes
app.get('/api/goods-receiving', authenticate, requireClient, goodsReceiptController.list);
app.get('/api/goods-receiving/:id', authenticate, requireClient, goodsReceiptController.getById);
app.post('/api/goods-receiving', authenticate, requireStaff, goodsReceiptController.create);
app.put('/api/goods-receiving/:id/receive', authenticate, requireStaff, goodsReceiptController.updateReceived);
app.put('/api/goods-receiving/:id/asn', authenticate, requireStaff, goodsReceiptController.updateAsnItems);
app.post('/api/goods-receiving/:id/finalize', authenticate, requireStaff, goodsReceiptController.finalizeReceiving);
app.delete('/api/goods-receiving/:id', authenticate, requireAdmin, goodsReceiptController.remove);

// CSV Management for GRN
app.get('/api/goods-receiving/:id/csv-template', authenticate, requireStaff, goodsReceiptController.exportCsvTemplate);
app.post('/api/goods-receiving/:id/csv-import-bbd', authenticate, requireStaff, goodsReceiptController.importCsvBbd);

// Inventory products - explicit DELETE so /api/inventory/products/:id never 404s
const invProductRoles = ['super_admin', 'company_admin', 'inventory_manager'];
app.delete('/api/inventory/products/:id', authenticate, requireRole(...invProductRoles), inventoryController.removeProduct);

// POST /api/products/:id/alternative-skus (same handler as inventory, so client can call either path)
app.post('/api/products/:id/alternative-skus', authenticate, requireRole(...invProductRoles), inventoryController.addAlternativeSku);

const returnRoutes = require('./routes/returnRoutes');
app.use('/api/returns', returnRoutes);

app.get('/api/test-debug', async (req, res) => {
  try {
    const [columns] = await sequelize.query("DESCRIBE order_items");
    res.json({
      success: true,
      columns
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack
    });
  }
});

app.use(routes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
  });
});



async function start() {
  try {
    const dialect = sequelize.getDialect();
    if (dialect === 'sqlite') {
      const storage = sequelize.config.storage || path.join(__dirname, 'warehouse_wms.sqlite');
      const fullPath = path.isAbsolute(storage) ? storage : path.resolve(process.cwd(), storage);
      console.log('--- DB Check ---');
      console.log('Type: SQLite');
      console.log('File:', fullPath);
      console.log('---');
    } else {
      console.log('--- DB Check ---');
      console.log('Type:', dialect.toUpperCase());
      console.log('Host:', sequelize.config.host || 'localhost');
      console.log('Port:', sequelize.config.port || (dialect === 'mysql' ? 3306 : 'default'));
      console.log('User:', sequelize.config.username);
      console.log('DB:', sequelize.config.database);
      console.log('---');
    }

    await sequelize.authenticate();
    console.log('Connected to database successfully.');
    // SQLite: allow alter (drop/recreate tables) by disabling FK checks during sync
    if (dialect === 'sqlite') {
      await sequelize.query('PRAGMA foreign_keys = OFF');
      const [tables] = await sequelize.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_backup'");
      const queryInterface = sequelize.getQueryInterface();
      for (const t of tables) {
        try {
          await queryInterface.dropTable(t.name);
          console.log('Dropped leftover backup table:', t.name);
        } catch (e) {
          // ignore
        }
      }
    }
    const syncOptions = { alter: dialect === 'sqlite' };

    // MySQL and SQLite Manual Column Fixes helper
    const applyManualFixes = async () => {
      console.log('[DB] Applying manual column fixes...');
      const manualCols = [
        { t: 'inventory_adjustments', c: 'batch_id', type: 'INT' },
        { t: 'inventory_adjustments', c: 'batch_number', type: 'VARCHAR(255)' },
        { t: 'inventory_adjustments', c: 'client_id', type: 'INT' },
        { t: 'inventory_adjustments', c: 'location_id', type: 'INT' },
        { t: 'inventory_adjustments', c: 'best_before_date', type: 'DATE' },
        { t: 'inventory_adjustments', c: 'created_by', type: 'INT' },
        { t: 'inventory_logs', c: 'batch_id', type: 'INT' },
        { t: 'inventory_logs', c: 'batch_number', type: 'VARCHAR(255)' },
        { t: 'inventory_logs', c: 'client_id', type: 'INT' },
        { t: 'inventory_logs', c: 'location_id', type: 'INT' },
        { t: 'inventory_logs', c: 'best_before_date', type: 'DATE' },
        { t: 'inventory_logs', c: 'user_id', type: 'INT' },
        { t: 'inventory_logs', c: 'reason', type: 'VARCHAR(255)' },
        { t: 'inventory_logs', c: 'new_stock_level', type: 'INT' },
        { t: 'inventory_logs', c: 'new_allocated_level', type: 'INT' },
        { t: 'inventory_logs', c: 'new_on_hand_level', type: 'INT' },
        { t: 'inventory_logs', c: 'new_off_hand_level', type: 'INT DEFAULT 0' },
        { t: 'product_stocks', c: 'batch_id', type: 'INT' },
        { t: 'product_stocks', c: 'client_id', type: 'INT' },
        { t: 'product_stocks', c: 'location_id', type: 'INT' },
        { t: 'product_stocks', c: 'batch_number', type: 'VARCHAR(255)' },
        { t: 'product_stocks', c: 'reason', type: 'VARCHAR(255)' },
        { t: 'product_stocks', c: 'best_before_date', type: 'DATE' },
        { t: 'product_stocks', c: 'user_id', type: 'INT' },
        { t: 'categories', c: 'company_id', type: 'INT' },
        { t: 'products', c: 'pack_size', type: 'INT DEFAULT 1' },
        { t: 'products', c: 'color', type: 'VARCHAR(255)' },
        { t: 'products', c: 'supplier_id', type: 'INT' },
        { t: 'products', c: 'alternative_skus', type: 'LONGTEXT' },
        { t: 'products', c: 'supplier_products', type: 'LONGTEXT' },
        { t: 'products', c: 'price_lists', type: 'LONGTEXT' },
        { t: 'products', c: 'cartons', type: 'LONGTEXT' },
        { t: 'products', c: 'images', type: 'LONGTEXT' },
        { t: 'products', c: 'marketplace_skus', type: 'LONGTEXT' },
        { t: 'products', c: 'best_before_date_warning_period_days', type: 'INT DEFAULT 0' },
        { t: 'purchase_orders', c: 'warehouse_id', type: 'INT' },
        { t: 'purchase_orders', c: 'client_id', type: 'INT' },
        { t: 'goods_receipts', c: 'warehouse_id', type: 'INT' },
        { t: 'goods_receipts', c: 'delivery_type', type: 'VARCHAR(255)' },
        { t: 'goods_receipts', c: 'eta', type: 'DATETIME' },
        { t: 'goods_receipts', c: 'total_to_book', type: 'INT DEFAULT 0' },
        { t: 'movements', c: 'from_warehouse_id', type: 'INT' },
        { t: 'movements', c: 'to_warehouse_id', type: 'INT' },
        { t: 'movements', c: 'from_location_id', type: 'INT' },
        { t: 'movements', c: 'to_location_id', type: 'INT' },
        { t: 'movements', c: 'batch_id', type: 'INT' },
        { t: 'movements', c: 'company_id', type: 'INT' },
        { t: 'movements', c: 'created_by', type: 'INT' },
        { t: 'zones', c: 'warehouse_id', type: 'INT' },
        { t: 'zones', c: 'company_id', type: 'INT' },
        { t: 'locations', c: 'warehouse_id', type: 'INT' },
        { t: 'locations', c: 'zone_id', type: 'INT' },
        { t: 'locations', c: 'heat_sensitive', type: 'VARCHAR(255)' },
        { t: 'users', c: 'company_id', type: 'INT' },
        { t: 'users', c: 'warehouse_id', type: 'INT' },
        { t: 'users', c: 'status', type: 'VARCHAR(50) DEFAULT "ACTIVE"' },
        { t: 'supplier_products', c: 'effective_date', type: 'DATE' },
        { t: 'goods_receipt_items', c: 'unit_cost', type: 'DECIMAL(12, 2)' },
        { t: 'reports', c: 'content', type: 'LONGTEXT' },
        { t: 'reports', c: 'last_run_at', type: 'DATETIME' },
        { t: 'reports', c: 'report_name', type: 'VARCHAR(255)' },
        { t: 'reports', c: 'report_type', type: 'VARCHAR(255)' },
        { t: 'reports', c: 'category', type: 'VARCHAR(255)' },
        { t: 'reports', c: 'start_date', type: 'DATE' },
        { t: 'reports', c: 'end_date', type: 'DATE' },
        { t: 'reports', c: 'format', type: 'VARCHAR(50)' },
        { t: 'reports', c: 'schedule', type: 'VARCHAR(50)' },
        { t: 'reports', c: 'status', type: 'VARCHAR(50)' },
        { t: 'batches', c: 'grn_id', type: 'INT' },
        { t: 'batches', c: 'client_id', type: 'INT' },
        { t: 'batches', c: 'company_id', type: 'INT' },
        { t: 'goods_receipts', c: 'client_id', type: 'INT' },
        { t: 'goods_receipts', c: 'company_id', type: 'INT' },
        { t: 'product_stocks', c: 'company_id', type: 'INT' },
        { t: 'audit_logs', c: 'client_id', type: 'INT' },
        { t: 'companies', c: 'header_image_url', type: 'TEXT' },
        { t: 'customers', c: 'header_image_url', type: 'TEXT' },
        { t: 'customers', c: 'packing_slip_footer', type: 'TEXT' },
        { t: 'suppliers', c: 'header_image_url', type: 'TEXT' },
        { t: 'order_items', c: 'warehouse_id', type: 'INT' },
        { t: 'sales_orders', c: 'external_ref', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'parts', type: 'VARCHAR(50) DEFAULT "1of1"' },
        { t: 'sales_orders', c: 'postcode', type: 'VARCHAR(50)' },
        { t: 'sales_orders', c: 'country', type: 'VARCHAR(100)' },
        { t: 'sales_orders', c: 'courier_name', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'courier_service', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'requested_shipping_service', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'required_despatch_date', type: 'DATE' },
        { t: 'sales_orders', c: 'required_delivery_date', type: 'DATE' },
        { t: 'sales_orders', c: 'no_of_parcels', type: 'INT DEFAULT 1' },
        { t: 'sales_orders', c: 'total_weight', type: 'DECIMAL(10, 3) DEFAULT 0.0' },
        { t: 'sales_orders', c: 'total_items', type: 'INT DEFAULT 1' },
        { t: 'sales_orders', c: 'tracking_status', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'tracking_number', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'tags', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'batch_id', type: 'INT DEFAULT 0' },
        { t: 'sales_orders', c: 'order_lock', type: 'BOOLEAN DEFAULT false' },
        { t: 'sales_orders', c: 'sequence_number', type: 'INT' },
        { t: 'products', c: 'default_picking_location_id', type: 'INT' },
        { t: 'products', c: 'is_discontinued', type: 'TINYINT(1) DEFAULT 0' },
        { t: 'products', c: 'client_id', type: 'INT' },
        { t: 'order_items', c: 'location_id', type: 'INT' },
        { t: 'order_items', c: 'batch_number', type: 'VARCHAR(255)' },
        { t: 'order_items', c: 'best_before_date', type: 'DATE' },
        { t: 'sales_orders', c: 'recipient_name', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'address_line1', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'address_line2', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'address_line3', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'town', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'county', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'phone', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'email', type: 'VARCHAR(255)' },
        { t: 'saved_addresses', c: 'customer_id', type: 'INT' },
        { t: 'pick_list_items', c: 'warehouse_id', type: 'INT' },
        { t: 'pick_list_items', c: 'location_id', type: 'INT' },
        { t: 'pick_list_items', c: 'batch_number', type: 'VARCHAR(255)' },
        { t: 'pick_list_items', c: 'best_before_date', type: 'DATE' },
        { t: 'despatch_note_templates', c: 'show_footer_image', type: 'TINYINT(1) DEFAULT 1' },
        { t: 'despatch_note_templates', c: 'show_footer_message', type: 'TINYINT(1) DEFAULT 1' },
        { t: 'sales_orders', c: 'notes_from_buyer', type: 'TEXT' },
        { t: 'sales_orders', c: 'notes_to_buyer', type: 'TEXT' },
        { t: 'sales_orders', c: 'gift_note', type: 'TEXT' },
        { t: 'sales_orders', c: 'internal_notes', type: 'TEXT' },
        { t: 'sales_orders', c: 'custom_field2', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'custom_field3', type: 'VARCHAR(255)' },
        { t: 'order_items', c: 'net_price', type: 'DECIMAL(12, 2)' },
        { t: 'order_items', c: 'gross_price', type: 'DECIMAL(12, 2)' },
        { t: 'order_items', c: 'vat_rate', type: 'DECIMAL(5, 2)' },
        { t: 'order_items', c: 'vat_amount', type: 'DECIMAL(12, 2)' },
        { t: 'sales_orders', c: 'net_amount', type: 'DECIMAL(12, 2)' },
        { t: 'sales_orders', c: 'vat_amount', type: 'DECIMAL(12, 2)' },
        { t: 'sales_orders', c: 'shipstation_order_id', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'shipstation_store_id', type: 'VARCHAR(255)' },
        { t: 'sales_orders', c: 'check_content_required', type: 'TINYINT(1) DEFAULT 1' },
        { t: 'sales_orders', c: 'is_bundle', type: 'TINYINT(1) DEFAULT 0' },
        { t: 'order_items', c: 'scanned_qty', type: 'INT DEFAULT 0' },
        { t: 'order_items', c: 'is_bundle_parent', type: 'TINYINT(1) DEFAULT 0' },
        { t: 'order_items', c: 'bundle_header', type: 'VARCHAR(255)' },
        { t: 'order_items', c: 'product_image_url', type: 'TEXT' },
      ];
      for (const col of manualCols) {
        try {
          await sequelize.query(`ALTER TABLE ${col.t} ADD COLUMN ${col.c} ${col.type} NULL`);
          // console.log(`[DB] Column ${col.t}.${col.c} added successfully`);
        } catch (err) {
          if (!err.message.includes('Duplicate column') && 
              !err.message.includes('duplicate column name') && 
              !err.message.includes('Table') && 
              !err.message.includes("doesn't exist")) {
            console.warn(`[DB] Column ${col.t}.${col.c} error: ${err.message.slice(0, 60)}`);
          }
        }
      }
      if (dialect === 'mysql') {
        const manualAlters = [
          { t: 'goods_receipts', c: 'total_expected', type: 'DECIMAL(12, 3)' },
          { t: 'goods_receipts', c: 'total_received', type: 'DECIMAL(12, 3)' },
          { t: 'goods_receipts', c: 'total_to_book', type: 'DECIMAL(12, 3)' },
          { t: 'goods_receipt_items', c: 'expected_qty', type: 'DECIMAL(12, 3)' },
          { t: 'goods_receipt_items', c: 'received_qty', type: 'DECIMAL(12, 3)' },
          { t: 'goods_receipt_items', c: 'qty_to_book', type: 'DECIMAL(12, 3)' },
        ];
        for (const col of manualAlters) {
          try {
            await sequelize.query(`ALTER TABLE ${col.t} MODIFY COLUMN ${col.c} ${col.type}`);
            // console.log(`[DB] Column ${col.t}.${col.c} altered to ${col.type}`);
          } catch (err) {
            // ignore if table/col doesn't exist yet, it will be created by sync
          }
        }
      }

      // Ensure unique index for sku + client_id + company_id in products table
      try {
        await sequelize.query("ALTER TABLE products ADD UNIQUE KEY idx_products_company_client_sku (company_id, client_id, sku)");
      } catch (err) {
        if (!err.message.includes('Duplicate key name') && !err.message.includes("doesn't exist")) {
          console.warn('[DB] Unique index products error:', err.message);
        }
      }

      // Ensure all reserved columns in product_stocks are defaulted to 0, not NULL
      try {
        await sequelize.query("UPDATE product_stocks SET reserved = 0 WHERE reserved IS NULL");
      } catch (err) {
        if (!err.message.includes("doesn't exist")) {
          console.warn('[DB] product_stocks reserved reset error:', err.message);
        }
      }
    };

    // Apply manual fixes first for all dialects
    await applyManualFixes();

    if (dialect === 'mysql') {
      let syncDone = false;
      for (let attempt = 1; attempt <= 3 && !syncDone; attempt += 1) {
        try {
          await sequelize.sync(syncOptions);
          syncDone = true;
        } catch (syncErr) {
          console.warn(`[DB] Sync attempt ${attempt} failed: ${syncErr.message.slice(0, 100)}`);

          const brokenTable = getBrokenMySqlTableName(syncErr);
          const isMissingCol = syncErr.message.includes("doesn't exist") || syncErr.original?.errno === 1072;

          if (isMissingCol) {
            console.log('[DB] Missing column detected, retrying manual fixes...');
            await applyManualFixes();
            continue;
          }

          if (!brokenTable || attempt === 3) {
            throw syncErr;
          }

          console.warn(`[DB] Corrupted table metadata detected for "${brokenTable}". Attempting to drop and recreate.`);
          try {
            await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
            await sequelize.query(`DROP TABLE IF EXISTS \`${brokenTable}\``);
            await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
            console.log(`[DB] Dropped broken table "${brokenTable}". Retrying sync (${attempt + 1}/3)...`);
          } catch (dropErr) {
            try {
              await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
            } catch (_) { /* ignore cleanup errors */ }
            throw dropErr;
          }
        }
      }
    } else {
      await sequelize.sync(syncOptions);
    }

    console.log('Database synced successfully.');

    // BACKFILL locationId, batchNumber, bestBeforeDate, warehouseId for old PickListItems
    try {
      const { PickListItem, PickList, OrderItem } = require('./models');
      const items = await PickListItem.findAll({ where: { locationId: null } });
      if (items.length > 0) {
        console.log(`[DB] Backfilling location/batch details for ${items.length} PickListItems...`);
        for (const item of items) {
          const pickList = await PickList.findByPk(item.pickListId);
          if (pickList) {
            // Find corresponding OrderItem
            const orderItem = await OrderItem.findOne({
              where: {
                salesOrderId: pickList.salesOrderId,
                productId: item.productId,
                quantity: item.quantityRequired
              }
            });
            if (orderItem) {
              await item.update({
                locationId: orderItem.locationId,
                batchNumber: orderItem.batchNumber,
                bestBeforeDate: orderItem.bestBeforeDate,
                warehouseId: orderItem.warehouseId
              });
            } else {
              // Fallback to any order item for this salesOrderId and productId
              const anyOrderItem = await OrderItem.findOne({
                where: {
                  salesOrderId: pickList.salesOrderId,
                  productId: item.productId
                }
              });
              if (anyOrderItem) {
                await item.update({
                  locationId: anyOrderItem.locationId,
                  batchNumber: anyOrderItem.batchNumber,
                  bestBeforeDate: anyOrderItem.bestBeforeDate,
                  warehouseId: anyOrderItem.warehouseId
                });
              }
            }
          }
        }
        console.log('[DB] PickListItem backfill complete.');
      }
    } catch (e) {
      console.warn('[DB] PickListItem backfill error:', e.message);
    }

    // BACKFILL warehouse_id for old OrderItems
    try {
      const { OrderItem, PickList } = require('./models');
      const items = await OrderItem.findAll({ where: { warehouseId: null } });
      if (items.length > 0) {
        console.log(`[DB] Backfilling warehouseId for ${items.length} OrderItems...`);
        for (const item of items) {
          const pickList = await PickList.findOne({ where: { salesOrderId: item.salesOrderId } });
          const warehouseId = pickList ? pickList.warehouseId : 1;
          await item.update({ warehouseId });
        }
        // console.log('[DB] Backfill complete.');
      }
    } catch (e) {
      console.warn('[DB] Backfill error:', e.message);
    }
    // BACKFILL running level snapshots for old InventoryLogs
    try {
      const { InventoryLog, Inventory } = require('./models');
      const { Op } = require('sequelize');
      const logsToFix = await InventoryLog.findAll({
        where: {
          [Op.or]: [
            { newStockLevel: null },
            { newAllocatedLevel: null },
            { newOnHandLevel: null }
          ]
        }
      });
      if (logsToFix.length > 0) {
        console.log(`[DB] Backfilling running level snapshots for ${logsToFix.length} legacy logs...`);
        const inventories = await Inventory.findAll();
        const invMap = {};
        for (const inv of inventories) {
          invMap[`${inv.productId}-${inv.warehouseId}`] = inv;
        }

        const promises = logsToFix.map(log => {
          const inv = invMap[`${log.productId}-${log.warehouseId}`];
          const updateData = inv ? {
            newStockLevel: inv.quantity || 0,
            newAllocatedLevel: inv.reservedQuantity || 0,
            newOnHandLevel: Math.max(0, (inv.quantity || 0) - (inv.reservedQuantity || 0)),
            newOffHandLevel: 0
          } : {
            newStockLevel: 0,
            newAllocatedLevel: 0,
            newOnHandLevel: 0,
            newOffHandLevel: 0
          };
          return log.update(updateData);
        });

        await Promise.all(promises);
        console.log('[DB] Legacy logs level backfill complete.');
      }
    } catch (e) {
      console.warn('[DB] Failed to backfill legacy log levels:', e.message);
    }
    // BACKFILL products with a default clientId if it is null
    try {
      const { Product, Customer } = require('./models');
      const nullClientProducts = await Product.findAll({ where: { clientId: null } });
      if (nullClientProducts.length > 0) {
        console.log(`[DB] Backfilling clientId for ${nullClientProducts.length} legacy products...`);
        let defaultClient = await Customer.findOne({ where: { companyId: nullClientProducts[0].companyId } });
        if (!defaultClient) {
          defaultClient = await Customer.create({
            companyId: nullClientProducts[0].companyId,
            name: 'Default Client',
            code: 'DFTCL',
            status: 'ACTIVE'
          });
          console.log('[SEED] Created default customer/client for backfill');
        }
        for (const p of nullClientProducts) {
          await p.update({ clientId: defaultClient.id });
        }
        console.log('[DB] Product clientId backfill complete.');
      }
    } catch (e) {
      console.warn('[DB] Failed to backfill product clientId:', e.message);
    }

    try {
      const { Product } = require('./models');
      const allProds = await Product.findAll({ attributes: ['id', 'sku', 'name', 'clientId'] });
      const lines = allProds.map(p => `ID: ${p.id} | SKU: ${p.sku} | Name: ${p.name} | ClientID: ${p.clientId}`);
      fs.writeFileSync(path.join(__dirname, 'products_debug.txt'), lines.join('\n'));
      console.log('[DEBUG] Logged all products to products_debug.txt');
    } catch (err) {
      console.error('[DEBUG] Failed to write products debug file:', err.message);
    }

    // BACKFILL SalesOrders with realistic seed data if they don't have it
    try {
      const { SalesOrder, Customer } = require('./models');
      const orders = await SalesOrder.findAll();

      const couriers = ['Royal Mail', 'DPD'];
      const courierServices = ['Royal Mail Tracked 48 | Standard', 'Royal Mail Tracked 24 | Express', 'DPD Next Day - Parcel | Standard'];
      const requestedShippingServices = ['Standard Delivery', 'Express Delivery', 'Next Day Guaranteed', 'Economy Shipping'];
      const channels = ['AMAZON', 'EBAY', 'SHOPIFY', 'DIRECT'];

      for (const order of orders) {
        let needsUpdate = false;
        const updates = {};

        // Clear hardcoded "demo" / "DEMO" notes
        if (order.notes && (order.notes.toLowerCase() === '-' || order.notes === '-')) {
          updates.notes = null;
          needsUpdate = true;
        }

        if (!order.postcode || !order.country) {
          const cust = order.customerId ? await Customer.findByPk(order.customerId) : null;
          updates.postcode = cust?.postcode || 'SW1A 1AA';
          updates.country = cust?.country || 'UNITED KINGDOM';
          needsUpdate = true;
        }

        if (!order.recipientName || order.recipientName === 'Demo Customer' || order.recipientName.toLowerCase() === 'demo') {
          const cust = order.customerId ? await Customer.findByPk(order.customerId) : null;
          let nameVal = '-';
          if (cust) {
            const possibleNames = [cust.contactPerson, cust.name];
            for (const n of possibleNames) {
              if (n && n.toLowerCase() !== 'demo' && n.toLowerCase() !== 'demo customer' && n.trim() !== '-') {
                nameVal = n;
                break;
              }
            }
          }
          updates.recipientName = nameVal;
          needsUpdate = true;
        }

        if (!order.courierName) {
          updates.courierName = couriers[order.id % couriers.length];
          needsUpdate = true;
        }

        if (!order.courierService) {
          updates.courierService = courierServices[order.id % courierServices.length];
          needsUpdate = true;
        }

        if (!order.requestedShippingService) {
          updates.requestedShippingService = requestedShippingServices[order.id % requestedShippingServices.length];
          needsUpdate = true;
        }

        if (!order.externalRef) {
          updates.externalRef = `EXT-${1000000 + order.id}`;
          needsUpdate = true;
        }

        if (!order.parts) {
          updates.parts = `1of1`;
          needsUpdate = true;
        }

        if (!order.requiredDespatchDate) {
          updates.requiredDespatchDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          needsUpdate = true;
        }

        if (!order.requiredDeliveryDate) {
          updates.requiredDeliveryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          needsUpdate = true;
        }

        if (!order.tags) {
          const tagOptions = ['PRIME', 'HEAVY', 'FRAGILE', 'GIFT', ''];
          updates.tags = tagOptions[order.id % tagOptions.length];
          needsUpdate = true;
        }

        if (order.batchId === null || order.batchId === undefined || order.batchId === 0) {
          updates.batchId = order.id % 3 === 0 ? order.id : 0;
          needsUpdate = true;
        }

        if (needsUpdate) {
          await order.update(updates);
        }
      }
    } catch (e) {
      console.warn('[DB] SalesOrder backfill seed error:', e.message);
    }

    // Reset pending GoodsReceiptItem qtyToBook to 0 on startup so they don't show as fully received
    try {
      const { GoodsReceipt, GoodsReceiptItem } = require('./models');
      const { Op } = require('sequelize');
      const pendingItems = await GoodsReceiptItem.findAll({
        include: [{ association: 'GoodsReceipt', where: { status: 'pending' } }],
        where: { qtyToBook: { [Op.gt]: 0 } }
      });
      if (pendingItems.length > 0) {
        console.log(`[DB] Resetting qtyToBook to 0 for ${pendingItems.length} pending GoodsReceiptItems...`);
        for (const item of pendingItems) {
          await item.update({ qtyToBook: 0 });
        }
      }
    } catch (e) {
      console.warn('[DB] Reset pending qtyToBook error:', e.message);
    }

    // AUTO-SEED DEMO USERS if they don't exist (For 'Proper' Live Demo Experience)
    const bcrypt = require('bcryptjs');
    const { User, Company } = require('./models');

    // Ensure at least one company exists for demo users
    let defaultCompany = await Company.findByPk(1);
    if (!defaultCompany) {
      defaultCompany = await Company.create({
        id: 1,
        name: 'KIAAN WMS Demo',
        code: 'KIAAN',
        status: 'ACTIVE'
      });
      console.log('[SEED] Created default demo company');
    }

    const demoUsers = [
      { email: 'admin@kiaan-wms.com', password: 'Admin@123', name: 'Super Admin', role: 'super_admin' },
      { email: 'companyadmin@kiaan-wms.com', password: '123456', name: 'Company Admin', role: 'company_admin' },
      { email: 'inventorymanager@kiaan-wms.com', password: '123456', name: 'Inventory Manager', role: 'inventory_manager' },
      { email: 'warehousemanager@kiaan-wms.com', password: '123456', name: 'Warehouse Manager', role: 'warehouse_manager' },
      { email: 'piker@gmail.com', password: '123456', name: 'Picker', role: 'picker' },
      { email: 'packer@gmail.com', password: '123456', name: 'Packer', role: 'packer' },
    ];
    for (const d of demoUsers) {
      const exists = await User.findOne({ where: { email: d.email } });
      if (!exists) {
        const passwordHash = await bcrypt.hash(d.password, 10);
        await User.create({
          email: d.email,
          passwordHash,
          name: d.name,
          role: d.role,
          companyId: d.role === 'super_admin' ? null : 1, // Fallback to company 1
          status: 'ACTIVE'
        });
        console.log(`[SEED] Created demo user: ${d.email}`);
      }
    }

    // Initialize Cron AFTER database sync is complete
    cronService.init();

    app.listen(PORT, () => {
      const liveUrl = process.env.NODE_ENV === 'production' ? 'https://wms-aksh-backend-production.up.railway.app' : `http://localhost:${PORT}`;
      console.log(`WMS Backend running at ${liveUrl}`);
      console.log('Auth: POST /auth/login | GET /auth/me (Bearer token)');
      console.log('Super Admin: /api/superadmin/companies');
      console.log('Company: /api/company/profile');
      console.log('Users: /api/users');
      console.log('Warehouses: /api/warehouses');
      console.log('Inventory: /api/inventory/products, /api/inventory/categories, /api/inventory/stock');
      console.log('Orders: /api/orders/sales, /api/orders/customers');
      console.log('Suppliers: /api/suppliers | Bundles: /api/bundles');
      console.log('Picking: /api/picking');
      console.log('Packing: /api/packing');
      console.log('Shipments: /api/shipments');
      console.log('Purchase orders: /api/purchase-orders');
      console.log('Goods receiving: /api/goods-receiving');
    });


  } catch (err) {
    console.error('Unable to start server:', err);

    const isConnErr = err?.code === 'ECONNREFUSED' || err?.parent?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.parent?.code === 'ETIMEDOUT';

    if (isConnErr && (process.env.DB_DIALECT || 'sqlite') === 'mysql') {
      console.error('\n--- Database Connection Error ---');
      console.error('Details:', err.message);
      console.error('\nHow to fix:');
      console.log('1. Check if MySQL is running (Locally or on Cloud)');
      console.log('2. If you are on Railway, make sure you have:');
      console.log('   - Linked a MySQL service to this backend.');
      console.log('   - Added "DB_DIALECT=mysql" in Railway Variables.');
      console.log('   - Check if you need to use MYSQL_URL (Private Networking).');
      console.log('3. Your current DB host was:', sequelize.config.host || 'localhost');
      console.log('   (If this says "localhost" on Railway, it will NOT work!)\n');
    }
    process.exit(1);
  }
}

// Retrying server start to pick up new routes - triggered restart 2
start();
