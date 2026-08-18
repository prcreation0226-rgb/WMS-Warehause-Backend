const { SalesOrder, Company } = require('./models');

(async () => {
  try {
    const totalOrders = await SalesOrder.count();
    console.log('TOTAL SALES ORDERS IN DB:', totalOrders);

    const companies = await Company.findAll();
    console.log('COMPANIES IN DB:', companies.map(c => ({ id: c.id, name: c.name })));

    const ordersByCompany = await SalesOrder.findAll({
      attributes: ['companyId', [SalesOrder.sequelize.fn('COUNT', SalesOrder.sequelize.col('id')), 'count']],
      group: ['companyId'],
      raw: true
    });
    console.log('ORDERS BY COMPANY:', ordersByCompany);

    const sampleOrders = await SalesOrder.findAll({
      limit: 5,
      order: [['id', 'DESC']],
      attributes: ['id', 'companyId', 'orderNumber', 'status', 'salesChannel', 'orderDate', 'createdAt']
    });
    console.log('LATEST 5 ORDERS:', JSON.stringify(sampleOrders, null, 2));
  } catch (err) {
    console.error('ERROR CHECKING ORDERS:', err);
  }
  process.exit(0);
})();
