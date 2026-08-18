const express = require('express');
const router = express.Router();
const { IntegrationConfig, IntegrationLog } = require('../models');
const { authenticate, requireRole } = require('../middlewares/auth');
const royalMailService = require('../services/royalMailService');
const dpdService = require('../services/dpdService');

const safeParse = (str) => {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    return {};
  }
};

const adminRoles = ['super_admin', 'company_admin'];

/**
 * GET /api/integrations
 * Retrieve all integration settings and status
 */
router.get('/', authenticate, requireRole(...adminRoles), async (req, res, next) => {
  try {
    const companyId = req.user.companyId;
    const configs = await IntegrationConfig.findAll({
      where: { companyId }
    });

    const dbPlatforms = configs.map(c => c.platform.toUpperCase());

    // Normalize response, hiding credentials/secrets
    const response = configs.map(c => {
      const creds = safeParse(c.credentials);
      // Mask access tokens & secrets
      const maskedCreds = {};
      for (const k in creds) {
        if (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('key') || k.toLowerCase().includes('cert')) {
          maskedCreds[k] = '********';
        } else {
          maskedCreds[k] = creds[k];
        }
      }

      return {
        id: c.id,
        platform: c.platform.toLowerCase(),
        status: c.status,
        lastSyncTime: c.lastSyncTime,
        credentials: maskedCreds,
        updatedAt: c.updatedAt
      };
    });

    // Detect environment variables configuration fallbacks
    const envConfigs = [
      {
        platform: 'shopify_ffd',
        hasEnv: !!(process.env.SHOPIFY_FFD_DOMAIN && process.env.SHOPIFY_FFD_ACCESS_TOKEN),
        creds: { shopDomain: process.env.SHOPIFY_FFD_DOMAIN, accessToken: '********' }
      },
      {
        platform: 'shopify_wholesale',
        hasEnv: !!(process.env.SHOPIFY_WHOLESALE_DOMAIN && process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN),
        creds: { shopDomain: process.env.SHOPIFY_WHOLESALE_DOMAIN, accessToken: '********' }
      },
      {
        platform: 'amazon',
        hasEnv: !!(process.env.AMAZON_CLIENT_ID && process.env.AMAZON_CLIENT_SECRET),
        creds: { sellerId: process.env.AMAZON_SELLER_ID, clientId: '********', clientSecret: '********', refreshToken: '********' }
      },
      {
        platform: 'ebay',
        hasEnv: !!(
          (process.env.EBAY_ENV === 'SANDBOX' ? process.env.EBAY_SANDBOX_APP_ID : process.env.EBAY_PROD_APP_ID) &&
          (process.env.EBAY_ENV === 'SANDBOX' ? process.env.EBAY_SANDBOX_CERT_ID : process.env.EBAY_PROD_CERT_ID)
        ),
        creds: {
          env: process.env.EBAY_ENV || 'PRODUCTION',
          appId: process.env.EBAY_ENV === 'SANDBOX' ? process.env.EBAY_SANDBOX_APP_ID : process.env.EBAY_PROD_APP_ID,
          devId: '********',
          certId: '********',
          refreshToken: '********'
        }
      },
      {
        platform: 'royal_mail',
        hasEnv: !!(process.env.ROYAL_MAIL_AUTH_KEY && process.env.ROYAL_MAIL_ACCOUNT_NUMBER),
        creds: { accountNumber: process.env.ROYAL_MAIL_ACCOUNT_NUMBER, authKey: '********' }
      },
      {
        platform: 'dpd',
        hasEnv: !!(
          (process.env.DPD_ENV === 'SANDBOX' ? process.env.DPD_SANDBOX_KEY : process.env.DPD_LIVE_KEY) &&
          (process.env.DPD_ENV === 'SANDBOX' ? process.env.DPD_SANDBOX_SECRET : process.env.DPD_LIVE_SECRET)
        ),
        creds: {
          env: process.env.DPD_ENV || 'SANDBOX',
          key1: process.env.DPD_ENV === 'SANDBOX' ? process.env.DPD_SANDBOX_KEY : process.env.DPD_LIVE_KEY,
          secret: '********'
        }
      }
    ];

    // Inject active platforms configured in env but missing in DB configurations
    for (const ec of envConfigs) {
      if (ec.hasEnv && !dbPlatforms.includes(ec.platform.toUpperCase())) {
        response.push({
          id: `env_${ec.platform}`,
          platform: ec.platform,
          status: 'ACTIVE',
          lastSyncTime: null,
          credentials: ec.creds,
          updatedAt: new Date()
        });
      }
    }

    res.json({ success: true, data: response });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/connect
 * Create or update integration configuration
 */
router.post('/connect', authenticate, requireRole(...adminRoles), async (req, res, next) => {
  try {
    const companyId = req.user.companyId;
    const { platform, credentials } = req.body;

    if (!platform || !credentials) {
      return res.status(400).json({ success: false, message: 'Platform and credentials are required' });
    }

    let existingConfig = await IntegrationConfig.findOne({
      where: { companyId, platform }
    });

    // Parse incoming credentials
    let finalCreds = { ...credentials };

    // If updating, preserve existing tokens/secrets if they were passed masked
    if (existingConfig) {
      const safeParse = (str) => {
        if (!str) return {};
        if (typeof str === 'object') return str;
        try {
          return JSON.parse(str);
        } catch (e) {
          return {};
        }
      };
      const oldCreds = safeParse(existingConfig.credentials);
      for (const k in finalCreds) {
        if (finalCreds[k] === '********') {
          finalCreds[k] = oldCreds[k];
        }
      }
    }

    const payload = {
      companyId,
      platform,
      status: 'ACTIVE',
      credentials: JSON.stringify(finalCreds)
    };

    if (existingConfig) {
      await existingConfig.update(payload);
    } else {
      existingConfig = await IntegrationConfig.create(payload);
    }

    let extraMessage = '';
    if (platform === 'SHIPSTATION') {
      const shipstationService = require('../modules/integrations/shipstation.service');
      const syncRes = await shipstationService.syncOrdersFromShipStation(companyId);
      if (syncRes.success) {
        extraMessage = ` (${syncRes.syncedCount || 0} orders synced)`;
      }
    }

    await IntegrationLog.create({
      companyId,
      platform,
      actionType: 'CONNECT',
      status: 'SUCCESS',
      message: `Integration connected and activated for ${platform}`
    });

    res.json({ success: true, message: `Successfully connected to ${platform}${extraMessage}` });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/disconnect
 * Deactivate and remove config
 */
router.post('/disconnect', authenticate, requireRole(...adminRoles), async (req, res, next) => {
  try {
    const companyId = req.user.companyId;
    const { platform } = req.body;

    const config = await IntegrationConfig.findOne({
      where: { companyId, platform }
    });

    if (!config) {
      // Return success if disconnecting an env-configured platform (no DB record was present)
      return res.json({ success: true, message: `Successfully disconnected ${platform}. Note: This integration is managed via server environment configuration.` });
    }

    await config.update({ status: 'INACTIVE' });

    await IntegrationLog.create({
      companyId,
      platform,
      actionType: 'DISCONNECT',
      status: 'SUCCESS',
      message: `Integration disconnected/deactivated for ${platform}`
    });

    res.json({ success: true, message: `Successfully disconnected ${platform}` });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/integrations/sync
 * Manually trigger synchronization for a channel
 */
router.post('/sync', authenticate, requireRole(...adminRoles), async (req, res, next) => {
  try {
    const companyId = req.user.companyId;
    const { platform, startDate, endDate } = req.body;

    if (!platform) {
      return res.status(400).json({ success: false, message: 'Platform name is required' });
    }

    if (platform === 'SHIPSTATION') {
      const shipstationService = require('../modules/integrations/shipstation.service');
      shipstationService.syncAllFromShipStation(companyId, { startDate, endDate }).then(resObj => {
        console.log(`[ShipStation Master 12-Domain Sync Complete]: ${resObj?.message}`);
      }).catch(err => {
        console.error('[ShipStation Master Sync Error]:', err.message);
      });

      const dateInfo = (startDate || endDate) ? ` (${startDate || 'Start'} to ${endDate || 'Today'})` : '';
      return res.json({
        success: true,
        message: `⚡ ShipStation 12-Domain Master Sync started${dateInfo}! Products, Warehouses, Inventory, Carriers & Orders are updating in WMS.`
      });
    } else if (['SHOPIFY_FFD', 'SHOPIFY_WHOLESALE', 'AMAZON', 'EBAY'].includes(platform)) {
      return res.json({
        success: true,
        message: 'Direct channel order sync disabled. All marketplace orders flow centrally via ShipStation API V2.'
      });
    } else if (platform === 'ROYAL_MAIL') {
      const manifestId = await royalMailService.submitManifest(companyId);
      recordsCount = manifestId ? 1 : 0;
    } else if (platform === 'DPD') {
      const manifestId = await dpdService.submitManifest(companyId);
      recordsCount = manifestId ? 1 : 0;
    } else {
      return res.status(400).json({ success: false, message: 'Invalid or unsupported synchronization platform' });
    }

    res.json({ success: true, message: `Sync complete! Processed ${recordsCount} orders.` });
  } catch (err) {
    res.status(500).json({ success: false, message: `Sync failed: ${err.message}` });
  }
});

/**
 * GET /api/integrations/logs
 * Retrieve recent integration log history
 */
router.get('/logs', authenticate, requireRole(...adminRoles), async (req, res, next) => {
  try {
    const companyId = req.user.companyId;
    const logs = await IntegrationLog.findAll({
      where: { companyId },
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    res.json({ success: true, data: logs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
