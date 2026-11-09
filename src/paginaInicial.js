const store = require('./store');
const { EVENTS, currentEvent } = require('./event');

// ---------------------------------------------------------------------------
// Pagina inicial do site (crewolada.com), escolhida no admin (aba Eventos).
//   db.homePage = 'evento'          -> pagina de venda do evento atual (padrao, como sempre foi)
//   db.homePage = 'links'           -> a pagina /links passa a ser a inicial
//   db.homePage = 'gratuito:<id>'   -> a inscricao de um evento gratuito (ex.: /SP) vira a inicial
// A pagina de venda do evento atual continua sempre disponivel em /ingressos, para que
// a compra nunca fique sem caminho quando a inicial for outra pagina.
// ---------------------------------------------------------------------------
const freeOk = (e) => Boolean(e && e.free && e.slug && !e.hidden);

function resolveHome(db) {
  const h = String((db || {}).homePage || 'evento');
  if (h === 'links') return { tipo: 'links' };
  if (h.startsWith('gratuito:')) {
    const ev = EVENTS.find((e) => e.id === h.slice('gratuito:'.length));
    if (freeOk(ev)) return { tipo: 'gratuito', ev };
  }
  return { tipo: 'evento' };
}

// Options offered in the admin: every event a visitor could still land on.
function opcoesHome(db) {
  const now = Date.now();
  const home = resolveHome(db);
  const selecionado = home.tipo === 'links' ? 'links'
    : home.tipo === 'gratuito' ? `evento:${home.ev.id}` : `evento:${currentEvent.id}`;
  const eventos = EVENTS
    .filter((e) => {
      if (e.id === currentEvent.id) return true;
      if (e.cancelledAt) return false;
      const futuro = !e.startAt || Date.parse(e.startAt) + 5 * 3600000 > now;
      return futuro && (!e.free || freeOk(e));
    })
    .sort((a, b) => String(a.startAt || '9999').localeCompare(String(b.startAt || '9999')))
    .map((e) => ({
      value: `evento:${e.id}`,
      nome: e.name,
      dateLabel: e.dateLabel,
      tipo: e.free ? 'Inscrição gratuita' : 'Venda de ingressos',
      atual: e.id === currentEvent.id,
      cancelado: Boolean(e.cancelledAt),
    }));
  const aguardando = EVENTS.filter((e) => e.free && e.slug && e.hidden && !e.cancelledAt).map((e) => e.name);
  return { selecionado, eventos, aguardando };
}

function registerPaginaInicialRoutes(app, { requireAdminAuth, onChange }) {
  app.post('/admin/pagina-inicial', requireAdminAuth, async (req, res) => {
    const destino = String(req.body.destino || '');
    let alvo = null;
    let tornarAtual = null;
    if (destino === 'links') {
      alvo = 'links';
    } else if (destino.startsWith('evento:')) {
      const ev = EVENTS.find((e) => e.id === destino.slice('evento:'.length));
      if (!ev) return res.redirect('/admin/eventos?msg=dados');
      if (ev.free) {
        if (!freeOk(ev)) return res.redirect('/admin/eventos?msg=home-oculto');
        alvo = `gratuito:${ev.id}`;
      } else {
        alvo = 'evento';
        tornarAtual = ev.id; // the ticket sale follows the page shown on the home
      }
    } else {
      return res.redirect('/admin/eventos?msg=dados');
    }
    await store.withDb((db) => {
      db.homePage = alvo;
      if (tornarAtual) db.currentEventId = tornarAtual;
    });
    onChange();
    res.redirect('/admin/eventos?msg=home');
  });
}

module.exports = { registerPaginaInicialRoutes, resolveHome, opcoesHome };
