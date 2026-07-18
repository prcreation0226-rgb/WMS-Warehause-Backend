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


class ShopifyService {
  /**
   * Helper to get axios client with headers for custom Shopify Admin API token
   */
  static getClient(shopDomain, accessToken) {
    return axios.create({
      baseURL: `https://${shopDomain}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Fetch unfulfilled orders from Shopify and import them into WMS
   */
  static async syncOrders(companyId, isWholesale = false) {
    const platform = isWholesale ? 'SHOPIFY_WHOLESALE' : 'SHOPIFY_FFD';
    let logRecord;
    
    try {
      logRecord = await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'PULL_ORDERS',
        status: 'IN_PROGRESS',
        message: 'Starting order synchronization from Shopify...'
      });

      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let shopDomain, accessToken;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        shopDomain = creds.shopDomain;
        accessToken = creds.accessToken;
      } else {
        shopDomain = isWholesale ? process.env.SHOPIFY_WHOLESALE_DOMAIN : process.env.SHOPIFY_FFD_DOMAIN;
        accessToken = isWholesale ? process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN : process.env.SHOPIFY_FFD_ACCESS_TOKEN;
      }

      if (!shopDomain || !accessToken) {
        throw new Error(`Shopify integration credentials not found for platform ${platform}`);
      }

      const client = this.getClient(shopDomain, accessToken);
      // Fetch open, unfulfilled orders
      const response = await client.get('/orders.json?status=open&fulfillment_status=unfulfilled');
      const shopifyOrders = response.data.orders || [];

      let importedCount = 0;

      for (const order of shopifyOrders) {
        // Check if order already exists in WMS by checking referenceNumber or orderNumber
        const existingOrder = await SalesOrder.findOne({
          where: {
            companyId,
            referenceNumber: `SHOPIFY-${order.id}`
          }
        });

        if (existingOrder) {
          const itemCount = await OrderItem.count({ where: { salesOrderId: existingOrder.id } });
          if (itemCount > 0) {
            continue;
          }
          const transaction = await sequelize.transaction();
          try {
            for (const item of order.line_items) {
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
                  name: item.title || item.name || `Imported Product - ${(item.sku || '').trim()}`,
                  price: item.price || 0,
                  status: 'ACTIVE'
                }, { transaction });
              }

              await OrderItem.create({
                salesOrderId: existingOrder.id,
                productId: wmsProduct.id,
                quantity: item.quantity,
                unitPrice: item.price || 0,
                netPrice: (item.price || 0) * item.quantity,
                grossPrice: (item.price || 0) * item.quantity,
                vatRate: 0,
                vatAmount: 0
              }, { transaction });
            }
            await transaction.commit();
          } catch (e) {
            await transaction.rollback();
            console.error(`Failed to post-populate items for Shopify order ${existingOrder.id}:`, e);
          }
          continue;
        }

        const transaction = await sequelize.transaction();
        try {
          // Map Shopify order to WMS SalesOrder
          const shippingAddress = order.shipping_address || {};
          const orderData = {
            companyId,
            orderNumber: `SHPF-${order.order_number}`,
            orderDate: order.created_at ? order.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            priority: 'MEDIUM',
            salesChannel: 'SHOPIFY',
            referenceNumber: `SHOPIFY-${order.id}`,
            externalRef: order.name,
            totalAmount: order.total_price || 0,
            netAmount: order.subtotal_price || 0,
            vatAmount: order.total_tax || 0,
            recipientName: shippingAddress.name || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() || 'No Name',
            addressLine1: shippingAddress.address1 || '',
            addressLine2: shippingAddress.address2 || '',
            addressLine3: '',
            town: shippingAddress.city || '',
            county: shippingAddress.province || '',
            postcode: shippingAddress.zip || '',
            country: shippingAddress.country || 'UNITED KINGDOM',
            phone: shippingAddress.phone || order.phone || order.customer?.phone || '',
            email: order.email || order.customer?.email || '',
            notes: order.note || '',
            status: 'NEW',
            totalWeight: order.total_weight ? order.total_weight / 1000 : 0, // Convert grams to kg
            totalItems: order.line_items?.length || 0
          };

          const createdOrder = await SalesOrder.create(orderData, { transaction });

          // Map and create order items
          for (const item of order.line_items) {
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
                name: item.title || item.name || `Imported Product - ${(item.sku || '').trim()}`,
                price: item.price || 0,
                status: 'ACTIVE'
              }, { transaction });
            }

            await OrderItem.create({
              salesOrderId: createdOrder.id,
              productId: wmsProduct.id,
              quantity: item.quantity,
              unitPrice: item.price || 0,
              netPrice: (item.price || 0) * item.quantity,
              grossPrice: (item.price || 0) * item.quantity,
              vatRate: 0, // Set defaults or fetch according to company tax rules
              vatAmount: 0
            }, { transaction });
          }

          await transaction.commit();
          importedCount++;
        } catch (itemErr) {
          await transaction.rollback();
          console.error(`Error saving order ${order.id}:`, itemErr);
        }
      }

      if (config) {
        await config.update({ lastSyncTime: new Date() });
      }
      await logRecord.update({
        status: 'SUCCESS',
        message: `Successfully sync'd orders. Imported ${importedCount} new orders.`,
        recordsProcessed: importedCount
      });

      return importedCount;
    } catch (err) {
      console.error(`Shopify order sync failed for ${platform}:`, err);
      if (logRecord) {
        await logRecord.update({
          status: 'FAILED',
          message: `Error syncing Shopify orders: ${err.message}`
        });
      }
      throw err;
    }
  }

  /**
   * Pushes latest stock values from WMS back to Shopify for a specific product
   */
  static async syncProductInventory(companyId, wmsProductId, isWholesale = false) {
    const platform = isWholesale ? 'SHOPIFY_WHOLESALE' : 'SHOPIFY_FFD';
    try {
      const config = await IntegrationConfig.findOne({
        where: { companyId, platform, status: 'ACTIVE' }
      });

      let shopDomain, accessToken;
      if (config) {
        const creds = safeJsonParse(config.credentials);
        shopDomain = creds.shopDomain;
        accessToken = creds.accessToken;
      } else {
        shopDomain = isWholesale ? process.env.SHOPIFY_WHOLESALE_DOMAIN : process.env.SHOPIFY_FFD_DOMAIN;
        accessToken = isWholesale ? process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN : process.env.SHOPIFY_FFD_ACCESS_TOKEN;
      }

      if (!shopDomain || !accessToken) return;
      const client = this.getClient(shopDomain, accessToken);

      const product = await Product.findByPk(wmsProductId);
      if (!product || !product.sku) return;

      // 1. Fetch Shopify Inventory Item ID by WMS SKU
      const searchRes = await client.get(`/products.json?fields=id,title,variants&sku=${encodeURIComponent(product.sku)}`);
      const products = searchRes.data.products || [];
      
      let inventoryItemId = null;
      for (const p of products) {
        const variant = p.variants?.find(v => v.sku === product.sku);
        if (variant) {
          inventoryItemId = variant.inventory_item_id;
          break;
        }
      }

      if (!inventoryItemId) {
        console.warn(`Shopify Inventory item not found for SKU: ${product.sku} on ${platform}`);
        return;
      }

      // 2. Fetch inventory levels to find Location ID
      const levelRes = await client.get(`/inventory_levels.json?inventory_item_ids=${inventoryItemId}`);
      const levels = levelRes.data.inventory_levels || [];
      if (levels.length === 0) return;
      
      const locationId = levels[0].location_id;

      // 3. Query available stock from WMS (ProductStock available qty)
      const { ProductStock } = require('../models');
      const stocks = await ProductStock.findAll({
        where: { productId: product.id }
      });
      const totalAvailable = stocks.reduce((sum, s) => sum + (s.physicalQty - s.allocatedQty), 0);

      // 4. Update quantity in Shopify
      await client.post('/inventory_levels/set.json', {
        inventory_item_id: inventoryItemId,
        location_id: locationId,
        available: totalAvailable >= 0 ? totalAvailable : 0
      });

      await IntegrationLog.create({
        companyId,
        platform,
        actionType: 'PUSH_STOCK',
        status: 'SUCCESS',
        message: `Synced stock for ${product.sku} (Qty: ${totalAvailable})`
      });
    } catch (err) {
      console.error(`Failed to sync inventory to Shopify:`, err);
    }
  }

  /**
   * Mark an order as fulfilled on Shopify when it is dispatched in WMS
   */
  static async pushFulfillment(companyId, salesOrderId) {
    const order = await SalesOrder.findByPk(salesOrderId);
    if (!order || !order.referenceNumber || !order.referenceNumber.startsWith('SHOPIFY-')) return;

    const shopifyOrderId = order.referenceNumber.split('-')[1];
    
    // Gather all active shopify configurations (both DB configs and env fallbacks)
    const stores = [];
    const configs = await IntegrationConfig.findAll({
      where: { companyId, status: 'ACTIVE' }
    });
    
    configs.forEach(c => {
      if (c.platform === 'SHOPIFY_FFD' || c.platform === 'SHOPIFY_WHOLESALE') {
        stores.push(safeJsonParse(c.credentials));
      }
    });

    if (process.env.SHOPIFY_FFD_DOMAIN && process.env.SHOPIFY_FFD_ACCESS_TOKEN) {
      if (!stores.some(s => s.shopDomain === process.env.SHOPIFY_FFD_DOMAIN)) {
        stores.push({ shopDomain: process.env.SHOPIFY_FFD_DOMAIN, accessToken: process.env.SHOPIFY_FFD_ACCESS_TOKEN });
      }
    }
    if (process.env.SHOPIFY_WHOLESALE_DOMAIN && process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN) {
      if (!stores.some(s => s.shopDomain === process.env.SHOPIFY_WHOLESALE_DOMAIN)) {
        stores.push({ shopDomain: process.env.SHOPIFY_WHOLESALE_DOMAIN, accessToken: process.env.SHOPIFY_WHOLESALE_ACCESS_TOKEN });
      }
    }

    for (const store of stores) {
      const { shopDomain, accessToken } = store;
      const client = this.getClient(shopDomain, accessToken);

      try {
        // Fetch order details to verify order ID is present in this store
        const checkOrder = await client.get(`/orders/${shopifyOrderId}.json?fields=id,fulfillment_status`);
        if (checkOrder.data?.order) {
          // Fetch fulfillment location ID and line item IDs first
          const detailedOrderRes = await client.get(`/orders/${shopifyOrderId}.json`);
          const lineItems = detailedOrderRes.data.order.line_items || [];
          
          // Get inventory location
          const fulfillmentOrdersRes = await client.get(`/orders/${shopifyOrderId}/fulfillment_orders.json`);
          const fulfillmentOrder = fulfillmentOrdersRes.data.fulfillment_orders?.[0];
          
          if (!fulfillmentOrder) {
            throw new Error(`No fulfillment orders found for Shopify order ${shopifyOrderId}`);
          }

          // Create fulfillment
          const payload = {
            fulfillment: {
              message: 'Dispatched from WMS',
              notify_customer: true,
              tracking_info: {
                number: order.trackingNumber || '',
                url: '',
                company: order.courierName || 'Royal Mail'
              },
              line_items_by_fulfillment_order: [
                {
                  fulfillment_order_id: fulfillmentOrder.id,
                  fulfillment_order_line_items: lineItems.map(item => ({
                    id: item.id,
                    quantity: item.quantity
                  }))
                }
              ]
            }
          };

          await client.post('/fulfillments.json', payload);
          
          await IntegrationLog.create({
            companyId,
            platform: config.platform,
            actionType: 'FULFILL_ORDER',
            status: 'SUCCESS',
            message: `Pushed fulfillment status for Shopify order ${shopifyOrderId} with tracking ${order.trackingNumber}`
          });
          break; // Done
        }
      } catch (err) {
        // If not found, it might belong to the other store. Keep looping.
        console.warn(`Could not fulfill order ${shopifyOrderId} on store ${shopDomain}: ${err.message}`);
      }
    }
  }
}

module.exports = ShopifyService;
