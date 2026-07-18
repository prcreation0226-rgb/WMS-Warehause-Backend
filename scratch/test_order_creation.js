const axios = require('axios');

async function test() {
  try {
    console.log('Logging in...');
    const loginRes = await axios.post('http://127.0.0.1:3001/auth/login', {
      email: 'companyadmin@kiaan-wms.com',
      password: '123456'
    });
    const token = loginRes.data.token;
    console.log('Logged in successfully. Token obtained.');

    const payload = {
      customerId: null,
      saveAddress: false,
      orderDate: '2026-06-06',
      requiredDate: '2026-06-08',
      priority: 'HIGH',
      salesChannel: 'DIRECT',
      recipientName: 'Kiaan Test Name',
      addressLine1: '123 Test Street',
      town: 'London',
      postcode: 'NW1 1AA',
      country: 'UNITED KINGDOM',
      items: [
        {
          productId: 1,
          quantity: 1,
          unitPrice: 10.0,
          warehouseId: 1
        }
      ]
    };

    console.log('Sending create order request...');
    const createRes = await axios.post('http://127.0.0.1:3001/api/orders/sales', payload, {
      headers: { Authorization: `Bearer ${token}` }
    });

    console.log('Order created response:', createRes.data);
  } catch (err) {
    console.error('Error Details:', err.stack || err);
    if (err.response) {
      console.error('Response Status:', err.response.status);
      console.error('Response Data:', err.response.data);
    }
  }
}

test();
