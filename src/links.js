const store = require('./store');
const { resolveHome } = require('./paginaInicial');
const { EVENTS, currentEvent, eventStatus, showLeft } = require('./event');
const linkButtons = require('./linkButtons');

// Public "link in bio" page (/links), the story (/sobre) and short redirects
// (/youtube, /playlist). The two redirect targets are editable in the admin
// (/admin/links) so they can change without a deploy; YOUTUBE_URL / PLAYLIST_URL
// env vars take precedence when set.
const FALLBACKS = {
  youtube: 'https://www.youtube.com/@festacrewolada',
  playlist: 'https://open.spotify.com/playlist/05T8GiPzEl87DYLlaXwu4g',
};

const isHttps = (u) => /^https:\/\/[^\s]+$/i.test(String(u || '').trim());

function targetFor(key) {
  const env = key === 'youtube' ? process.env.YOUTUBE_URL : process.env.PLAYLIST_URL;
  if (isHttps(env)) return env.trim();
  const saved = (store.load().links || {})[key];
  if (isHttps(saved)) return saved.trim();
  return FALLBACKS[key];
}

function isConfigured(key, db) {
  const env = key === 'youtube' ? process.env.YOUTUBE_URL : process.env.PLAYLIST_URL;
  return isHttps(env) || isHttps(((db || store.load()).links || {})[key]);
}

// Events a visitor can still get a ticket for: the one on sale on the home page
// and the free ones that have their own registration page.
function ticketEvents(salesOpen, availableNow) {
  const now = Date.now();
  return EVENTS
    .filter((e) => {
      const upcoming = !e.startAt || Date.parse(e.startAt) + 5 * 3600000 > now;
      if (!upcoming || e.cancelledAt) return false;
      if (e.id === currentEvent.id) return salesOpen;
      return Boolean(e.free && e.slug && !e.hidden);
    })
    .sort((a, b) => String(a.startAt || '9999').localeCompare(String(b.startAt || '9999')))
    .map((e) => ({
      id: e.id,
      name: e.name,
      dateLabel: e.dateLabel,
      timeLabel: e.timeLabel || '',
      venue: e.venue || '',
      // The sale page is the home unless the admin put something else there.
      // /ingressos always shows the sale of the current event, whatever the home page is.
      href: e.id === currentEvent.id ? '/ingressos' : `/${e.slug}`,
      free: Boolean(e.free),
      note: e.tagline || '',
      status: eventStatus(e),
      left: (() => {
        if (e.id !== currentEvent.id || !availableNow) return null;
        const n = availableNow();
        return showLeft(n, e) ? n : null; // only when few are left
      })(),
      total: e.id === currentEvent.id ? e.capacity || null : null,
    }));
}

function registerLinksRoutes(app, { requireAdminAuth, eventInfo, salesOpenNow, availableNow }) {
  // The Ingressos button either opens the list of events (auto) or goes straight to
  // one event's page / a custom link, as set in /admin/links.
  function withTicketTarget(buttons, events) {
    return buttons.map((b) => {
      if (b.tipo !== 'ingressos') return b;
      if (b.destino === 'link' && b.url) return { ...b, href: b.url };
      if (b.destino === 'evento') {
        const ev = events.find((e) => e.id === b.eventoId);
        if (ev) return { ...b, href: ev.href };
      }
      return b; // auto, or the chosen event is no longer on sale
    });
  }

  const renderLinks = (req, res) => {
    const open = salesOpenNow ? salesOpenNow() : app.locals.salesOpen;
    const events = ticketEvents(open, availableNow);
    res.render('links', {
      eventInfo,
      // "Em breve" while the ticket sale of the current event has not opened yet.
      emBreve: !open,
      events,
      buttons: withTicketTarget(linkButtons.getButtons(store.load(), app.locals.communityUrl), events),
      baseUrl: process.env.BASE_URL || '',
    });
  };
  app.get('/links', renderLinks);

  app.get('/sobre', (req, res) => {
    res.render('sobre', { eventInfo, baseUrl: process.env.BASE_URL || '' });
  });

  app.get('/youtube', (req, res) => res.redirect(302, targetFor('youtube')));
  app.get('/playlist', (req, res) => res.redirect(302, targetFor('playlist')));

  app.get('/admin/links', requireAdminAuth, (req, res) => {
    const db = store.load();
    res.render('admin_links', {
      eventInfo,
      links: db.links || {},
      configured: { youtube: isConfigured('youtube', db), playlist: isConfigured('playlist', db) },
      envLocked: { youtube: isHttps(process.env.YOUTUBE_URL), playlist: isHttps(process.env.PLAYLIST_URL) },
      buttons: linkButtons.getButtons(db, app.locals.communityUrl),
      // Events the Ingressos button can point to (the one on sale + free registrations).
      ticketTargets: ticketEvents(true, null).map((e) => ({ id: e.id, label: `${e.name} · ${e.dateLabel}${e.id === currentEvent.id ? ' (evento à venda)' : e.free ? ' (inscrição gratuita)' : ''}`, href: e.href })),
      currentEventName: currentEvent.name,
      icones: linkButtons.ICONES,
      estilos: linkButtons.ESTILOS,
      msg: req.query.msg || null,
      erroBotoes: req.query.erroBotoes || null,
      saved: req.query.saved === '1',
      error: req.query.erro === '1',
      baseUrl: process.env.BASE_URL || '',
    });
  });

  // Buttons of /links: the whole list (order, texts, links, visibility) comes as JSON.
  app.post('/admin/links/botoes', requireAdminAuth, async (req, res) => {
    if (req.body.restaurar === '1') {
      await store.withDb((db) => { delete db.linkButtons; });
      return res.redirect('/admin/links?msg=restaurado');
    }
    let list;
    try { list = JSON.parse(String(req.body.botoes || '')); } catch (e) { list = null; }
    const out = linkButtons.sanitize(list);
    if (out.error) return res.redirect(`/admin/links?erroBotoes=${encodeURIComponent(out.error)}`);
    await store.withDb((db) => { db.linkButtons = out.botoes; });
    res.redirect('/admin/links?msg=botoes');
  });

  app.post('/admin/links', requireAdminAuth, async (req, res) => {
    const youtube = String(req.body.youtube || '').trim();
    const playlist = String(req.body.playlist || '').trim();
    if ((youtube && !isHttps(youtube)) || (playlist && !isHttps(playlist))) return res.redirect('/admin/links?erro=1');
    await store.withDb((db) => { db.links = { ...(db.links || {}), youtube, playlist }; });
    res.redirect('/admin/links?saved=1');
  });

  return { renderLinks };
}

module.exports = { registerLinksRoutes, ticketEvents };
