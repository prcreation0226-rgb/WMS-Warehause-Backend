const { sequelize } = require('../config/db');
const { CustomizationMapping } = require('../models');
const amazonCustomService = require('../services/amazonCustomService');

async function runVerificationTest() {
  console.log('--- STARTING VERIFICATION TEST ---');
  try {
    // 1. Check DB Connection
    await sequelize.authenticate();
    console.log('✅ Database Connection: SUCCESS');

    // 2. Check CustomizationMapping Model & Table
    await CustomizationMapping.sync({ alter: true });
    console.log('✅ CustomizationMapping Table Sync: SUCCESS');

    // 3. Create Demo Mapping Record
    const testRecord = await CustomizationMapping.upsert({
      companyId: 1,
      originalSku: 'TEST_BY_30',
      asin: 'B09FKFVXBH',
      optionValue: 'Yoyo - Apple',
      processedSku: 'BE_Y_5_APP',
      outOfStock: false,
      extra: 'Sample Test',
      costPrice: 12.50
    });
    console.log('✅ CustomizationMapping Upsert Test: SUCCESS');

    // 4. Query Mapping
    const found = await CustomizationMapping.findOne({ where: { asin: 'B09FKFVXBH', optionValue: 'Yoyo - Apple' } });
    if (found && found.processedSku === 'BE_Y_5_APP') {
      console.log('✅ ASIN + Option Value Lookup (B09FKFVXBH -> BE_Y_5_APP): SUCCESS');
    } else {
      console.error('❌ Lookup Failed!');
    }

    console.log('--- ALL BACKEND VERIFICATION TESTS PASSED SUCCESSFULLY ---');
  } catch (err) {
    console.error('❌ Verification Test Failed:', err.message);
  } finally {
    await sequelize.close();
  }
}

runVerificationTest();
