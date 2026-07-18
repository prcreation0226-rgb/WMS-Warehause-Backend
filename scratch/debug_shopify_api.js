require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function testShopify() {
  console.log('Testing Shopify Retail (FFD) API...');
  const shopDomain = process.env.SHOPIFY_FFD_DOMAIN;
  const accessToken = process.env.SHOPIFY_FFD_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    console.error('Missing Shopify FFD env variables in .env');
    return;
  }

  try {
    const client = axios.create({
      baseURL: `https://${shopDomain}/admin/api/2023-04`,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Fetching orders from https://${shopDomain}/admin/api/2023-04/orders.json...`);
    const response = await client.get('/orders.json?status=open&fulfillment_status=unfulfilled');
    const orders = response.data?.orders || [];
    
    console.log(`Found ${orders.length} orders.`);
    if (orders.length > 0) {
      const sample = orders[0];
      const result = {
        totalOrders: orders.length,
        sampleOrderNumber: sample.order_number,
        sampleOrderName: sample.name,
        sampleOrderLineItems: sample.line_items.map(item => ({
          id: item.id,
          title: item.title,
          sku: item.sku,
          price: item.price,
          quantity: item.quantity
        })),
        rawSampleOrder: sample
      };
      
      const outputPath = path.join(__dirname, 'shopify_orders_debug.json');
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`Dumps saved to: ${outputPath}`);
    }
  } catch (err) {
    console.error('Error fetching Shopify FFD orders:', err.response?.data || err.message);
  }
}

testShopify();
