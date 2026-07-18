require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { sequelize } = require('../config/db');

async function run() {
  try {
    console.log('Altering sales_orders table to add sequence_number column...');
    await sequelize.query("ALTER TABLE sales_orders ADD COLUMN sequence_number INT NULL;");
    console.log('Successfully added sequence_number column!');
  } catch (err) {
    console.error('Failed to add column:', err.message);
  } finally {
    await sequelize.close();
  }
}

run();
