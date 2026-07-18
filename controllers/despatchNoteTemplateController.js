const despatchNoteTemplateService = require('../services/despatchNoteTemplateService');

async function list(req, res, next) {
  try {
    const data = await despatchNoteTemplateService.list(req.user, req.query);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const data = await despatchNoteTemplateService.getById(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Template not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const data = await despatchNoteTemplateService.create(req.body, req.user);
    res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.message?.includes('already exists') || err.message?.includes('required')) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const data = await despatchNoteTemplateService.update(req.params.id, req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.message === 'Template not found') return res.status(404).json({ success: false, message: err.message });
    if (err.message?.includes('already exists')) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const data = await despatchNoteTemplateService.remove(req.params.id, req.user);
    res.json(data);
  } catch (err) {
    if (err.message === 'Template not found') return res.status(404).json({ success: false, message: err.message });
    next(err);
  }
}

module.exports = { list, getById, create, update, remove };
