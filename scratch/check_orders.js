require('dotenv').config();
const { SalesOrder } = require('../models');

async function check() {
  try {
    const orders = await SalesOrder.findAll();
    console.log('--- Orders in Database ---');
    orders.forEach(o => {
      console.log({
        id: o.id,
        orderNumber: o.orderNumber,
        notes: o.notes,
        notesFromBuyer: o.notesFromBuyer,
        notesToBuyer: o.notesToBuyer,
        giftNote: o.giftNote,
        internalNotes: o.internalNotes
      });
    });
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

check();
