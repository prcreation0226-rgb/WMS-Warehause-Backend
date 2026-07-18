const db = require('../models');
const inventoryService = require('../services/inventoryService');

async function run() {
  try {
    console.log('--- Testing Product Export CSV ---');
    // Mock user
    const mockUser = { id: 1, role: 'company_admin', companyId: 1 };
    
    // Test export
    const csv = await inventoryService.exportProductsCsv(mockUser);
    const firstLine = csv.split('\n')[0];
    console.log('Export Headers:', firstLine);
    console.log('Columns count:', firstLine.split(',').length);
    
    console.log('--- Testing Product Bulk Import Parser ---');
    // Let's test parser behavior
    const mockProducts = [
      {
        sku: 'TEST-SKU-99',
        name: 'Test Product 99',
        price: '19.99',
        costPrice: '10.00',
        packSize: '2',
        discontinued: 'yes',
        defaultPickingLocation: 'LOC-A-01'
      }
    ];
    
    const importResult = await inventoryService.bulkCreateProducts(mockProducts, mockUser);
    console.log('Import Result:', JSON.stringify(importResult, null, 2));
    
    console.log('PASSED: All service methods loaded and executed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('FAILED with error:', err);
    process.exit(1);
  }
}

run();
