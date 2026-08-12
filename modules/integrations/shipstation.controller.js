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

async function getStores(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const stores = await shipstationService.getShipStationStores(companyId);
    res.json({ success: true, stores });
  } catch (err) {
    next(err);
  }
}

async function getStoreMappings(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const config = await IntegrationConfig.findOne({
      where: { companyId, platform: 'SHIPSTATION' }
    });
    const creds = config && config.credentials ? (typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials) : {};
    
    // Fetch live connected stores from ShipStation API if available
    let liveStores = [];
    try {
      liveStores = await shipstationService.getShipStationStores(companyId);
    } catch (e) {
      // Ignore
    }

    res.json({
      success: true,
      apiKey: creds.apiKey || process.env.SHIPSTATION_API_KEY || '',
      storeMappings: creds.storeMappings || {},
      stores: liveStores
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

    // Auto-trigger Order Sync immediately upon connecting/saving
    let syncResult = null;
    try {
      syncResult = await shipstationService.syncOrdersFromShipStation(companyId);
    } catch (err) {
      console.error('[ShipStation Auto-Sync Error on Connect]:', err.message);
    }

    const syncedCount = syncResult?.syncedCount || 0;
    const msg = syncResult?.success
      ? `✅ ShipStation connected successfully! ${syncedCount} orders automatically synced into WMS.`
      : 'ShipStation settings saved. Please check credentials if sync fails.';

    res.json({
      success: true,
      message: msg,
      storeMappings: newCreds.storeMappings,
      syncedCount
    });
  } catch (err) {
    next(err);
  }
}

async function getRates(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const rates = await shipstationService.getRates(companyId, req.body);
    res.json({ success: true, data: rates });
  } catch (err) { next(err); }
}

async function createShipment(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const result = await shipstationService.createShipment(companyId, req.body);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

async function listShipments(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.listShipments(companyId, req.query);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createV2Label(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createV2Label(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createReturnLabel(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createReturnLabel(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createBatchLabels(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createBatchLabels(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function createManifest(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.createManifest(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function schedulePickup(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.schedulePickup(companyId, req.body);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryLevels(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryLevels(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryWarehouses(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryWarehouses(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getInventoryLocations(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getInventoryLocations(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

async function getUsers(req, res, next) {
  try {
    const companyId = req.user.companyId || 1;
    const data = await shipstationService.getUsers(companyId);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

module.exports = {
  syncOrders,
  webhook,
  getStoreMappings,
  saveStoreMappings,
  getStores,
  getRates,
  createShipment,
  listShipments,
  createV2Label,
  createReturnLabel,
  createBatchLabels,
  createManifest,
  schedulePickup,
  getInventoryLevels,
  getInventoryWarehouses,
  getInventoryLocations,
  getUsers
};
