require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { sequelize } = require('../config/db');

async function run() {
  try {
    console.log('Creating courier_mappings table in MySQL...');
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS courier_mappings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NOT NULL,
        requested_service VARCHAR(255) NOT NULL,
        courier_name VARCHAR(255) NOT NULL,
        courier_service VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('Successfully created courier_mappings table!');
  } catch (err) {
    console.error('Failed to create table:', err.message);
  } finally {
    await sequelize.close();
  }
}

run();
