const express = require('express');
const router = express.Router();
const shipstationController = require('./shipstation.controller');
const { authenticate, requireAdmin } = require('../../middlewares/auth');

router.post('/webhook', shipstationController.webhook);
router.post('/sync-orders', authenticate, requireAdmin, shipstationController.syncOrders);
router.get('/store-mappings', authenticate, requireAdmin, shipstationController.getStoreMappings);
router.post('/store-mappings', authenticate, requireAdmin, shipstationController.saveStoreMappings);

module.exports = router;
