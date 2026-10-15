// {{evento}}, {{data}}, {{hora}} and {{local}} come from the current event
// (src/event.js), so the defaults stay correct from one event to the next.
const DEFAULT_TEMPLATES = {
  compra:
    '🔥 É OFICIAL! Seu ingresso para a {{evento}} está confirmado. 🎟️\n\n' +
    '📅 {{data}} {{hora}}\n📍 {{local}}\n🎫 Código: {{codigo}}\n\n' +
    'Apresente o QR Code do PDF na entrada. Ingresso pessoal e intransferível.\n\nNos vemos lá! 🖤',
  dias5: 'Oi {{nome}}! Faltam so 5 dias para a {{evento}}! Prepara o look, deixa seu ingresso guardado e nos vemos dia {{data}} em {{local}}. 🎉',
  dia1: 'Oi {{nome}}! Amanha e o grande dia da {{evento}}! Nao esqueca de levar seu ingresso (QR Code, impresso ou no celular) e documento com foto. Ate amanha! 🎉',
  diaEvento: 'Oi {{nome}}! Hoje e o dia da {{evento}}! Nos vemos la: {{local}}. Guarde seu ingresso a mao para a entrada. 🎉',
  hora1: 'Oi {{nome}}! Falta 1 hora para a {{evento}} comecar! Ja pode vir chegando. Nos vemos ja ja! 🎉',
};

// A template the admin left empty falls back to the default, so a blank
// "compra" box can never make the ticket message revert to old hard-coded text.
function getTemplates(db) {
  const saved = db.messageTemplates || {};
  const merged = { ...DEFAULT_TEMPLATES };
  Object.keys(saved).forEach((k) => {
    if (typeof saved[k] === 'string' && saved[k].trim() !== '') merged[k] = saved[k];
  });
  return merged;
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? '');
}

module.exports = { DEFAULT_TEMPLATES, getTemplates, renderTemplate };
