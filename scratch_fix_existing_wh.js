const { Warehouse } = require('./models');
const shipstationService = require('./modules/integrations/shipstation.service');

(async () => {
  try {
    console.log('--- RE-SYNCING ALL SHIPSTATION WAREHOUSES & FIXING NULL ADDRESSES ---');
    // Force update existing warehouses with new address fields
    const whList = await Warehouse.findAll();
    for (const w of whList) {
      if (w.code === 'WH-SE-18434' || w.name === 'Warehouse') {
        await w.update({
          address: '36 Gorsey Place, Skelmersdale, WN8 9UP',
          city: 'Skelmersdale',
          state: 'Lancashire',
          postcode: 'WN8 9UP',
          country: 'GB',
          phone: '01695768001',
          capacity: w.capacity || 10000
        });
        console.log('Updated WH-SE-18434:', w.toJSON());
      } else if (!w.capacity) {
        await w.update({ capacity: 10000 });
      }
    }

    // Now re-trigger shipstationService.syncWarehousesFromShipStation
    const res = await shipstationService.syncWarehousesFromShipStation(1);
    console.log('Sync Result:', res);

    const updatedList = await Warehouse.findAll();
    console.log('\n--- CURRENT WAREHOUSES IN DB ---');
    for (const u of updatedList) {
      console.log(`[${u.code}] ${u.name} | Address: ${u.address} | Phone: ${u.phone} | Capacity: ${u.capacity}`);
    }
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
})();
