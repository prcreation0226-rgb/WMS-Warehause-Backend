require('dotenv').config({ path: 'c:/Users/kiaan/Desktop/Kiaan/WMS New Software/WMS-backend/.env' });
const { sequelize } = require('../config/db');

async function run() {
  try {
    console.log('Fetching all companies...');
    const [companies] = await sequelize.query("SELECT DISTINCT company_id FROM sales_orders;");
    
    for (const comp of companies) {
      const companyId = comp.company_id;
      console.log(`Processing company ID ${companyId}...`);
      const [orders] = await sequelize.query(
        `SELECT id FROM sales_orders WHERE company_id = :companyId ORDER BY created_at ASC;`,
        { replacements: { companyId } }
      );
      
      console.log(`Found ${orders.length} orders for company ${companyId}. Populating sequence numbers...`);
      for (let i = 0; i < orders.length; i++) {
        const orderId = orders[i].id;
        const seq = i + 1;
        await sequelize.query(
          `UPDATE sales_orders SET sequence_number = :seq WHERE id = :orderId;`,
          { replacements: { seq, orderId } }
        );
      }
    }
    console.log('Sequence numbers populated successfully!');
  } catch (err) {
    console.error('Failed to populate sequence numbers:', err.message);
  } finally {
    await sequelize.close();
  }
}

run();
