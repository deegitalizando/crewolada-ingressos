const store = require('./store');
const { EVENTS, currentEvent, eventStatus } = require('./event');

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
function ticketEvents(salesOpen) {
  const now = Date.now();
  return EVENTS
    .filter((e) => {
      const upcoming = !e.startAt || Date.parse(e.startAt) + 5 * 3600000 > now;
      if (!upcoming) return false;
      if (e.id === currentEvent.id) return salesOpen;
      return Boolean(e.free && e.slug);
    })
    .sort((a, b) => String(a.startAt || '9999').localeCompare(String(b.startAt || '9999')))
    .map((e) => ({
      id: e.id,
      name: e.name,
      dateLabel: e.dateLabel,
      timeLabel: e.timeLabel || '',
      venue: e.venue || '',
      href: e.id === currentEvent.id ? '/' : `/${e.slug}`,
      free: Boolean(e.free),
      note: e.tagline || '',
      status: eventStatus(e),
    }));
}

function registerLinksRoutes(app, { requireAdminAuth, eventInfo, salesOpenNow }) {
  app.get('/links', (req, res) => {
    res.render('links', {
      eventInfo,
      // "Em breve" while the ticket sale of the current event has not opened yet.
      emBreve: !(salesOpenNow ? salesOpenNow() : app.locals.salesOpen),
      events: ticketEvents(salesOpenNow ? salesOpenNow() : app.locals.salesOpen),
      baseUrl: process.env.BASE_URL || '',
    });
  });

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
      saved: req.query.saved === '1',
      error: req.query.erro === '1',
      baseUrl: process.env.BASE_URL || '',
    });
  });

  app.post('/admin/links', requireAdminAuth, async (req, res) => {
    const youtube = String(req.body.youtube || '').trim();
    const playlist = String(req.body.playlist || '').trim();
    if ((youtube && !isHttps(youtube)) || (playlist && !isHttps(playlist))) return res.redirect('/admin/links?erro=1');
    await store.withDb((db) => { db.links = { ...(db.links || {}), youtube, playlist }; });
    res.redirect('/admin/links?saved=1');
  });
}

module.exports = { registerLinksRoutes, ticketEvents };
