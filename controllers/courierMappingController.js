const { CourierMapping, CourierService } = require('../models');

async function list(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const mappings = await CourierMapping.findAll({
      where: { companyId },
      order: [['requestedService', 'ASC']]
    });
    res.json({ success: true, data: mappings });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const companyId = req.user.companyId;
    const { requestedService, courierName, courierService } = req.body;
    
    if (!requestedService || !courierName || !courierService) {
      return res.status(400).json({ success: false, message: 'requestedService, courierName and courierService are required' });
    }

    // Check for duplicate requestedService mapping for this company
    const existing = await CourierMapping.findOne({
      where: { companyId, requestedService }
    });
    if (existing) {
      return res.status(400).json({ success: false, message: `Mapping for requested service "${requestedService}" already exists` });
    }

    const mapping = await CourierMapping.create({
      companyId,
      requestedService,
      courierName,
      courierService
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
    const { requestedService, courierName, courierService } = req.body;

    const mapping = await CourierMapping.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier mapping not found' });
    }

    if (requestedService) {
      // Check duplicate
      const duplicate = await CourierMapping.findOne({
        where: {
          companyId,
          requestedService,
          id: { [require('sequelize').Op.ne]: id }
        }
      });
      if (duplicate) {
        return res.status(400).json({ success: false, message: `Mapping for requested service "${requestedService}" already exists` });
      }
      mapping.requestedService = requestedService;
    }

    if (courierName) mapping.courierName = courierName;
    if (courierService) mapping.courierService = courierService;

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

    const mapping = await CourierMapping.findOne({
      where: { id, companyId }
    });
    if (!mapping) {
      return res.status(404).json({ success: false, message: 'Courier mapping not found' });
    }

    await mapping.destroy();
    res.json({ success: true, message: 'Courier mapping deleted successfully' });
  } catch (err) {
    next(err);
  }
}

async function getAvailableServices(req, res, next) {
  try {
    const companyId = req.user.companyId;
    
    // Check if there are custom courier services defined for this company
    const customServices = await CourierService.findAll({
      where: { companyId },
      order: [['courier', 'ASC'], ['serviceName', 'ASC']]
    });

    if (customServices && customServices.length > 0) {
      const services = {};
      for (const cs of customServices) {
        if (!services[cs.courier]) {
          services[cs.courier] = [];
        }
        // Avoid duplicate service names for same courier
        if (!services[cs.courier].includes(cs.serviceName)) {
          services[cs.courier].push(cs.serviceName);
        }
      }
      return res.json({ success: true, data: services });
    }

    const services = {
      'Royal Mail': [
        'Royal Mail Tracked 24',
        'Royal Mail Tracked 48',
        'Royal Mail Special Delivery',
        'Royal Mail 24',
        'Royal Mail 48'
      ],
      'Parcel Force': [
        'Parcel Force Express 24',
        'Parcel Force Express 48',
        'Parcel Force Express 9',
        'Parcel Force Express 10'
      ],
      'DPD': [
        'DPD Next Day',
        'DPD 10:30',
        'DPD 12:00',
        'DPD Saturday',
        'DPD Sunday'
      ]
    };
    res.json({ success: true, data: services });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, create, update, remove, getAvailableServices };
