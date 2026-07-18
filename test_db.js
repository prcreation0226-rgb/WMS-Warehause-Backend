const { Product, ProductStock } = require('./models');

async function test() {
  try {
    const product = await Product.findOne({ where: { sku: 'SKU-003' } });
    if (!product) {
      console.log('Product SKU-003 not found!');
      return;
    }
    console.log('Product found:', { id: product.id, name: product.name, sku: product.sku });
    const stocks = await ProductStock.findAll({
      where: { productId: product.id }
    });
    console.log(`Found ${stocks.length} stock rows:`);
    stocks.forEach((s, idx) => {
      console.log(`Row #${idx + 1}:`, {
        id: s.id,
        quantity: s.quantity,
        batchNumber: s.batchNumber,
        bestBeforeDate: s.bestBeforeDate,
        locationId: s.locationId,
        clientId: s.clientId
      });
    });
  } catch (err) {
    console.error('Error running test:', err);
  } finally {
    process.exit(0);
  }
}

test();
