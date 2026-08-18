const shipstationService = require('./modules/integrations/shipstation.service');
const { Warehouse } = require('./models');

(async () => {
  try {
    console.log('--- RUNNING WAREHOUSE SYNC WITH V2 JSON SUPPORT ---');
    const res = await shipstationService.syncWarehousesFromShipStation(1);
    console.log('Sync Result:', res);

    const whList = await Warehouse.findAll({ where: { companyId: 1 } });
    console.log('\n--- WAREHOUSES IN DB AFTER SYNC ---');
    for (const w of whList) {
      console.log(`[${w.code}] ${w.name} | Address: ${w.address || 'NONE'} | Phone: ${w.phone || 'NONE'}`);
    }
  } catch (e) {
    console.error('Error:', e);
  }
  process.exit(0);
})();
