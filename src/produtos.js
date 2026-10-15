// Ticket products and the children's pricing rules of an event.
//
// A purchase is ONE product (e.g. "Ingresso Simples" or "Passaporte") with a
// head count per category:
//   adulto  -> full product price
//   crianca -> half price (from freeUntil+1 up to halfUntil years)
//   bebe    -> free (up to freeUntil years)
// Prices are always recomputed on the server from the event config.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const DEFAULT_RULES = { freeUntil: 2, halfUntil: 12, freeCountsInCapacity: false };

function getChildRules(event) {
  const r = { ...DEFAULT_RULES, ...((event && event.childRules) || {}) };
  r.freeUntil = Math.max(0, parseInt(r.freeUntil, 10) || 0);
  r.halfUntil = Math.max(r.freeUntil, parseInt(r.halfUntil, 10) || 0);
  r.freeCountsInCapacity = Boolean(r.freeCountsInCapacity);
  return r;
}

function getProducts(event) {
  const list = event && Array.isArray(event.products) ? event.products : [];
  return list
    .filter((p) => p && p.id && p.name && Number(p.price) > 0)
    .map((p) => ({
      id: String(p.id),
      name: String(p.name),
      price: round2(p.price),
      includes: Array.isArray(p.includes) ? p.includes.map((s) => String(s).trim()).filter(Boolean) : [],
    }));
}

function kindLabel(kind, rules) {
  if (kind === 'crianca') return `Criança ${rules.freeUntil + 1} a ${rules.halfUntil} anos (meia)`;
  if (kind === 'bebe') return `Criança até ${rules.freeUntil} anos (grátis)`;
  return 'Adulto';
}

function kindPrice(product, kind) {
  if (kind === 'adulto') return product.price;
  if (kind === 'crianca') return round2(product.price / 2);
  return 0;
}

// Validates the requested head count and prices it. Returns { error } or the purchase.
function buildPurchase(event, input, { maxPersons = 10, remaining = Infinity } = {}) {
  const products = getProducts(event);
  const rules = getChildRules(event);
  const product = products.find((p) => p.id === String(input.produto || input.productId || ''));
  if (!product) return { error: 'Escolha um tipo de ingresso.' };

  const n = (v) => Math.max(0, Math.min(99, parseInt(v, 10) || 0));
  const counts = { adulto: n(input.adultos), crianca: n(input.criancas), bebe: n(input.bebes) };
  if (counts.adulto < 1) return { error: 'É preciso pelo menos 1 adulto na compra.' };

  const persons = counts.adulto + counts.crianca + counts.bebe;
  if (persons > maxPersons) return { error: `No máximo ${maxPersons} pessoas por compra.` };

  const paying = counts.adulto + counts.crianca + (rules.freeCountsInCapacity ? counts.bebe : 0);
  if (paying > remaining) return { error: 'Não há ingressos suficientes disponíveis.' };

  const items = ['adulto', 'crianca', 'bebe']
    .filter((k) => counts[k] > 0)
    .map((k) => ({ kind: k, qty: counts[k], unitPrice: kindPrice(product, k), label: kindLabel(k, rules) }));

  const total = round2(items.reduce((s, i) => s + i.qty * i.unitPrice, 0));
  return { product, rules, items, persons, paying, total, includes: product.includes };
}

// Ticket-by-ticket category list for an order that has items.
function expandKinds(order) {
  const out = [];
  (order.items || []).forEach((i) => { for (let k = 0; k < i.qty; k += 1) out.push(i); });
  return out;
}

module.exports = { DEFAULT_RULES, getChildRules, getProducts, kindLabel, kindPrice, buildPurchase, expandKinds, round2 };
