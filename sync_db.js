const { sequelize } = require('./config/db');
require('./models'); // Load all models and associations

async function sync() {
  try {
    console.log('Starting Database Schema Sync (Altering tables)...');
    await sequelize.sync({ alter: true });
    console.log('Database Schema Synced successfully!');
    process.exit(0);
  } catch (err) {
    console.error('Error syncing database:', err);
    process.exit(1);
  }
}

sync();
