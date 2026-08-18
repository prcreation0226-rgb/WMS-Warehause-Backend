const axios = require('axios');
require('dotenv').config();

const apiKey = process.env.SHIPSTATION_API_KEY || '';
const apiSecret = process.env.SHIPSTATION_API_SECRET || '';

console.log('Testing ShipStation API with key:', apiKey.substring(0, 10) + '...');

async function test() {
  const targets = [
    { url: 'https://ssapi.shipstation.com/orders?orderStatus=awaiting_shipment', type: 'V1 Basic Key:Secret', headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64') } },
    { url: 'https://ssapi.shipstation.com/orders?orderStatus=awaiting_shipment', type: 'V1 Basic Key:Blank', headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64') } },
    { url: 'https://ssapi.shipstation.com/orders', type: 'V1 Basic Key:Key', headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':' + apiKey).toString('base64') } },
    { url: 'https://api.shipstation.com/v2/orders', type: 'V2 Bearer', headers: { Authorization: `Bearer ${apiKey}` } },
    { url: 'https://api.shipstation.com/v2/shipments', type: 'V2 api-key', headers: { 'api-key': apiKey } },
    { url: 'https://api.shipengine.com/v1/shipments', type: 'ShipEngine api-key', headers: { 'api-key': apiKey } },
  ];

  for (const t of targets) {
    try {
      const res = await axios.get(t.url, { headers: t.headers, timeout: 8000 });
      console.log(`SUCCESS [${t.type}] ${t.url}: Status ${res.status}`);
      console.log('Keys in data:', Object.keys(res.data));
      if (res.data.orders) console.log('Orders count:', res.data.orders.length);
      if (res.data.shipments) console.log('Shipments count:', res.data.shipments.length);
      if (Array.isArray(res.data)) console.log('Array items count:', res.data.length);
      console.log('Sample Data snippet:', JSON.stringify(res.data).substring(0, 300));
    } catch (err) {
      console.log(`FAILED [${t.type}] ${t.url}: ${err.response?.status} - ${JSON.stringify(err.response?.data || err.message)}`);
    }
  }
}

test();
