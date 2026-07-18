const axios = require('axios');
const { IntegrationConfig, IntegrationLog, SalesOrder, OrderItem, Product } = require('../models');
const { sequelize } = require('../config/db');

const safeJsonParse = (str) => {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    return {};
  }
};


class EbayService {
  /**
   * Get target API base URL depending on Sandbox vs Production toggle
   */
  static getBaseUrl(isSandbox) {
    return isSandbox ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  }

  /**
   * Refreshes eBay user access token using OAuth refresh token
   */
  static async refreshAccessToken(companyId, isSandbox, configCreds) {
    try {
      const authHeader = Buffer.from(`${configCreds.appId}:${configCreds.certId}`).toString('base64');
      const response = await axios.post(
        `${this.getBaseUrl(isSandbox)}/identity/v1/oauth2/token`,
        `grant_type=refresh_token&refresh_token=${configCreds.refreshToken}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${authHeader}`
          }
        }
      );
      
      const newCreds = {
        ...configCreds,
        accessToken: response.data.access_token,
        tokenExpiry: Date.now() + (response.data.expires_in * 1000)
      };

      return newCreds;
    } catch (err) {
      console.error('eBay access token refresh failed:', err.response?.data || err.message);
      throw err;
    }
  }

  /**
   * Pull active unfulfilled orders from eBay
   */
  static async syncOrders(companyId) {
    const platform = 'EBAY';
    let logRecord;

    try {
      logRecord = await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'PULL_ORDERS',
        status: 'IN_PROGRESS',
        message: 'Starting order synchronization from eBay...'
      });

      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let creds;
      if (config) {
        creds = safeJsonParse(config.credentials);
      } else {
        const envMode = process.env.EBAY_ENV || 'PRODUCTION';
        const isSandbox = envMode === 'SANDBOX';
        creds = {
          env: envMode,
          appId: isSandbox ? process.env.EBAY_SANDBOX_APP_ID : process.env.EBAY_PROD_APP_ID,
          devId: isSandbox ? process.env.EBAY_SANDBOX_DEV_ID : process.env.EBAY_PROD_DEV_ID,
          certId: isSandbox ? process.env.EBAY_SANDBOX_CERT_ID : process.env.EBAY_PROD_CERT_ID,
          refreshToken: isSandbox ? process.env.EBAY_SANDBOX_REFRESH_TOKEN : process.env.EBAY_PROD_REFRESH_TOKEN,
          accessToken: isSandbox ? process.env.EBAY_SANDBOX_ACCESS_TOKEN : process.env.EBAY_PROD_ACCESS_TOKEN,
          tokenExpiry: 0
        };
      }

      if (!creds.appId || !creds.certId || !creds.refreshToken) {
        throw new Error('eBay credentials or OAuth refresh token not found in config or process.env');
      }

      const isSandbox = creds.env === 'SANDBOX';

      // Refresh token if expired or about to expire
      if (creds.refreshToken && (!creds.tokenExpiry || Date.now() > creds.tokenExpiry - 300000)) {
        creds = await this.refreshAccessToken(companyId, isSandbox, creds);
        if (config) {
          await config.update({ credentials: JSON.stringify(creds) });
        }
      }

      const client = axios.create({
        baseURL: this.getBaseUrl(isSandbox),
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      // Query unpaid/unfulfilled orders
      const response = await client.get('/sell/fulfillment/v1/order?filter=orderfulfillmentstatus:%7BNOT_STARTED%7CIN_PROGRESS%7D');
      const orders = response.data.orders || [];

      let importedCount = 0;

      for (const order of orders) {
        const existingOrder = await SalesOrder.findOne({
          where: {
            companyId,
            referenceNumber: `EBAY-${order.orderId}`
          }
        });

        if (existingOrder) {
          const itemCount = await OrderItem.count({ where: { salesOrderId: existingOrder.id } });
          if (itemCount > 0) {
            continue;
          }
          const transaction = await sequelize.transaction();
          try {
            for (const item of order.lineItems) {
              if (!item.sku || !item.sku.trim()) continue;

              let wmsProduct = await Product.findOne({
                where: {
                  companyId,
                  sku: sequelize.where(sequelize.fn('LOWER', sequelize.col('sku')), (item.sku || '').trim().toLowerCase())
                },
                transaction
              });

              if (!wmsProduct) {
                wmsProduct = await Product.create({
                  companyId,
                  sku: (item.sku || '').trim(),
                  name: item.title || `Imported eBay Product - ${(item.sku || '').trim()}`,
                  price: item.lineItemCost?.value || 0,
                  status: 'ACTIVE'
                }, { transaction });
              }

              await OrderItem.create({
                salesOrderId: existingOrder.id,
                productId: wmsProduct.id,
                quantity: item.quantity,
                unitPrice: item.lineItemCost?.value || 0,
                netPrice: (item.lineItemCost?.value || 0) * item.quantity,
                grossPrice: (item.lineItemCost?.value || 0) * item.quantity,
                vatRate: 0,
                vatAmount: 0
              }, { transaction });
            }
            await transaction.commit();
          } catch (e) {
            await transaction.rollback();
            console.error(`Failed to post-populate items for eBay order ${existingOrder.id}:`, e);
          }
          continue;
        }

        const transaction = await sequelize.transaction();
        try {
          const shippingAddress = order.deliveryAddress || {};
          const orderData = {
            companyId,
            orderNumber: `EBAY-${order.legacyOrderId || order.orderId}`,
            orderDate: order.creationDate ? order.creationDate.split('T')[0] : new Date().toISOString().split('T')[0],
            priority: 'MEDIUM',
            salesChannel: 'EBAY',
            referenceNumber: `EBAY-${order.orderId}`,
            externalRef: order.legacyOrderId || order.orderId,
            totalAmount: order.pricingSummary?.total?.value || 0,
            recipientName: order.buyer?.username || 'eBay Customer',
            addressLine1: shippingAddress.addressLine1 || '',
            addressLine2: shippingAddress.addressLine2 || '',
            town: shippingAddress.city || '',
            county: shippingAddress.stateOrProvince || '',
            postcode: shippingAddress.postalCode || '',
            country: shippingAddress.countryCode || 'UNITED KINGDOM',
            phone: shippingAddress.primaryPhone?.phoneNumber || '',
            email: order.buyer?.email || '',
            notes: order.buyerCheckoutNotes || '',
            status: 'NEW',
            totalItems: order.lineItems?.length || 0
          };

          const createdOrder = await SalesOrder.create(orderData, { transaction });

          for (const item of order.lineItems) {
            if (!item.sku || !item.sku.trim()) continue;

            let wmsProduct = await Product.findOne({
              where: {
                companyId,
                sku: sequelize.where(sequelize.fn('LOWER', sequelize.col('sku')), (item.sku || '').trim().toLowerCase())
              },
              transaction
            });

            if (!wmsProduct) {
              wmsProduct = await Product.create({
                companyId,
                sku: (item.sku || '').trim(),
                name: item.title || `Imported eBay Product - ${(item.sku || '').trim()}`,
                price: item.lineItemCost?.value || 0,
                status: 'ACTIVE'
              }, { transaction });
            }

            await OrderItem.create({
              salesOrderId: createdOrder.id,
              productId: wmsProduct.id,
              quantity: item.quantity,
              unitPrice: item.lineItemCost?.value || 0,
              netPrice: (item.lineItemCost?.value || 0) * item.quantity,
              grossPrice: (item.lineItemCost?.value || 0) * item.quantity,
              vatRate: 0,
              vatAmount: 0
            }, { transaction });
          }

          await transaction.commit();
          importedCount++;
        } catch (itemErr) {
          await transaction.rollback();
          console.error(`Error saving eBay order ${order.orderId}:`, itemErr);
        }
      }

      if (config) {
        await config.update({ lastSyncTime: new Date() });
      }
      await logRecord.update({
        status: 'SUCCESS',
        message: `Successfully sync'd eBay orders. Imported ${importedCount} orders.`,
        recordsProcessed: importedCount
      });

      return importedCount;
    } catch (err) {
      console.error('eBay sync failed:', err);
      if (logRecord) {
        await logRecord.update({
          status: 'FAILED',
          message: `Error syncing eBay orders: ${err.message}`
        });
      }
      throw err;
    }
  }

  /**
   * Post fulfillment updates back to eBay
   */
  static async pushFulfillment(companyId, salesOrderId) {
    const order = await SalesOrder.findByPk(salesOrderId);
    if (!order || !order.referenceNumber || !order.referenceNumber.startsWith('EBAY-')) return;

    const ebayOrderId = order.referenceNumber.split('-')[1];

    try {
      const config = await IntegrationConfig.findOne({
        where: { companyId, platform: 'EBAY', status: 'ACTIVE' }
      });

      let creds;
      if (config) {
        creds = safeJsonParse(config.credentials);
      } else {
        const envMode = process.env.EBAY_ENV || 'PRODUCTION';
        const isSandbox = envMode === 'SANDBOX';
        creds = {
          env: envMode,
          appId: isSandbox ? process.env.EBAY_SANDBOX_APP_ID : process.env.EBAY_PROD_APP_ID,
          devId: isSandbox ? process.env.EBAY_SANDBOX_DEV_ID : process.env.EBAY_PROD_DEV_ID,
          certId: isSandbox ? process.env.EBAY_SANDBOX_CERT_ID : process.env.EBAY_PROD_CERT_ID,
          refreshToken: isSandbox ? process.env.EBAY_SANDBOX_REFRESH_TOKEN : process.env.EBAY_PROD_REFRESH_TOKEN,
          accessToken: isSandbox ? process.env.EBAY_SANDBOX_ACCESS_TOKEN : process.env.EBAY_PROD_ACCESS_TOKEN,
          tokenExpiry: 0
        };
      }

      if (!creds.appId || !creds.certId || !creds.refreshToken) return;
      const isSandbox = creds.env === 'SANDBOX';

      if (creds.refreshToken && (!creds.tokenExpiry || Date.now() > creds.tokenExpiry - 300000)) {
        creds = await this.refreshAccessToken(companyId, isSandbox, creds);
        if (config) {
          await config.update({ credentials: JSON.stringify(creds) });
        }
      }

      const client = axios.create({
        baseURL: this.getBaseUrl(isSandbox),
        headers: {
          'Authorization': `Bearer ${creds.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      // Mark order fulfilled on eBay
      const payload = {
        shippedDate: new Date().toISOString(),
        shippingCarrierCode: order.courierName || 'Royal Mail',
        trackingNumber: order.trackingNumber || ''
      };

      await client.post(`/sell/fulfillment/v1/order/${ebayOrderId}/shipping_fulfillment`, payload);

      await IntegrationLog.create({
        companyId,
        platform: 'EBAY',
        actionType: 'FULFILL_ORDER',
        status: 'SUCCESS',
        message: `Pushed fulfillment status to eBay for order ${ebayOrderId} (Tracking: ${order.trackingNumber})`
      });
    } catch (err) {
      console.error(`Failed to push fulfillment to eBay:`, err.response?.data || err.message);
    }
  }
}

module.exports = EbayService;
