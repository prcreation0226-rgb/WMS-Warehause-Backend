const { SalesOrder, Company, User } = require('./models');

(async () => {
  try {
    console.log('--- DB INSPECTION ---');
    const companies = await Company.findAll({ raw: true });
    console.log('Companies:', companies);

    const users = await User.findAll({ attributes: ['id', 'email', 'role', 'companyId'], raw: true });
    console.log('Users:', users);

    const count = await SalesOrder.count();
    console.log('Total Sales Orders:', count);

    const sample = await SalesOrder.findAll({
      limit: 10,
      order: [['id', 'DESC']],
      attributes: ['id', 'companyId', 'orderNumber', 'shipstationOrderId', 'status', 'salesChannel', 'recipientName', 'totalAmount', 'createdAt']
    });
    console.log('Latest 10 Orders:', JSON.stringify(sample, null, 2));

  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
})();
