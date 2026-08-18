const orderService = require('./services/orderService');
const { User } = require('./models');

(async () => {
  try {
    const user = await User.findByPk(1, {
      include: [
        { association: 'Company', attributes: ['id', 'name', 'code'] },
        { association: 'Warehouse', attributes: ['id', 'name'] }
      ]
    });
    console.log('User found:', user ? user.email : 'null');
    const result = await orderService.list(user, { page: 1, pageSize: 20 });
    console.log('orderService.list result:', { total: result.total, itemsLength: result.items?.length });
  } catch (err) {
    console.error('EXACT CATCH ERROR:', err);
  }
  process.exit(0);
})();
