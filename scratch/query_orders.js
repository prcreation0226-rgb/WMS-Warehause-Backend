require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { SalesOrder, Customer } = require('../models');

async function check() {
  try {
    const orders = await SalesOrder.findAll({
      order: [['id', 'DESC']],
      limit: 10,
      include: ['Client']
    });

    console.log(`Found ${orders.length} orders:`);
    for (const o of orders) {
      console.log(`ID: ${o.id}, Order#: ${o.orderNumber}`);
      console.log(`  recipientName: ${o.recipientName}`);
      console.log(`  country: ${o.country}, postcode: ${o.postcode}`);
      console.log(`  customerId: ${o.customerId}`);
      if (o.Client) {
        console.log(`  Client name: ${o.Client.name}, contactPerson: ${o.Client.contactPerson}`);
      } else {
        console.log(`  Client: null`);
      }
      console.log('---------------------------');
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
