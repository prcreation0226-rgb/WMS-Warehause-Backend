require('dotenv').config();
const dpdService = require('./services/dpdService');

console.log('DPD Service successfully imported.');
console.log('Available methods:', Object.getOwnPropertyNames(dpdService).filter(p => typeof dpdService[p] === 'function'));

async function test() {
  console.log('Starting simulated submitManifest test...');
  try {
    // This will test DpdService loading, environment configurations, and initial integration log creation
    const manifestId = await dpdService.submitManifest(1);
    console.log('Manifest submission returned ID:', manifestId);
  } catch (error) {
    console.error('Test execution error:', error.message);
  }
}

test();
