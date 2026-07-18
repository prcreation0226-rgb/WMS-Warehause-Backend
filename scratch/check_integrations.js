const { IntegrationConfig } = require('../models');

async function main() {
  try {
    const configs = await IntegrationConfig.findAll();
    console.log('--- INTEGRATION CONFIGS ---');
    for (const c of configs) {
      console.log(`ID: ${c.id}`);
      console.log(`Platform: ${c.platform}`);
      console.log(`Status: ${c.status}`);
      console.log(`Credentials type: ${typeof c.credentials}`);
      console.log(`Credentials value: ${c.credentials}`);
      console.log('---------------------------');
    }
  } catch (err) {
    console.error('Error querying configs:', err);
  }
  process.exit(0);
}

main();
