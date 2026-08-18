const axios = require('axios');
require('dotenv').config();
const { IntegrationConfig } = require('./models');

(async () => {
  try {
    const config = await IntegrationConfig.findOne({ where: { platform: 'SHIPSTATION' } });
    let apiKey = process.env.SHIPSTATION_API_KEY || '';
    let apiSecret = process.env.SHIPSTATION_API_SECRET || '';
    if (config && config.credentials) {
      const creds = typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials;
      if (creds.apiKey) apiKey = creds.apiKey;
      if (creds.apiSecret) apiSecret = creds.apiSecret;
    }

    console.log('Testing SS V1 API (ssapi.shipstation.com/orders)...');
    let v1AuthHeader = {};
    if (apiSecret) {
      v1AuthHeader = { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:${apiSecret.trim()}`).toString('base64') };
    } else {
      v1AuthHeader = { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:`).toString('base64') };
    }

    try {
      const resV1 = await axios.get('https://ssapi.shipstation.com/orders?page=1&pageSize=100&sortBy=OrderDate&sortDir=DESC', {
        headers: v1AuthHeader,
        timeout: 8000
      });
      console.log('✅ SS V1 Orders API Success!');
      console.log('  Total V1 Orders reported:', resV1.data.total, '| Total pages:', resV1.data.pages);
      console.log('  Page 1 orders count:', resV1.data.orders ? resV1.data.orders.length : 0);
    } catch (e1) {
      console.log('❌ SS V1 Orders API Failed:', e1.response?.status, e1.response?.data || e1.message);
    }

    console.log('\nTesting SS V2 API (api.shipstation.com/v2/shipments)...');
    try {
      const resV2 = await axios.get('https://api.shipstation.com/v2/shipments?page=1&page_size=100&sort_by=created_at&sort_dir=desc', {
        headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
        timeout: 8000
      });
      console.log('✅ SS V2 Shipments API Success!');
      console.log('  Total V2 Shipments reported:', resV2.data.total, '| Total pages:', resV2.data.pages);
      console.log('  Page 1 shipments count:', resV2.data.shipments ? resV2.data.shipments.length : 0);
    } catch (e2) {
      console.log('❌ SS V2 Shipments API Failed:', e2.response?.status, e2.response?.data || e2.message);
    }

  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
})();
