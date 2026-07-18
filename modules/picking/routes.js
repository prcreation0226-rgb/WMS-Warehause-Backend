const express = require('express');
const router = express.Router();
const pickingController = require('../../controllers/pickingController');
const { authenticate, requireRole } = require('../../middlewares/auth');

router.use(authenticate);

router.get('/', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.list);
router.get('/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.getById);
router.delete('/:id', requireRole('super_admin', 'company_admin', 'warehouse_manager'), pickingController.deletePickList);
router.put('/:id/assign', requireRole('super_admin', 'company_admin', 'warehouse_manager'), pickingController.assignPicker);
router.post('/:id/assign', requireRole('super_admin', 'company_admin', 'warehouse_manager'), pickingController.assignPicker);
router.post('/:id/start', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.startPicking);
router.post('/:id/reject', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.rejectAssignment);
router.put('/:id/items/:itemId', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.updatePickedQuantity);
router.post('/:id/complete', requireRole('super_admin', 'company_admin', 'warehouse_manager', 'picker'), pickingController.completePicking);

module.exports = router;
