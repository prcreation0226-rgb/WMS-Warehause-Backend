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


class AmazonSpapiService {
  /**
   * Helper to retrieve access token using SP-API OAuth credentials
   */
  static async getAccessToken(clientId, clientSecret, refreshToken) {
    try {
      const response = await axios.post('https://api.amazon.com/auth/o2/token', {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret
      });
      return response.data.access_token;
    } catch (err) {
      console.error('Failed to retrieve Amazon SP-API access token:', err.response?.data || err.message);
      throw new Error('Amazon authentication failed');
    }
  }

  /**
   * Sync Amazon European orders into WMS
   */
  static async syncOrders(companyId) {
    const platform = 'AMAZON';
    let logRecord;

    try {
      logRecord = await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'PULL_ORDERS',
        status: 'IN_PROGRESS',
        message: 'Starting order synchronization from Amazon SP-API...'
      });

      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let clientId, clientSecret, refreshToken, sellerId;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        clientId = creds.clientId;
        clientSecret = creds.clientSecret;
        refreshToken = creds.refreshToken;
        sellerId = creds.sellerId;
      } else {
        clientId = process.env.AMAZON_CLIENT_ID;
        clientSecret = process.env.AMAZON_CLIENT_SECRET;
        refreshToken = process.env.AMAZON_REFRESH_TOKEN;
        sellerId = process.env.AMAZON_SELLER_ID;
      }

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Missing OAuth credentials in Amazon config and process.env');
      }

      const accessToken = await this.getAccessToken(clientId, clientSecret, refreshToken);

      // European marketplace IDs (UK, FR, DE, IT, ES, PL, NL, SE, BE)
      const marketplaceIds = [
        'A1F83G8C2ARO7P', // UK
        'A13V1IB3VI34AH', // France
        'A1PA6795UKMFR9', // Germany
        'APJ6JRA9NG5V4',  // Italy
        'A1RKKUPIHCS9HS', // Spain
        'A1C3SOZRCH2K37', // Poland
        'A1805IZSG0MO11', // Netherlands
        'A2NODRK35FZ3CO', // Sweden
        'AMEN7PMS3EDWL'   // Belgium
      ];

      const client = axios.create({
        baseURL: 'https://sellingpartnerapi-eu.amazonservices.com',
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json'
        }
      });

      // 1. Fetch Orders from European market nodes
      const marketplacesQuery = marketplaceIds.map(id => `MarketplaceIds=${id}`).join('&');
      const ordersRes = await client.get(`/orders/v0/orders?${marketplacesQuery}&CreatedAfter=${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}`);
      const amazonOrders = ordersRes.data?.payload?.Orders || [];

      let importedCount = 0;

      for (const order of amazonOrders) {
        // Skip FBA orders because we only fulfill Seller-Fulfilled/MFN orders
        if (order.FulfillmentChannel === 'AFN') continue;

        const existingOrder = await SalesOrder.findOne({
          where: {
            companyId,
            referenceNumber: `AMAZON-${order.AmazonOrderId}`
          }
        });

        if (existingOrder) {
          const itemCount = await OrderItem.count({ where: { salesOrderId: existingOrder.id } });
          if (itemCount > 0) {
            continue;
          }
          // Fetch Line Items for this Order
          const itemsRes = await client.get(`/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
          const orderItemsList = itemsRes.data?.payload?.OrderItems || [];

          const transaction = await sequelize.transaction();
          try {
            for (const item of orderItemsList) {
              const sku = item.SellerSKU || item.ASIN;
              if (!sku || !sku.trim()) continue;

              let wmsProduct = await Product.findOne({
                where: {
                  companyId,
                  sku: sequelize.where(sequelize.fn('LOWER', sequelize.col('sku')), sku.trim().toLowerCase())
                },
                transaction
              });

              if (!wmsProduct) {
                wmsProduct = await Product.create({
                  companyId,
                  sku: sku.trim(),
                  name: item.Title || `Imported Amazon Product - ${sku.trim()}`,
                  price: item.ItemPrice?.Amount || 0,
                  status: 'ACTIVE'
                }, { transaction });
              }

              await OrderItem.create({
                salesOrderId: existingOrder.id,
                productId: wmsProduct.id,
                quantity: item.QuantityOrdered,
                unitPrice: item.ItemPrice?.Amount || 0,
                netPrice: (item.ItemPrice?.Amount || 0),
                grossPrice: (item.ItemPrice?.Amount || 0),
                vatRate: 0,
                vatAmount: item.ItemTax?.Amount || 0
              }, { transaction });
            }
            await transaction.commit();
          } catch (e) {
            await transaction.rollback();
            console.error(`Failed to post-populate items for Amazon order ${existingOrder.id}:`, e);
          }
          continue;
        }

        // Fetch Line Items for this Order
        const itemsRes = await client.get(`/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
        const orderItemsList = itemsRes.data?.payload?.OrderItems || [];

        const transaction = await sequelize.transaction();
        try {
          const address = order.ShippingAddress || {};
          const orderData = {
            companyId,
            orderNumber: `AMZN-${order.AmazonOrderId}`,
            orderDate: order.PurchaseDate ? order.PurchaseDate.split('T')[0] : new Date().toISOString().split('T')[0],
            priority: order.IsPremiumOrder ? 'HIGH' : 'MEDIUM',
            salesChannel: 'AMAZON_MFN',
            referenceNumber: `AMAZON-${order.AmazonOrderId}`,
            externalRef: order.AmazonOrderId,
            totalAmount: order.OrderTotal?.Amount || 0,
            recipientName: address.Name || 'Amazon Customer',
            addressLine1: address.AddressLine1 || '',
            addressLine2: address.AddressLine2 || '',
            addressLine3: address.AddressLine3 || '',
            town: address.City || '',
            county: address.StateOrRegion || '',
            postcode: address.PostalCode || '',
            country: address.CountryCode || 'UNITED KINGDOM',
            phone: address.Phone || '',
            email: order.BuyerInfo?.BuyerEmail || '',
            notes: '',
            status: 'NEW',
            totalItems: orderItemsList.length
          };

          const createdOrder = await SalesOrder.create(orderData, { transaction });

          for (const item of orderItemsList) {
            const sku = item.SellerSKU || item.ASIN;
            if (!sku || !sku.trim()) continue;

            let wmsProduct = await Product.findOne({
              where: {
                companyId,
                sku: sequelize.where(sequelize.fn('LOWER', sequelize.col('sku')), sku.trim().toLowerCase())
              },
              transaction
            });

            if (!wmsProduct) {
              wmsProduct = await Product.create({
                companyId,
                sku: sku.trim(),
                name: item.Title || `Imported Amazon Product - ${sku.trim()}`,
                price: item.ItemPrice?.Amount || 0,
                status: 'ACTIVE'
              }, { transaction });
            }

            await OrderItem.create({
              salesOrderId: createdOrder.id,
              productId: wmsProduct.id,
              quantity: item.QuantityOrdered,
              unitPrice: item.ItemPrice?.Amount || 0,
              netPrice: (item.ItemPrice?.Amount || 0),
              grossPrice: (item.ItemPrice?.Amount || 0),
              vatRate: 0,
              vatAmount: item.ItemTax?.Amount || 0
            }, { transaction });
          }

          await transaction.commit();
          importedCount++;
        } catch (itemErr) {
          await transaction.rollback();
          console.error(`Error saving Amazon order ${order.AmazonOrderId}:`, itemErr);
        }
      }

      if (config) {
        await config.update({ lastSyncTime: new Date() });
      }
      await logRecord.update({
        status: 'SUCCESS',
        message: `Successfully sync'd Amazon EU orders. Imported ${importedCount} merchant-fulfilled orders.`,
        recordsProcessed: importedCount
      });

      return importedCount;
    } catch (err) {
      console.error('Amazon sync failed:', err);
      if (logRecord) {
        await logRecord.update({
          status: 'FAILED',
          message: `Error syncing Amazon orders: ${err.message}`
        });
      }
      throw err;
    }
  }

  /**
   * Mark Amazon Order as Fulfilled
   */
  static async pushFulfillment(companyId, salesOrderId) {
    const order = await SalesOrder.findByPk(salesOrderId);
    if (!order || !order.referenceNumber || !order.referenceNumber.startsWith('AMAZON-')) return;

    const amazonOrderId = order.referenceNumber.split('-')[1];

    try {
      const config = await IntegrationConfig.findOne({
        where: { companyId, platform: 'AMAZON', status: 'ACTIVE' }
      });

      let clientId, clientSecret, refreshToken, sellerId;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        clientId = creds.clientId;
        clientSecret = creds.clientSecret;
        refreshToken = creds.refreshToken;
        sellerId = creds.sellerId;
      } else {
        clientId = process.env.AMAZON_CLIENT_ID;
        clientSecret = process.env.AMAZON_CLIENT_SECRET;
        refreshToken = process.env.AMAZON_REFRESH_TOKEN;
        sellerId = process.env.AMAZON_SELLER_ID;
      }

      if (!clientId || !clientSecret || !refreshToken) return;
      const accessToken = await this.getAccessToken(clientId, clientSecret, refreshToken);

      const client = axios.create({
        baseURL: 'https://sellingpartnerapi-eu.amazonservices.com',
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json'
        }
      });

      // Submit Feeds API to update shipping information
      // Create XML Feed document body for POST_ORDER_FULFILLMENT_DATA
      const feedXml = `<?xml version="1.0" encoding="utf-8"?>
<AmazonEnvelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="amzn-envelope.xsd">
  <Header>
    <DocumentVersion>1.01</DocumentVersion>
    <MerchantIdentifier>${sellerId || ''}</MerchantIdentifier>
  </Header>
  <MessageType>OrderFulfillment</MessageType>
  <Message>
    <MessageID>1</MessageID>
    <OrderFulfillment>
      <AmazonOrderID>${amazonOrderId}</AmazonOrderID>
      <FulfillmentDate>${new Date().toISOString()}</FulfillmentDate>
      <FulfillmentData>
        <CarrierName>${order.courierName || 'Royal Mail'}</CarrierName>
        <ShippingMethod>${order.courierService || 'Standard'}</ShippingMethod>
        <ShipperTrackingNumber>${order.trackingNumber || ''}</ShipperTrackingNumber>
      </FulfillmentData>
    </OrderFulfillment>
  </Message>
</AmazonEnvelope>`;

      // 1. Create a Feed Document to retrieve upload URL
      const createDocRes = await client.post('/feeds/2021-06-30/documents', {
        contentType: 'text/xml; charset=UTF-8'
      });

      const { uploadUrl, feedDocumentId } = createDocRes.data;

      // 2. Upload feed XML document
      await axios.put(uploadUrl, feedXml, {
        headers: { 'Content-Type': 'text/xml; charset=UTF-8' }
      });

      // 3. Create the feed submission
      await client.post('/feeds/2021-06-30/feeds', {
        feedType: 'POST_ORDER_FULFILLMENT_DATA',
        marketplaceIds: ['A1F83G8C2ARO7P'], // UK Marketplace Default
        inputFeedDocumentId: feedDocumentId
      });

      await IntegrationLog.create({
        companyId,
        platform: 'AMAZON',
        actionType: 'FULFILL_ORDER',
        status: 'SUCCESS',
        message: `Submitted fulfillment feed to Amazon for order ${amazonOrderId} (Tracking: ${order.trackingNumber})`
      });
    } catch (err) {
      console.error(`Failed to submit fulfillment feed for Amazon:`, err.response?.data || err.message);
    }
  }
}

module.exports = AmazonSpapiService;
