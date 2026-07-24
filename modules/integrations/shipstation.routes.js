const express = require('express');
const router = express.Router();
const shipstationController = require('./shipstation.controller');
const { authenticate, requireAdmin } = require('../../middlewares/auth');

router.post('/webhook', shipstationController.webhook);
router.post('/sync-orders', authenticate, requireAdmin, shipstationController.syncOrders);

module.exports = router;
