const orderService = require('../services/orderService');
const allocationService = require('../services/allocationService');
const { SavedAddress } = require('../models');

async function list(req, res, next) {
  try {
    const data = await orderService.list(req.user, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const data = await orderService.getById(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const data = await orderService.create(req.body, req.user);
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.message?.includes('Company Admin')) return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const data = await orderService.update(req.params.id, req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    if (err.message?.includes('Only pending')) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const data = await orderService.remove(req.params.id, req.user);
    res.json({ success: true, ...data });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    if (err.message?.includes('cannot be deleted') || err.message?.includes('can be deleted')) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
}

async function bulkAction(req, res, next) {
  try {
    const data = await orderService.bulkAction(req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function allocate(req, res, next) {
  try {
    const result = await allocationService.allocateOrder(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function allocateAll(req, res, next) {
  try {
    const result = await orderService.allocateAllOrders(req.user);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function listSavedAddresses(req, res, next) {
  try {
    const data = await SavedAddress.findAll({
      where: { companyId: req.user.companyId },
      include: [{ association: 'Client', attributes: ['id', 'name', 'code'] }],
      order: [['recipientName', 'ASC']]
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function saveAddress(req, res, next) {
  try {
    const data = await SavedAddress.create({
      ...req.body,
      companyId: req.user.companyId
    });
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function importCsv(req, res, next) {
  try {
    const result = await orderService.importCsv(req.body.rows, req.user);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function downloadPdf(req, res, next) {
  try {
    const { buffer, filename } = await orderService.generateDespatchNotePdf(req.params.id, req.user);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function updateSavedAddress(req, res, next) {
  try {
    const address = await SavedAddress.findByPk(req.params.id);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
    if (req.user.role !== 'super_admin' && address.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    await address.update(req.body);
    res.json({ success: true, data: address });
  } catch (err) {
    next(err);
  }
}

async function deleteSavedAddress(req, res, next) {
  try {
    const address = await SavedAddress.findByPk(req.params.id);
    if (!address) return res.status(404).json({ success: false, message: 'Address not found' });
    if (req.user.role !== 'super_admin' && address.companyId !== req.user.companyId) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    await address.destroy();
    res.json({ success: true, message: 'Address deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function syncReservations(req, res, next) {
  try {
    const result = await orderService.syncReservations(req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.message?.includes('Not authorized')) return res.status(403).json({ success: false, message: err.message });
    next(err);
  }
}

async function markAsPrinted(req, res, next) {
  try {
    const result = await orderService.markAsPrinted(req.params.id, req.user);
    res.json(result);
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function updateNotes(req, res, next) {
  try {
    const data = await orderService.updateNotes(req.params.id, req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

module.exports = { list, getById, create, update, updateNotes, remove, bulkAction, allocate, allocateAll, listSavedAddresses, saveAddress, importCsv, downloadPdf, updateSavedAddress, deleteSavedAddress, syncReservations, markAsPrinted };
