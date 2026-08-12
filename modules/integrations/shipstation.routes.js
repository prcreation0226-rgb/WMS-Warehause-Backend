const express = require('express');
const router = express.Router();
const shipstationController = require('./shipstation.controller');
const { authenticate, requireAdmin } = require('../../middlewares/auth');

router.post('/webhook', shipstationController.webhook);
router.post('/sync-orders', authenticate, requireAdmin, shipstationController.syncOrders);
router.get('/store-mappings', authenticate, requireAdmin, shipstationController.getStoreMappings);
router.post('/store-mappings', authenticate, requireAdmin, shipstationController.saveStoreMappings);
router.get('/stores', authenticate, requireAdmin, shipstationController.getStores);

// ShipStation API V2 Dedicated Endpoints
router.post('/rates', authenticate, requireAdmin, shipstationController.getRates);
router.get('/shipments', authenticate, requireAdmin, shipstationController.listShipments);
router.post('/shipments', authenticate, requireAdmin, shipstationController.createShipment);
router.post('/labels', authenticate, requireAdmin, shipstationController.createV2Label);
router.post('/return-labels', authenticate, requireAdmin, shipstationController.createReturnLabel);
router.post('/batches', authenticate, requireAdmin, shipstationController.createBatchLabels);
router.post('/manifests', authenticate, requireAdmin, shipstationController.createManifest);
router.post('/pickups', authenticate, requireAdmin, shipstationController.schedulePickup);
router.get('/inventory', authenticate, requireAdmin, shipstationController.getInventoryLevels);
router.get('/warehouses', authenticate, requireAdmin, shipstationController.getInventoryWarehouses);
router.get('/locations', authenticate, requireAdmin, shipstationController.getInventoryLocations);
router.get('/users', authenticate, requireAdmin, shipstationController.getUsers);

module.exports = router;
