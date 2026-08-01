const { IntegrationConfig } = require('../../models');
const shipstationService = require('./shipstation.service');

async function syncOrders(req, res, next) {
  try {
    const companyId = req.user.companyId || req.body.companyId || 1;
    const result = await shipstationService.syncOrdersFromShipStation(companyId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function webhook(req, res, next) {
  try {
    const companyId = req.query.companyId || 1;
    await shipstationService.syncOrdersFromShipStation(companyId);
    res.json({ success: true });
  } catch (err) {
    console.error('ShipStation webhook error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getStoreMappings(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });
    const creds = config && config.credentials ? (typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials) : {};
    res.json({
      success: true,
      apiKey: creds.apiKey || process.env.SHIPSTATION_API_KEY || '',
      storeMappings: creds.storeMappings || {}
    });
  } catch (err) {
    next(err);
  }
}

async function saveStoreMappings(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const { storeMappings, apiKey, apiSecret } = req.body;

    let config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });

    const oldCreds = config && config.credentials ? (typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials) : {};
    const newCreds = {
      apiKey: apiKey && apiKey !== '********' ? apiKey : (oldCreds.apiKey || process.env.SHIPSTATION_API_KEY || ''),
      apiSecret: apiSecret && apiSecret !== '********' ? apiSecret : (oldCreds.apiSecret || process.env.SHIPSTATION_API_SECRET || ''),
      storeMappings: storeMappings || oldCreds.storeMappings || {}
    };

    const payload = {
      companyId,
      platform: 'SHIPSTATION',
      status: 'ACTIVE',
      credentials: JSON.stringify(newCreds)
    };

    if (config) {
      await config.update(payload);
    } else {
      await IntegrationConfig.create(payload);
    }

    res.json({ success: true, message: 'ShipStation store mappings saved successfully', storeMappings: newCreds.storeMappings });
  } catch (err) {
    next(err);
  }
}

module.exports = { syncOrders, webhook, getStoreMappings, saveStoreMappings };
