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

module.exports = { syncOrders, webhook };
