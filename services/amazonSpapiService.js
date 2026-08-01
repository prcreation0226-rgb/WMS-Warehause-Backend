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
    const cleanClientId = (clientId || '').trim();
    const cleanClientSecret = (clientSecret || '').trim();
    const cleanRefreshToken = (refreshToken || '').trim();

    console.log(`[Amazon SP-API] LWA Attempt -> Client ID: ${cleanClientId} | RefreshToken: ${cleanRefreshToken.substring(0, 15)}...${cleanRefreshToken.substring(cleanRefreshToken.length - 10)}`);

    let lastError;

    // Attempt 1: URLSearchParams (standard form-urlencoded with encoded pipe)
    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', cleanRefreshToken);
      params.append('client_id', cleanClientId);
      params.append('client_secret', cleanClientSecret);

      const response = await axios.post('https://api.amazon.com/auth/o2/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
      });
      return response.data.access_token;
    } catch (err1) {
      lastError = err1;
      console.warn('[Amazon SP-API] Attempt 1 (URLSearchParams) failed:', err1.response?.data || err1.message);
    }

    // Attempt 2: JSON payload
    try {
      const response = await axios.post('https://api.amazon.com/auth/o2/token', {
        grant_type: 'refresh_token',
        refresh_token: cleanRefreshToken,
        client_id: cleanClientId,
        client_secret: cleanClientSecret
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.data.access_token;
    } catch (err2) {
      lastError = err2;
      console.warn('[Amazon SP-API] Attempt 2 (JSON) failed:', err2.response?.data || err2.message);
    }

    // Attempt 3: Raw unencoded form body
    try {
      const rawBody = `grant_type=refresh_token&refresh_token=${cleanRefreshToken}&client_id=${cleanClientId}&client_secret=${cleanClientSecret}`;
      const response = await axios.post('https://api.amazon.com/auth/o2/token', rawBody, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
      });
      return response.data.access_token;
    } catch (err3) {
      lastError = err3;
      console.warn('[Amazon SP-API] Attempt 3 (Raw form) failed:', err3.response?.data || err3.message);
    }

    const respData = lastError.response?.data;
    let amazonErr = respData?.error_description || respData?.error || lastError.message;
    if (respData?.error === 'unauthorized_client' || amazonErr.includes('Not authorized')) {
      amazonErr = `Amazon LWA Error (unauthorized_client): The provided Client ID (${cleanClientId.substring(0, 25)}...) and Client Secret do NOT match the Amazon Developer Application that generated the Refresh Token. Please ensure all three credentials (Client ID, Client Secret, and Refresh Token) belong to the EXACT same LWA Application in Amazon Developer Console / Seller Central.`;
    }
    console.error('Failed to retrieve Amazon SP-API access token:', respData || lastError.message);
    throw new Error(`Amazon authentication failed: ${amazonErr}`);
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

      const creds = config ? safeJsonParse(config.credentials) : {};
      const clientId = (creds.clientId && creds.clientId !== '********') ? creds.clientId : process.env.AMAZON_CLIENT_ID;
      const clientSecret = (creds.clientSecret && creds.clientSecret !== '********') ? creds.clientSecret : process.env.AMAZON_CLIENT_SECRET;
      const refreshToken = (creds.refreshToken && creds.refreshToken !== '********') ? creds.refreshToken : process.env.AMAZON_REFRESH_TOKEN;
      const sellerId = creds.sellerId || process.env.AMAZON_SELLER_ID;

      if (!clientId || !clientSecret || !refreshToken) {
        throw new Error('Missing OAuth credentials in Amazon config and process.env');
      }

      let accessToken;
      try {
        accessToken = await this.getAccessToken(clientId, clientSecret, refreshToken);
      } catch (authErr) {
        const envClientId = process.env.AMAZON_CLIENT_ID;
        const envClientSecret = process.env.AMAZON_CLIENT_SECRET;
        const envRefreshToken = process.env.AMAZON_REFRESH_TOKEN;

        if (envClientId && envClientSecret && envRefreshToken && (clientId !== envClientId || refreshToken !== envRefreshToken)) {
          console.warn('[Amazon SP-API] DB credentials failed LWA auth. Retrying directly with process.env credentials...');
          accessToken = await this.getAccessToken(envClientId, envClientSecret, envRefreshToken);
        } else {
          throw authErr;
        }
      }

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
      const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const amazonOrders = [];
      const orderIdsSeen = new Set();
      let authErrors = 0;
      let lastErrorMessage = '';

      for (const mktId of marketplaceIds) {
        try {
          const ordersRes = await client.get(`/orders/v0/orders?MarketplaceIds=${mktId}&CreatedAfter=${createdAfter}`);
          const fetchedOrders = ordersRes.data?.payload?.Orders || [];
          for (const ord of fetchedOrders) {
            if (!orderIdsSeen.has(ord.AmazonOrderId)) {
              orderIdsSeen.add(ord.AmazonOrderId);
              amazonOrders.push(ord);
            }
          }
        } catch (mktErr) {
          const spapiErr = mktErr.response?.data?.errors?.[0]?.message || mktErr.response?.data?.message || mktErr.message;
          lastErrorMessage = spapiErr;
          console.warn(`[Amazon SP-API] Could not fetch orders for Marketplace ${mktId}: ${spapiErr}`);
          if (mktErr.response?.status === 403 || mktErr.response?.status === 401) {
            authErrors++;
          }
        }
      }

      if (amazonOrders.length === 0 && authErrors === marketplaceIds.length) {
        throw new Error(`Amazon SP-API Authorization Failed: ${lastErrorMessage || 'Not authorized for requested operation'}. Please verify in Amazon Seller Central that your Developer App has the 'Direct Merchant Fulfilled Orders' / 'Orders' role enabled for this seller account.`);
      }

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

              const amznImg = item.ProductInfo?.SmallImage?.URL || item.ItemImage || item.ImageUrl || item.image || null;

              if (!wmsProduct) {
                wmsProduct = await Product.create({
                  companyId,
                  sku: sku.trim(),
                  name: item.Title || `Imported Amazon Product - ${sku.trim()}`,
                  price: item.ItemPrice?.Amount || 0,
                  status: 'ACTIVE',
                  images: amznImg ? [amznImg] : null
                }, { transaction });
              } else if (amznImg && (!wmsProduct.images || wmsProduct.images.length === 0) && !wmsProduct.imageUrl) {
                await wmsProduct.update({ images: [amznImg] }, { transaction });
              }

              await OrderItem.create({
                salesOrderId: existingOrder.id,
                productId: wmsProduct.id,
                quantity: item.QuantityOrdered,
                unitPrice: item.ItemPrice?.Amount || 0,
                netPrice: (item.ItemPrice?.Amount || 0),
                grossPrice: (item.ItemPrice?.Amount || 0),
                vatRate: 0,
                vatAmount: item.ItemTax?.Amount || 0,
                productImageUrl: amznImg || (wmsProduct.images ? (Array.isArray(wmsProduct.images) ? wmsProduct.images[0] : wmsProduct.images) : null)
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
      const spapiMsg = err.response?.data?.errors?.[0]?.message || err.message;
      console.error('Amazon sync failed:', err);
      if (logRecord) {
        await logRecord.update({
          status: 'FAILED',
          message: `Error syncing Amazon orders: ${spapiMsg}`
        });
      }
      throw new Error(spapiMsg.includes('Amazon') ? spapiMsg : `Amazon sync failed: ${spapiMsg}`);
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

      const creds = config ? safeJsonParse(config.credentials) : {};
      const clientId = (creds.clientId && creds.clientId !== '********') ? creds.clientId : process.env.AMAZON_CLIENT_ID;
      const clientSecret = (creds.clientSecret && creds.clientSecret !== '********') ? creds.clientSecret : process.env.AMAZON_CLIENT_SECRET;
      const refreshToken = (creds.refreshToken && creds.refreshToken !== '********') ? creds.refreshToken : process.env.AMAZON_REFRESH_TOKEN;
      const sellerId = creds.sellerId || process.env.AMAZON_SELLER_ID;

      let accessToken;
      try {
        accessToken = await this.getAccessToken(clientId, clientSecret, refreshToken);
      } catch (authErr) {
        const envClientId = process.env.AMAZON_CLIENT_ID;
        const envClientSecret = process.env.AMAZON_CLIENT_SECRET;
        const envRefreshToken = process.env.AMAZON_REFRESH_TOKEN;

        if (config && envClientId && envClientSecret && envRefreshToken && (clientId !== envClientId || refreshToken !== envRefreshToken)) {
          console.warn('[Amazon SP-API] DB credentials failed LWA auth in pushFulfillment. Retrying with process.env credentials...');
          accessToken = await this.getAccessToken(envClientId, envClientSecret, envRefreshToken);
        } else {
          throw authErr;
        }
      }

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
