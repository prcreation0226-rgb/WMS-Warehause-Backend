const pickingService = require('../services/pickingService');

async function list(req, res, next) {
  try {
    const data = await pickingService.list(req.user, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const data = await pickingService.getById(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Pick list not found' || err.message === 'Not assigned to you') {
      return res.status(404).json({ success: false, message: err.message });
    }
    next(err);
  }
}

async function assignPicker(req, res, next) {
  try {
    const data = await pickingService.assignPicker(req.params.id, req.body.userId, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message?.includes('assign') || err.message === 'Invalid picker') {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
}

async function startPicking(req, res, next) {
  try {
    const data = await pickingService.startPicking(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Not assigned to you') return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function updatePickedQuantity(req, res, next) {
  try {
    const data = await pickingService.updatePickedQuantity(req.params.itemId, req.body.quantityPicked, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function completePicking(req, res, next) {
  try {
    const data = await pickingService.completePicking(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Not assigned to you') return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function rejectAssignment(req, res, next) {
  try {
    const data = await pickingService.rejectAssignment(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Not assigned to you') return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function deletePickList(req, res, next) {
  try {
    const { id } = req.params;
    console.log(`[pickingController] Received request to delete pick list ID: ${id} by user: ${req.user.id}`);
    
    const result = await pickingService.deletePickList(id, req.user);
    
    console.log(`[pickingController] Successfully deleted pick list ID: ${id}`);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`[pickingController] Error deleting pick list ID: ${req.params.id}:`, err);
    // Send actual database/general error message to frontend
    res.status(err.status || 500).json({ success: false, message: err.message || 'Failed to delete pick list' });
  }
}

module.exports = { list, getById, assignPicker, startPicking, updatePickedQuantity, completePicking, rejectAssignment, deletePickList };
