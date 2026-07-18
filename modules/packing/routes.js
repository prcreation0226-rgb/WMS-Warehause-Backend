const express = require('express');
const router = express.Router();
const packingController = require('../../controllers/packingController');
const { authenticate, requireRole } = require('../../middlewares/auth');

router.use(authenticate);

router.get('/', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'packer'), packingController.list);
router.get('/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'packer'), packingController.getById);
router.post('/:id/assign', requireRole('super_admin', 'company_admin', 'warehouse_manager'), packingController.assignPacker);
router.post('/:id/start', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'packer'), packingController.startPacking);
router.post('/:id/reject', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'packer'), packingController.rejectAssignment);
router.post('/:id/complete', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'packer'), packingController.completePacking);

module.exports = router;
