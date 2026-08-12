const packingService = require('../services/packingService');

async function list(req, res, next) {
  try {
    const data = await packingService.list(req.user, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const data = await packingService.getById(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Packing task not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function assignPacker(req, res, next) {
  try {
    const data = await packingService.assignPacker(req.params.id, req.body.userId, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Invalid packer') return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
}

async function completePacking(req, res, next) {
  try {
    const data = await packingService.completePacking(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Not assigned to you') return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function startPacking(req, res, next) {
  try {
    const data = await packingService.startPacking(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function rejectAssignment(req, res, next) {
  try {
    const data = await packingService.rejectAssignment(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function scanOrderByBarcode(req, res, next) {
  try {
    const data = await packingService.getPackingScanOrderByBarcode(req.params.barcode, req.user);
    res.json({ success: true, data });
  } catch (err) {
    res.status(404).json({ success: false, message: err.message });
  }
}

async function toggleCheck(req, res, next) {
  try {
    const data = await packingService.toggleCheckOrderContent(req.params.id, req.body.checkContentRequired);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function scanItem(req, res, next) {
  try {
    const data = await packingService.scanPackingItem(req.params.id, req.body.skuOrBarcode);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

async function dispatchOrder(req, res, next) {
  try {
    const forceOverride = Boolean(req.body.forceOverride);
    const data = await packingService.dispatchPackingOrder(req.params.id, req.user, forceOverride);
    res.json(data);
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

async function verifyAll(req, res, next) {
  try {
    const data = await packingService.verifyAllPackingItems(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

async function clearAll(req, res, next) {
  try {
    const data = await packingService.clearAllPackingItems(req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

async function verifyItem(req, res, next) {
  try {
    const data = await packingService.verifyPackingItemById(req.params.id, req.params.itemId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

async function clearItem(req, res, next) {
  try {
    const data = await packingService.clearPackingItemById(req.params.id, req.params.itemId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
}

module.exports = {
  list,
  getById,
  assignPacker,
  completePacking,
  startPacking,
  rejectAssignment,
  scanOrderByBarcode,
  toggleCheck,
  scanItem,
  verifyAll,
  clearAll,
  verifyItem,
  clearItem,
  dispatchOrder
};
