const { sequelize } = require('./config/db');
const { CustomizationMapping } = require('./models');

async function seedData() {
  try {
    await sequelize.authenticate();
    console.log('Database connected.');

    const sampleMappings = [
      {
        companyId: 1,
        originalSku: 'BY_30',
        asin: 'B09FKFVXBH',
        optionValue: 'Yoyo - Apple',
        processedSku: 'BE_Y_5_APP',
        outOfStock: false,
        extra: 'Amazon Custom Flavour Mapping',
        costPrice: 2.50
      },
      {
        companyId: 1,
        originalSku: 'BY_30',
        asin: 'B09FKFVXBH',
        optionValue: 'Yoyo - Strawberry',
        processedSku: 'BE_Y_5_STR',
        outOfStock: false,
        extra: 'Amazon Custom Flavour Mapping',
        costPrice: 2.50
      },
      {
        companyId: 1,
        originalSku: 'BY_30',
        asin: 'B09FKFVXBH',
        optionValue: 'Yoyo - Blackcurrant',
        processedSku: 'BE_Y_5_BLK',
        outOfStock: false,
        extra: 'Amazon Custom Flavour Mapping',
        costPrice: 2.50
      },
      {
        companyId: 1,
        originalSku: 'BY_30',
        asin: 'B09FKFVXBH',
        optionValue: 'Yoyo - Raspberry',
        processedSku: 'BE_Y_5_RAS',
        outOfStock: true,
        extra: 'Temporarily Out of Stock',
        costPrice: 2.50
      },
      {
        companyId: 1,
        originalSku: 'BY_50',
        asin: 'B08N5WRWNW',
        optionValue: 'Bear Fruit Yoyo - Mango 20g',
        processedSku: 'BE_Y_5_MNG',
        outOfStock: false,
        extra: 'Bulk Custom Pack',
        costPrice: 3.10
      }
    ];

    for (const m of sampleMappings) {
      await CustomizationMapping.upsert(m);
    }

    console.log('✅ Seeded 5 initial Customization Mappings successfully!');
  } catch (err) {
    console.error('Error seeding data:', err);
  } finally {
    await sequelize.close();
  }
}

seedData();
