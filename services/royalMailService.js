const axios = require('axios');
const { IntegrationConfig, IntegrationLog, SalesOrder } = require('../models');

const safeJsonParse = (str) => {
  if (!str) return {};
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch (e) {
    return {};
  }
};


class RoyalMailService {
  /**
   * Helper to get axios client configured for Royal Mail Net Shipping API V3
   */
  static getClient(authKey) {
    return axios.create({
      baseURL: 'https://api.parcel.royalmail.com/api/v1',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }

  /**
   * Generates a Royal Mail shipping label for a SalesOrder
   * Maps SalesOrder data into the Royal Mail V3 Shipment request body
   */
  static async generateLabel(companyId, salesOrderId) {
    const platform = 'ROYAL_MAIL';
    let logRecord;

    try {
      const order = await SalesOrder.findByPk(salesOrderId);
      if (!order) throw new Error('Order not found');

      logRecord = await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'GENERATE_LABEL',
        status: 'IN_PROGRESS',
        message: `Requesting Royal Mail label for WMS Order: ${order.orderNumber}`
      });

      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let authKey, accountNumber;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        authKey = creds.authKey;
        accountNumber = creds.accountNumber;
      } else {
        authKey = process.env.ROYAL_MAIL_AUTH_KEY;
        accountNumber = process.env.ROYAL_MAIL_ACCOUNT_NUMBER;
      }

      if (!authKey || !accountNumber) {
        throw new Error('Royal Mail credentials not found in config or process.env');
      }

      const client = this.getClient(authKey);

      // Construct Royal Mail Shipping V3 Shipment Payload
      // Map WMS details (weight, recipient address, service code)
      const payload = {
        shipmentType: 'DELIVERY',
        shipper: {
          accountNumber: accountNumber
        },
        recipient: {
          name: order.recipientName || 'Recipient',
          address: {
            addressLine1: order.addressLine1 || '',
            addressLine2: order.addressLine2 || '',
            town: order.town || '',
            postcode: order.postcode || '',
            countryCode: order.country === 'UNITED KINGDOM' ? 'GB' : order.country || 'GB'
          },
          contact: {
            telephone: order.phone || '',
            email: order.email || ''
          }
        },
        packageDetails: {
          weight: order.totalWeight || 0.5, // Default weight in kg if not specified
          weightUnit: 'KG',
          numberOfPackages: order.noOfParcels || 1
        },
        serviceDetails: {
          // Map internal services like 'Tracked 48' to Royal Mail codes
          serviceCode: (order.courierService && order.courierService.includes('24')) ? 'TPN' : 'TPS', // TPN: Tracked 24, TPS: Tracked 48
          serviceOptions: {
            shippingFormat: 'PARCEL'
          }
        }
      };

      // Call API
      const response = await client.post('/shipments', payload);
      const shipmentData = response.data?.shipments?.[0];

      if (!shipmentData) {
        throw new Error('No shipment details returned by Royal Mail API');
      }

      const trackingNumber = shipmentData.trackingNumber;
      // Capture base64 encoded label document from response
      const labelBase64 = shipmentData.documents?.[0]?.data; 

      if (!trackingNumber) {
        throw new Error('Royal Mail returned successfully but without a tracking number');
      }

      // Update Order tracking fields
      await order.update({
        trackingNumber: trackingNumber,
        trackingStatus: 'MANIFESTED',
        courierName: 'Royal Mail',
        courierService: order.courierService || 'Royal Mail Tracked 48'
      });

      await logRecord.update({
        status: 'SUCCESS',
        message: `Generated label successfully. Tracking: ${trackingNumber}`,
        recordsProcessed: 1
      });

      return {
        trackingNumber,
        labelBase64
      };
    } catch (err) {
      console.error('Failed to generate Royal Mail label:', err.response?.data || err.message);
      if (logRecord) {
        await logRecord.update({
          status: 'FAILED',
          message: `Error generating Royal Mail label: ${err.message}`
        });
      }
      throw err;
    }
  }

  /**
   * Finalize Manifests for all daily shipments
   */
  static async submitManifest(companyId) {
    const platform = 'ROYAL_MAIL';
    try {
      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let authKey, accountNumber;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        authKey = creds.authKey;
        accountNumber = creds.accountNumber;
      } else {
        authKey = process.env.ROYAL_MAIL_AUTH_KEY;
        accountNumber = process.env.ROYAL_MAIL_ACCOUNT_NUMBER;
      }

      if (!authKey || !accountNumber) return;
      const client = this.getClient(authKey);

      const payload = {
        shipper: {
          accountNumber
        }
      };

      const response = await client.post('/manifests', payload);
      const manifestId = response.data?.manifestId;

      await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'MANIFEST_DAILY',
        status: 'SUCCESS',
        message: `Royal Mail manifest submitted successfully. Manifest ID: ${manifestId || 'N/A'}`
      });

      return manifestId;
    } catch (err) {
      console.error('Royal Mail manifestation failed:', err.response?.data || err.message);
    }
  }
}

module.exports = RoyalMailService;
