const axios = require('axios');
require('dotenv').config();

const { IntegrationConfig } = require('./models');

(async () => {
  try {
    const config = await IntegrationConfig.findOne({ where: { platform: 'SHIPSTATION' } });
    console.log('DB IntegrationConfig:', config ? { status: config.status, creds: config.credentials } : 'NOT FOUND');

    let apiKey = process.env.SHIPSTATION_API_KEY || '';
    let apiSecret = process.env.SHIPSTATION_API_SECRET || '';

    if (config && config.credentials) {
      const creds = typeof config.credentials === 'string' ? JSON.parse(config.credentials) : config.credentials;
      if (creds.apiKey) apiKey = creds.apiKey;
      if (creds.apiSecret) apiSecret = creds.apiSecret;
    }

    console.log('Using API Key:', apiKey.substring(0, 10) + '...', 'Secret:', apiSecret ? 'PRESENT' : 'NONE');

    const testEndpoints = [
      'https://ssapi.shipstation.com/orders?orderStatus=awaiting_shipment&pageSize=100',
      'https://ssapi.shipstation.com/orders?pageSize=100',
      'https://api.shipstation.com/v2/orders?pageSize=100',
      'https://api.shipstation.com/v2/shipments?pageSize=100'
    ];

    for (const ep of testEndpoints) {
      console.log('\n--- TESTING ENDPOINT:', ep);

      const headersList = [];
      if (apiSecret) {
        headersList.push({ name: 'Basic Key:Secret', headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:${apiSecret.trim()}`).toString('base64') } });
      }
      headersList.push({ name: 'Basic Key:blank', headers: { 'Authorization': 'Basic ' + Buffer.from(`${apiKey.trim()}:`).toString('base64') } });
      headersList.push({ name: 'Bearer Token', headers: { 'Authorization': `Bearer ${apiKey.trim()}` } });
      headersList.push({ name: 'api-key Header', headers: { 'api-key': apiKey.trim() } });

      for (const h of headersList) {
        try {
          const res = await axios.get(ep, { headers: h.headers, timeout: 6000 });
          console.log(`✅ SUCCESS [${h.name}] -> Status: ${res.status}`);
          const keys = Object.keys(res.data);
          console.log('  Keys in res.data:', keys);
          const orders = res.data.orders || res.data.shipments || (Array.isArray(res.data) ? res.data : []);
          console.log('  Orders count:', orders.length, 'Total reported:', res.data.total);
          if (orders.length > 0) {
            console.log('  Sample order #1:', {
              orderId: orders[0].orderId || orders[0].order_id || orders[0].id,
              orderNumber: orders[0].orderNumber || orders[0].order_number,
              status: orders[0].orderStatus || orders[0].order_status || orders[0].shipment_status,
              storeId: orders[0].advancedOptions?.storeId || orders[0].storeId
            });
          }
          break; // Found working header for this endpoint
        } catch (err) {
          console.log(`❌ FAIL [${h.name}] -> ${err.response?.status || err.message}: ${JSON.stringify(err.response?.data || '').substring(0, 150)}`);
        }
      }
    }
  } catch (err) {
    console.error('CRITICAL DEBUG ERROR:', err);
  }
  process.exit(0);
})();
