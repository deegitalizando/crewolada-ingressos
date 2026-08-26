const LOTES = [
  // TODO: remover este lote de teste antes da venda valer pra todo mundo.
  { name: 'Lote Teste', quantity: 1, price: 1.0 },
  { name: '1o Lote', quantity: 50, price: 15.0 },
  { name: '2o Lote', quantity: 150, price: 20.0 },
  { name: '3o Lote', quantity: 800, price: 25.0 },
];

// Ticket price follows how many have already sold: the first LOTES[0].quantity
// tickets sell at LOTES[0].price, the next LOTES[1].quantity at LOTES[1].price,
// and so on. Returns null once every lote's stock is gone.
function getCurrentLote(soldCount) {
  let floor = 0;
  for (const lote of LOTES) {
    const ceiling = floor + lote.quantity;
    if (soldCount < ceiling) {
      return { ...lote, remaining: ceiling - soldCount };
    }
    floor = ceiling;
  }
  return null;
}

function getTotalCapacity() {
  return LOTES.reduce((sum, l) => sum + l.quantity, 0);
}

module.exports = { LOTES, getCurrentLote, getTotalCapacity };
