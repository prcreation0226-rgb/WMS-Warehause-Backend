const { GoodsReceipt, GoodsReceiptItem } = require('./models');

async function run() {
  try {
    const pendingReceipts = await GoodsReceipt.findAll({
      where: { status: 'pending' },
      include: ['GoodsReceiptItems']
    });

    console.log(`Found ${pendingReceipts.length} pending Goods Receipts.`);

    for (const gr of pendingReceipts) {
      console.log(`Resetting qtyToBook for GRN: ${gr.grNumber} (PO: ${gr.purchaseOrderId})`);
      for (const item of gr.GoodsReceiptItems) {
        await item.update({ qtyToBook: 0 });
      }
    }

    console.log('Successfully reset all pending ASN/GRN item quantities to 0!');
    process.exit(0);
  } catch (err) {
    console.error('Error running update:', err);
    process.exit(1);
  }
}

run();
