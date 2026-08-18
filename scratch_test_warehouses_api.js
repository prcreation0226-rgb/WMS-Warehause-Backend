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

    console.log('--- TESTING SHIPSTATION WAREHOUSES API ---');
    console.log('API Key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'NONE');

    let v1AuthHeader = {};
    if (apiSecret) {
      v1AuthHeader = { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:${apiSecret.trim()}`).toString('base64') };
    } else {
      v1AuthHeader = { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:`).toString('base64') };
    }

    // 1. Test SS V1 Warehouses Endpoint
    try {
      console.log('\nTesting GET https://ssapi.shipstation.com/warehouses ...');
      const resV1 = await axios.get('https://ssapi.shipstation.com/warehouses', { headers: v1AuthHeader, timeout: 6000 });
      console.log('✅ SS V1 Warehouses API Response Status:', resV1.status);
      console.log('   Data type:', Array.isArray(resV1.data) ? `Array (${resV1.data.length} items)` : typeof resV1.data);
      console.log('   WarehousesPayload:', JSON.stringify(resV1.data, null, 2).substring(0, 800));
    } catch (e1) {
      console.log('❌ SS V1 Warehouses API Error:', e1.response?.status, e1.response?.data || e1.message);
    }

    // 2. Test SS V2 Warehouses Endpoint
    try {
      console.log('\nTesting GET https://api.shipstation.com/v2/warehouses ...');
      const resV2 = await axios.get('https://api.shipstation.com/v2/warehouses', {
        headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
        timeout: 6000
      });
      console.log('✅ SS V2 Warehouses API Response Status:', resV2.status);
      console.log('   Data:', JSON.stringify(resV2.data, null, 2).substring(0, 800));
    } catch (e2) {
      console.log('❌ SS V2 Warehouses API Error:', e2.response?.status, e2.response?.data || e2.message);
    }

  } catch (err) {
    console.error('CRITICAL ERROR:', err);
  }
  process.exit(0);
})();
