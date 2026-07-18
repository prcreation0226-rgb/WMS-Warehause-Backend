require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { sequelize } = require('../config/db');
const fs = require('fs');
const path = require('path');

async function run() {
  const report = {};
  try {
    const [salesOrdersCols] = await sequelize.query("DESCRIBE sales_orders;");
    report.sales_orders = salesOrdersCols;

    const [tables] = await sequelize.query("SHOW TABLES;");
    report.tables = tables;

    try {
      const [savedAddressesCols] = await sequelize.query("DESCRIBE saved_addresses;");
      report.saved_addresses = savedAddressesCols;
    } catch (e) {
      report.saved_addresses_error = e.message;
    }

  } catch (err) {
    report.error = err.message;
  } finally {
    await sequelize.close();
    fs.writeFileSync(path.join(__dirname, 'db_check_result.json'), JSON.stringify(report, null, 2));
    console.log('Done');
  }
}

run();
