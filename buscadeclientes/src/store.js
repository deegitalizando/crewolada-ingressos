const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

function defaultDb() {
  return {
    searches: {},
    leads: {},
    settings: {
      whatsappTemplate:
        'Ola {{nome}}! Aqui e da Deegitalizando, agencia de marketing digital. ' +
        'Vi que a {{negocio}} ainda nao tem um site (ou o site atual poderia estar melhor) ' +
        'e ja preparamos, sem compromisso, uma previa de um site profissional pra voces:\n\n' +
        '{{link}}\n\n' +
        'Da uma olhada quando puder. Se gostar, a gente monta tudo certinho: site no ar, ' +
        'atendimento automatico no WhatsApp (agenda horario sozinho) e anuncios pra atrair mais clientes.',
      emailSubject: 'Preparamos uma previa de site para {{negocio}}',
      emailTemplate:
        'Ola {{nome}},\n\n' +
        'Somos a Deegitalizando, agencia de marketing digital. Preparamos uma previa gratuita ' +
        'de um site profissional para a {{negocio}}, sem compromisso:\n\n{{link}}\n\n' +
        'Se fizer sentido pra voces, cuidamos de tudo: site no ar, atendimento automatico via ' +
        'WhatsApp com IA (que atende e agenda horarios sozinho) e trafego pago para atrair mais clientes.\n\n' +
        'Qualquer duvida, e so responder este e-mail.',
    },
  };
}

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return defaultDb();
  }
  const raw = fs.readFileSync(DB_FILE, 'utf8').trim();
  if (!raw) return defaultDb();
  const db = JSON.parse(raw);
  const def = defaultDb();
  db.searches = db.searches || {};
  db.leads = db.leads || {};
  db.settings = { ...def.settings, ...(db.settings || {}) };
  return db;
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// Serializa escritas para requisicoes concorrentes (varios leads sendo
// processados ao mesmo tempo em uma busca) nao se sobrescreverem.
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

module.exports = { load, save, withDb };
