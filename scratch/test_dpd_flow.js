require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize, SalesOrder, IntegrationLog, IntegrationConfig } = require('../models');
const dpdService = require('../services/dpdService');

async function runTest() {
  console.log('==================================================');
  console.log('         DPD INTEGRATION FLOW TEST SCRIPT         ');
  console.log('==================================================\n');

  let testOrder = null;
  let createdDummy = false;

  try {
    // 1. Test DB Connection
    console.log('Step 1: Connecting to database...');
    await sequelize.authenticate();
    console.log('✔ Connected to database successfully.\n');

    // 2. Fetch or Create test SalesOrder
    console.log('Step 2: Finding a SalesOrder to test label generation...');
    testOrder = await SalesOrder.findOne({ order: [['id', 'DESC']] });
    
    if (!testOrder) {
      console.log('No existing SalesOrder found. Creating a temporary dummy order...');
      testOrder = await SalesOrder.create({
        companyId: 1,
        orderNumber: 'TEST-DPD-' + Date.now(),
        recipientName: 'Rahul Kumar',
        addressLine1: 'Flat 4, 12 High Street',
        addressLine2: 'Westminster',
        town: 'London',
        county: 'Greater London',
        postcode: 'SW1A 1AA',
        country: 'UNITED KINGDOM',
        totalWeight: 0.8,
        noOfParcels: 1,
        courierName: 'DPD',
        courierService: 'DPD Next Day',
        status: 'PACKED'
      });
      createdDummy = true;
      console.log(`✔ Created dummy SalesOrder: ${testOrder.orderNumber} (ID: ${testOrder.id})\n`);
    } else {
      console.log(`✔ Found existing SalesOrder: ${testOrder.orderNumber} (ID: ${testOrder.id})\n`);
    }

    // 3. Verify DPD Environment Configuration
    console.log('Step 3: Checking environment configuration...');
    const env = process.env.DPD_ENV || 'SANDBOX';
    const sandboxKey = process.env.DPD_SANDBOX_KEY;
    const sandboxSecret = process.env.DPD_SANDBOX_SECRET;
    console.log(`DPD Env: ${env}`);
    console.log(`Sandbox Key configured: ${sandboxKey ? 'YES' : 'NO'}`);
    console.log(`Sandbox Secret configured: ${sandboxSecret ? 'YES (Masked)' : 'NO'}`);
    console.log('');

    // 4. Test Authentication & Session Login
    console.log('Step 4: Attempting DPD API session login authentication...');
    try {
      if (!sandboxKey || !sandboxSecret) {
        throw new Error('DPD Sandbox credentials are not configured in Backend/.env');
      }
      const token = await dpdService.getSessionToken(sandboxKey, sandboxSecret, env);
      console.log('✔ DPD API login successful!');
      console.log('Session Token received:', token, '\n');
    } catch (authErr) {
      console.log('❌ DPD API login authentication failed.');
      console.log('Error Message:', authErr.message);
      console.log('Note: Since these keys might be sandbox placeholder values, a 401 Unauthorized is expected if the credentials are not active on DPD servers.\n');
    }

    // 5. Test Shipping Label Generation
    console.log('Step 5: Testing shipping label generation...');
    try {
      const labelRes = await dpdService.generateLabel(1, testOrder.id);
      console.log('✔ DPD Shipping Label generated successfully!');
      console.log('Tracking Number:', labelRes.trackingNumber);
      console.log('Label Document (Base64 length):', labelRes.labelBase64?.length || 0, '\n');
    } catch (labelErr) {
      console.log('❌ DPD Shipping Label generation failed.');
      console.log('Error Message:', labelErr.message);
      console.log('Note: This is expected if authentication failed in Step 4.\n');
    }

    // 6. Test Manifest Daily Submission
    console.log('Step 6: Testing DPD manifest daily submission sync...');
    try {
      const manifestId = await dpdService.submitManifest(1);
      console.log('✔ DPD Manifest sync complete!');
      console.log('Manifest ID:', manifestId, '\n');
    } catch (manifestErr) {
      console.log('❌ DPD Manifest sync failed.');
      console.log('Error Message:', manifestErr.message, '\n');
    }

    // 7. Check database Integration Logs
    console.log('Step 7: Checking backend integration logs for DPD...');
    const logs = await IntegrationLog.findAll({
      where: { platform: 'DPD' },
      limit: 3,
      order: [['id', 'DESC']]
    });

    console.log(`Found ${logs.length} recent integration log(s):`);
    for (const log of logs) {
      console.log(`- [${log.actionType}] Status: ${log.status} | Message: ${log.message}`);
    }
    console.log('');

  } catch (err) {
    console.error('❌ Critical Test Error:', err.message);
  } finally {
    // Clean up dummy order if created
    if (testOrder && createdDummy) {
      console.log('Cleaning up: Deleting dummy SalesOrder...');
      await SalesOrder.destroy({ where: { id: testOrder.id } });
      console.log('✔ Dummy SalesOrder cleaned up.');
    }
    console.log('\n==================================================');
    console.log('               TEST RUN COMPLETE                  ');
    console.log('==================================================');
    process.exit(0);
  }
}

runTest();
