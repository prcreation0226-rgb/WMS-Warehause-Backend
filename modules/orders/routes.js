const express = require('express');
const router = express.Router();
const orderController = require('../../controllers/orderController');
const customerController = require('../../controllers/customerController');
const courierMappingController = require('../../controllers/courierMappingController');
const despatchNoteTemplateController = require('../../controllers/despatchNoteTemplateController');
const { authenticate, requireRole } = require('../../middlewares/auth');
const courierServiceController = require('../../controllers/courierServiceController');

router.use(authenticate);

router.get('/sales', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.list);
router.post('/sales/bulk-action', requireRole('super_admin', 'company_admin'), orderController.bulkAction);
router.post('/sales/import-csv', requireRole('super_admin', 'company_admin'), orderController.importCsv);
router.post('/sales/sync-reservations', requireRole('super_admin', 'company_admin'), orderController.syncReservations);
router.get('/sales/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.getById);
router.post('/sales', requireRole('super_admin', 'company_admin'), orderController.create);
router.post('/sales/:id/allocate', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), orderController.allocate);
router.put('/sales/:id', requireRole('super_admin', 'company_admin'), orderController.update);
router.put('/sales/:id/notes', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.updateNotes);
router.post('/sales/:id/printed', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.markAsPrinted);
router.delete('/sales/:id', requireRole('super_admin', 'company_admin'), orderController.remove);

router.get('/saved-addresses', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), orderController.listSavedAddresses);
router.post('/saved-addresses', requireRole('super_admin', 'company_admin'), orderController.saveAddress);
router.put('/saved-addresses/:id', requireRole('super_admin', 'company_admin'), orderController.updateSavedAddress);
router.delete('/saved-addresses/:id', requireRole('super_admin', 'company_admin'), orderController.deleteSavedAddress);

// Dispatch Note Templates routes
router.get('/despatch-templates', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), despatchNoteTemplateController.list);
router.get('/despatch-templates/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'picker', 'packer', 'viewer'), despatchNoteTemplateController.getById);
router.post('/despatch-templates', requireRole('super_admin', 'company_admin'), despatchNoteTemplateController.create);
router.put('/despatch-templates/:id', requireRole('super_admin', 'company_admin'), despatchNoteTemplateController.update);
router.delete('/despatch-templates/:id', requireRole('super_admin', 'company_admin'), despatchNoteTemplateController.remove);

router.get('/customers', requireRole('super_admin', 'company_admin', 'inventory_manager', 'picker', 'packer', 'viewer'), customerController.list);
router.get('/customers/:id', requireRole('super_admin', 'company_admin', 'inventory_manager', 'picker', 'packer', 'viewer'), customerController.getById);
router.post('/customers', requireRole('super_admin', 'company_admin'), customerController.create);
router.put('/customers/:id', requireRole('super_admin', 'company_admin'), customerController.update);
router.delete('/customers/:id', requireRole('super_admin', 'company_admin'), customerController.remove);

// Courier mappings CRUD and available services
router.get('/courier-mappings', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.list);
router.get('/courier-mappings/available-services', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.getAvailableServices);
router.post('/courier-mappings', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.create);
router.put('/courier-mappings/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.update);
router.delete('/courier-mappings/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager'), courierMappingController.remove);

// Courier service codes CRUD & CSV import
router.get('/courier-services', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'viewer', 'picker', 'packer'), courierServiceController.list);
router.post('/courier-services', requireRole('super_admin', 'company_admin'), courierServiceController.create);
router.put('/courier-services/:id', requireRole('super_admin', 'company_admin'), courierServiceController.update);
router.delete('/courier-services/:id', requireRole('super_admin', 'company_admin'), courierServiceController.remove);
router.post('/courier-services/import-csv', requireRole('super_admin', 'company_admin'), courierServiceController.importCsv);

module.exports = router;
