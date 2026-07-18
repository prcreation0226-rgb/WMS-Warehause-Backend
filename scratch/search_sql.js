const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '../../warehouse_wms.sql');
const content = fs.readFileSync(filePath, 'utf8');

const lines = content.split('\n');
console.log('Searching for sales_orders or demo orders...');
lines.forEach((line, index) => {
  if (line.includes('1777629133571') || line.includes('ORD-1777629133571-0002') || (line.includes('INSERT INTO') && line.toLowerCase().includes('sales_orders'))) {
    console.log(`Line ${index + 1}: ${line.slice(0, 300)}`);
  }
});
