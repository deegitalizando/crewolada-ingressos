require('dotenv').config();
const crypto = require('crypto');
const store = require('../src/store');
const { buildTicketsForOrder } = require('../src/tickets');

const eventInfo = {
  name: process.env.EVENT_NAME || 'Crewolada',
  dateLabel: process.env.EVENT_DATE_LABEL || '10/10/2026',
  venue: process.env.EVENT_VENUE || 'Bangu Atletico Clube',
};

async function main() {
  const order = {
    id: crypto.randomUUID(),
    buyerName: 'Comprador Teste',
    buyerEmail: 'teste@example.com',
    buyerPhone: '21999999999',
    buyerCpf: '11144477735',
    quantity: 1,
    loteName: '1o Lote',
    unitPrice: 15,
    totalAmount: 15,
    status: 'paid',
    mpPreferenceId: 'test',
    mpPaymentId: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const tickets = await buildTicketsForOrder(order, eventInfo);

  await store.withDb((db) => {
    db.orders[order.id] = order;
    tickets.forEach((t) => {
      db.tickets[t.code] = t;
    });
  });

  console.log('orderId=', order.id);
  console.log('ticketCode=', tickets[0].code);
}

main();
