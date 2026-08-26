const DEFAULT_TEMPLATES = {
  compra: '',
  dias5: 'Oi {{nome}}! Faltam so 5 dias para a Crewolada 2026! Prepara o look, garante seu ingresso guardado e nos vemos dia 10/10 no Bangu Atletico Clube. 🎉',
  dia1: 'Oi {{nome}}! Amanha e o grande dia da Crewolada! Nao esqueca de levar seu ingresso (QR Code, impresso ou no celular) e documento com foto. Ate amanha! 🎉',
  diaEvento: 'Oi {{nome}}! Hoje e o dia da Crewolada! Nos vemos la no Bangu Atletico Clube. Guarde seu ingresso a mao para a entrada. 🎉',
  hora1: 'Oi {{nome}}! Falta 1 hora para a Crewolada comecar! Ja pode vir chegando. Nos vemos ja ja! 🎉',
};

function getTemplates(db) {
  return { ...DEFAULT_TEMPLATES, ...(db.messageTemplates || {}) };
}

function renderTemplate(template, vars) {
  return String(template || '').replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? '');
}

module.exports = { DEFAULT_TEMPLATES, getTemplates, renderTemplate };
