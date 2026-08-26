const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { orders: {}, tickets: {} };
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
  if (!raw) return { orders: {}, tickets: {} };
  return JSON.parse(raw);
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Serializes writes so concurrent requests (e.g. duplicate MP webhook retries)
// can't interleave read-modify-write cycles and clobber each other's changes.
let writeChain = Promise.resolve();
function withDb(mutator) {
  writeChain = writeChain.then(() => {
    const db = load();
    const result = mutator(db);
    save(db);
    return result;
  });
  return writeChain;
}

module.exports = {
  load,
  withDb,
};
