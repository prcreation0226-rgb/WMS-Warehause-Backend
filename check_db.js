require('dotenv').config();
const { sequelize, InventoryLog, Inventory } = require('./models');

async function check() {
  try {
    await sequelize.authenticate();
    console.log('Connected successfully to database.');

    // Print count of all logs
    const totalLogs = await InventoryLog.count();
    console.log('Total inventory logs:', totalLogs);

    // Print logs with null levels
    const nullLogs = await InventoryLog.count({
      where: {
        newStockLevel: null
      }
    });
    console.log('Logs with NULL stock level:', nullLogs);

    // Print first 5 logs
    const logs = await InventoryLog.findAll({
      limit: 5,
      order: [['id', 'DESC']]
    });

    console.log('Last 5 log entries:');
    for (const log of logs) {
      console.log(`ID: ${log.id}, SKU: ${log.productId}, Type: ${log.type}, Qty: ${log.quantity}, Stock: ${log.newStockLevel}, Allocated: ${log.newAllocatedLevel}, OnHand: ${log.newOnHandLevel}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('Error during database check:', err);
    process.exit(1);
  }
}

check();
