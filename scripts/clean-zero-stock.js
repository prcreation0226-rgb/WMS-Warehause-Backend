const { ProductStock } = require('../models');

async function cleanZeroStock() {
  try {
    const deletedCount = await ProductStock.destroy({
      where: {
        quantity: 0
      }
    });
    console.log(`Deleted ${deletedCount} stock records with 0 quantity.`);
  } catch (error) {
    console.error('Error deleting zero stock records:', error);
  } finally {
    process.exit(0);
  }
}

cleanZeroStock();
