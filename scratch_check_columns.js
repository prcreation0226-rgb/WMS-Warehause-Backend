const fs = require('fs');
const service = require('./services/inventoryService');
console.log('Function code:');
console.log(service.exportProductsCsv.toString().slice(0, 2000));
