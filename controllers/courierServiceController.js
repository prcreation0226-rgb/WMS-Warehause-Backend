const { CourierService, sequelize } = require('../models');

async function list(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const services = await CourierService.findAll({
      where: { companyId },
      order: [['courier', 'ASC'], ['serviceName', 'ASC']]
    });
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { courier, serviceCode, serviceName } = req.body;

    if (!courier || !serviceCode || !serviceName) {
      return res.status(400).json({ success: false, message: 'courier, serviceCode and serviceName are required' });
    }

    const mapping = await CourierService.create({
      companyId,
      courier: courier.trim(),
      serviceCode: serviceCode.trim(),
      serviceName: serviceName.trim()
    });

    res.json({ success: true, data: mapping });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;
    const { courier, serviceCode, serviceName } = req.body;

    const mapping = await CourierService.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier service code not found' });
    }

    if (courier) mapping.courier = courier.trim();
    if (serviceCode) mapping.serviceCode = serviceCode.trim();
    if (serviceName) mapping.serviceName = serviceName.trim();

    await mapping.save();
    res.json({ success: true, data: mapping });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { id } = req.params;

    const mapping = await CourierService.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier service code not found' });
    }

    await mapping.destroy();
    res.json({ success: true, message: 'Courier service code deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function importCsv(req, res, next) {
  const companyId = req.user.companyId;
  const rows = req.body.rows;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, message: 'No rows to import' });
  }

  const t = await sequelize.transaction();
  try {
    // Delete existing services for this company
    await CourierService.destroy({ where: { companyId }, transaction: t });

    // Parse and bulk create
    const toCreate = [];
    for (const row of rows) {
      const courier = row['Courier'] || row['courier'];
      const serviceCode = row['Service Code'] || row['serviceCode'] || row['service_code'] || row['Code'] || row['code'];
      const serviceName = row['Service Name'] || row['serviceName'] || row['service_name'] || row['Name'] || row['name'];

      if (!courier || !serviceCode || !serviceName) {
        throw new Error('All rows must contain Courier, Service Code, and Service Name values');
      }

      toCreate.push({
        companyId,
        courier: String(courier).trim(),
        serviceCode: String(serviceCode).trim(),
        serviceName: String(serviceName).trim()
      });
    }

    const created = await CourierService.bulkCreate(toCreate, { transaction: t });
    await t.commit();

    res.json({ success: true, count: created.length });
  } catch (err) {
    await t.rollback();
    res.status(400).json({ success: false, message: err.message });
  }
}

module.exports = { list, create, update, remove, importCsv };
