const fs = require('fs');
const path = require('path');

// The affiliate programme keeps its own small file (data/afiliados.json) instead of db.json:
// every click is a write, and db.json is large (it carries the ticket PDFs), so sharing it
// would make each click rewrite megabytes.
const FILE = path.join(__dirname, '..', 'data', 'afiliados.json');

const empty = () => ({ afiliados: {}, sessoes: {}, cliques: [], comissoes: {}, pagamentos: {} });
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').trim() : '';
    cache = raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch (err) {
    console.error('afiliados.json ilegivel, comecando vazio em memoria:', err.message);
    cache = empty();
  }
  return cache;
}

function save(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

// Writes are serialized, like store.withDb.
let chain = Promise.resolve();
function withData(mutator) {
  chain = chain.then(() => {
    const data = load();
    const result = mutator(data);
    save(data);
    return result;
  });
  return chain;
}

module.exports = { load, withData, FILE };
