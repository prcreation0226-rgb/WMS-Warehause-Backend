const { SalesOrder, Customer, User, Company } = require('./models');

(async () => {
  try {
    const userCount = await User.count();
    console.log('User count:', userCount);
    const orderCount = await SalesOrder.count();
    console.log('Order count:', orderCount);
    const customerCount = await Customer.count();
    console.log('Customer count:', customerCount);
  } catch (err) {
    console.error('DB ERROR:', err);
  }
  process.exit(0);
})();
