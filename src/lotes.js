// Default lotes, used only the first time the app runs (before an admin
// saves anything in /admin/lotes). After that, db.lotes in the persisted
// store is the source of truth and can be edited from the admin panel.
const DEFAULT_LOTES = [
  { name: '1o Lote', quantity: 50, price: 15.0 },
  { name: '2o Lote', quantity: 150, price: 20.0 },
  { name: '3o Lote', quantity: 800, price: 25.0 },
];

function getLotes(db) {
  if (Array.isArray(db.lotes) && db.lotes.length > 0) {
    return db.lotes.map((l) => ({ name: l.name, quantity: Number(l.quantity), price: Number(l.price) }));
  }
  return DEFAULT_LOTES;
}

// Ticket price follows how many have already sold: the first lote's
// quantity sells at its price, the next lote's quantity at its price, and
// so on. Returns null once every lote's stock is gone.
function getCurrentLote(lotes, soldCount) {
  let floor = 0;
  for (const lote of lotes) {
    const ceiling = floor + lote.quantity;
    if (soldCount < ceiling) {
      return { ...lote, remaining: ceiling - soldCount };
    }
    floor = ceiling;
  }
  return null;
}

function getTotalCapacity(lotes) {
  return lotes.reduce((sum, l) => sum + l.quantity, 0);
}

module.exports = { DEFAULT_LOTES, getLotes, getCurrentLote, getTotalCapacity };
