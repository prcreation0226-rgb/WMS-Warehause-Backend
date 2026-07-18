const { SalesOrder } = require('./models');

async function run() {
  try {
    const orders = await SalesOrder.findAll();
    console.log('Orders found:', orders.length);
    for (const order of orders) {
      console.log(`ID: ${order.id} | OrderNumber: ${order.orderNumber} | Notes: ${order.notes} | NotesFromBuyer: ${order.notesFromBuyer} | NotesToBuyer: ${order.notesToBuyer} | GiftNote: ${order.giftNote} | InternalNotes: ${order.internalNotes} | ExternalRef: ${order.externalRef} | Tags: ${order.tags}`);
    }
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}

run();
