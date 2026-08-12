const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { authenticate } = require('../middlewares/auth');
const customDataController = require('../controllers/customDataController');

router.get('/', authenticate, customDataController.list);
router.post('/', authenticate, customDataController.create);
router.put('/:id', authenticate, customDataController.update);
router.delete('/:id', authenticate, customDataController.remove);
router.post('/upload-csv', authenticate, upload.single('file'), customDataController.uploadCsv);
router.get('/export-csv', authenticate, customDataController.exportCsv);

module.exports = router;
