const axios = require('axios');

async function testHttp() {
  try {
    const res = await axios.get('https://wms-warehause-backend-production.up.railway.app/');
    console.log('GET / response:', res.status, res.data);
  } catch (err) {
    console.log('GET / failed:', err.message);
    if (err.response) {
      console.log('Response data:', err.response.status, err.response.data);
    }
  }

  try {
    const res = await axios.post('https://wms-warehause-backend-production.up.railway.app/auth/login', {
      email: 'admin@kiaan-wms.com',
      password: 'Admin@123'
    });
    console.log('POST /auth/login response:', res.status, res.data);
  } catch (err) {
    console.log('POST /auth/login failed:', err.message);
    if (err.response) {
      console.log('Response data:', err.response.status, err.response.data);
    }
  }
}

testHttp();
