const { IntegrationConfig } = require('./models');
(async () => {
  try {
    const configs = await IntegrationConfig.findAll({ where: { platform: 'SHIPSTATION' } });
    console.log('--- SHIPSTATION CONFIGS IN DB ---');
    configs.forEach(c => {
      console.log('ID:', c.id, 'CompanyID:', c.companyId, 'Status:', c.status);
      console.log('Credentials:', c.credentials);
    });
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
