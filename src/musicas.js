// Daily music suggestions for the event's DJ/playlist team (black music cristã).
//
// Discovery uses the public Deezer API (no key) for artists, top tracks and
// 30s previews, and the iTunes Search API for the official purchase link.
// Free downloads come from Bandcamp releases the artists themselves offer for
// free / name-your-price.
// We only ever link to legitimate places to listen/buy/download (Apple Music /
// iTunes, Bandcamp, Amazon, Deezer, Spotify, YouTube) — never to pirated
// files.
//
// Artists found through Deezer's "related artists" are NOT trusted
// automatically: related lists can drift into secular/off-genre artists, so
// they enter as "pendente" and only feed the daily suggestions after someone
// approves them in /downloads.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STATE_FILE = path.join(__dirname, '..', 'data', 'musicas.json');

const ESTILOS = ['Neo soul', 'Soulful rap', 'Boom bap', 'R&B', 'Trap', 'Hip hop', 'Hip hop soul'];

// Reference tracks sent by the team — their artists seed the pool.
const REFERENCE_TRACKS = [
  { q: 'artist:"4th Avenue Jones" track:"Move On"', fallback: '4th Avenue Jones', estilo: 'Hip hop soul' },
  { q: 'artist:"Deitrick Haddon" track:"7 Days"', fallback: 'Deitrick Haddon', estilo: 'Hip hop soul' },
  { q: 'artist:"Isaiah" track:"I Can\'t Even Breathe"', fallback: null, estilo: 'R&B' },
  { q: 'artist:"R-Swift" track:"Love Letter"', fallback: 'R-Swift', estilo: 'Boom bap' },
];

const SEED_ARTISTS = [
  ['Jonathan McReynolds', 'Neo soul'],
  ['Mali Music', 'Neo soul'],
  ['Anthony Brown & group therAPy', 'R&B'],
  ['Koryn Hawthorne', 'R&B'],
  ['Mary Mary', 'Hip hop soul'],
  ['Trin-i-tee 5:7', 'R&B'],
  ['Tye Tribbett', 'Hip hop soul'],
  ['Kirk Franklin', 'Hip hop soul'],
  ['J Moss', 'R&B'],
  ['Isaac Carree', 'R&B'],
  ['Canton Jones', 'Hip hop soul'],
  ['Propaganda', 'Soulful rap'],
  ['Sho Baraka', 'Soulful rap'],
  ['Jackie Hill Perry', 'Soulful rap'],
  ['Beautiful Eulogy', 'Soulful rap'],
  ['Dee-1', 'Soulful rap'],
  ['Shai Linne', 'Boom bap'],
  ['Cross Movement', 'Boom bap'],
  ['Flame', 'Boom bap'],
  ['Json', 'Boom bap'],
  ['Trip Lee', 'Hip hop'],
  ['Lecrae', 'Hip hop'],
  ['Jor\'dan Armstrong', 'Hip hop'],
  ['KB', 'Trap'],
  ['Tedashii', 'Trap'],
  ['116', 'Trap'],
  ['Andy Mineo', 'Hip hop'],
  ['Social Club Misfits', 'Trap'],
  ['Hulvey', 'Trap'],
  ['GAWVI', 'Trap'],
  ['WHATUPRG', 'Trap'],
  ['Aaron Cole', 'Hip hop'],
  ['Wande', 'Trap'],
  ['Pregador Luo', 'Hip hop'],
  ['Ao Cubo', 'Hip hop'],
  ['Kivitz', 'Hip hop'],
];

const ARTISTS_PER_DAY = 8;
const TRACKS_PER_ARTIST = 2;
const DISCOVERY_SOURCES_PER_DAY = 3;
const MAX_NEW_PENDING_PER_DAY = 6;

const http = axios.create({ timeout: 15000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- state -----------------------------------------------------------

function load() {
  if (!fs.existsSync(STATE_FILE)) return { artists: {}, days: {}, marks: {}, seeded: false };
  const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
  if (!raw) return { artists: {}, days: {}, marks: {}, seeded: false };
  return JSON.parse(raw);
}

function save(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let writeChain = Promise.resolve();
function withState(mutator) {
  writeChain = writeChain.then(async () => {
    const state = load();
    const result = await mutator(state);
    save(state);
    return result;
  });
  return writeChain;
}

function todayBrasilia(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hourBrasilia(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(date)
  ) % 24;
}

// ---- external APIs ---------------------------------------------------

async function deezer(pathAndQuery) {
  const { data } = await http.get(`https://api.deezer.com${pathAndQuery}`);
  if (data && data.error) throw new Error(`Deezer: ${data.error.message || 'erro'}`);
  await sleep(150); // stay well under Deezer's 50 req / 5s
  return data;
}

async function findArtistByName(name) {
  const data = await deezer(`/search/artist?q=${encodeURIComponent(name)}&limit=5`);
  const list = data.data || [];
  const exact = list.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return exact || null;
}

async function itunesLink(artist, title) {
  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const { data } = await http.get(`https://itunes.apple.com/search?term=${term}&entity=song&limit=5&country=BR`);
    const hit = (data.results || []).find(
      (r) => r.artistName && r.artistName.toLowerCase().includes(artist.toLowerCase().split(' ')[0])
    );
    return hit ? hit.trackViewUrl : null;
  } catch {
    return null;
  }
}

function buildLinks(artist, title, deezerLink, appleLink) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    deezer: deezerLink,
    apple: appleLink,
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=t`,
    amazon: `https://music.amazon.com.br/search/${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

// ---- pool seeding ----------------------------------------------------

function addArtist(state, a, estilo, status, origem) {
  if (state.artists[a.id]) return false;
  state.artists[a.id] = {
    id: a.id,
    name: a.name,
    picture: a.picture_medium || null,
    estilo,
    status,
    origem,
    lastUsed: null,
    addedAt: new Date().toISOString(),
  };
  return true;
}

async function seedPool(state) {
  for (const ref of REFERENCE_TRACKS) {
    try {
      const data = await deezer(`/search?q=${encodeURIComponent(ref.q)}&limit=1`);
      const track = (data.data || [])[0];
      if (track) addArtist(state, track.artist, ref.estilo, 'aprovado', 'referência');
      else if (ref.fallback) {
        const a = await findArtistByName(ref.fallback);
        if (a) addArtist(state, a, ref.estilo, 'aprovado', 'referência');
      }
    } catch (err) {
      console.error('[musicas] falha ao buscar referencia', ref.q, err.message);
    }
  }
  for (const [name, estilo] of SEED_ARTISTS) {
    try {
      const a = await findArtistByName(name);
      if (a) addArtist(state, a, estilo, 'aprovado', 'curadoria');
    } catch (err) {
      console.error('[musicas] falha ao buscar artista', name, err.message);
    }
  }
  state.seeded = true;
}


// ---- free downloads (Bandcamp) ---------------------------------------
//
// Releases the artists themselves put up as "free download" or "name your
// price" (min. 0) on Bandcamp. Only Christian-specific tags are scanned —
// generic ones like "neo-soul"/"gospel" bring in secular music and
// unlicensed mashups.

const BANDCAMP_TAGS = [
  ['christian-hip-hop', 'Hip hop'],
  ['holy-hip-hop', 'Boom bap'],
  ['christian-rap', 'Hip hop'],
  ['gospel-rap', 'Soulful rap'],
  ['gospel-hip-hop', 'Hip hop soul'],
  ['hip-hop-gospel', 'Hip hop soul'],
  ['rap-gospel', 'Hip hop'],
  ['christian-trap', 'Trap'],
  ['christian-r-b', 'R&B'],
  ['christian-soul', 'Neo soul'],
  ['gospel-soul', 'Neo soul'],
];
const FREE_PER_DAY = 15;
const FREE_EXCLUDE = /mash-?up|bootleg|type beat/i;

async function bandcampDiscover(tag, slice, cursor) {
  const res = await fetch('https://bandcamp.com/api/discover/1/discover_web', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'CrewoladaMusicBot/1.0 (+https://crewolada.com)' },
    body: JSON.stringify({
      category_id: 0,
      tag_norm_names: [tag],
      geoname_id: 0,
      slice,
      time_facet_id: null,
      cursor,
      size: 60,
      include_result_types: ['a', 's'],
    }),
  });
  if (!res.ok) throw new Error(`Bandcamp HTTP ${res.status}`);
  const data = await res.json();
  await sleep(400);
  return data;
}

function toFreeSuggestion(r, estilo, tag) {
  const isTrack = r.item_type === 't';
  return {
    id: `bc-${r.item_id}`,
    source: 'bandcamp',
    title: r.title,
    artist: r.band_name,
    cover: r.primary_image ? `https://f4.bcbits.com/img/${r.primary_image.is_art ? 'a' : ''}${r.primary_image.image_id}_9.jpg` : null,
    url: String(r.item_url || '').split('?')[0],
    embed: `https://bandcamp.com/EmbeddedPlayer/${isTrack ? 'track' : 'album'}=${r.item_id}/size=small/bgcol=121212/linkcol=f4b942/transparent=true/`,
    kind: isTrack ? 'Single' : `Álbum · ${r.track_count || '?'} faixas`,
    freeType: r.is_free_download ? 'Download grátis' : 'Pague quanto quiser (pode ser R$ 0)',
    location: r.band_location || null,
    releaseDate: r.release_date ? r.release_date.slice(0, 10) : null,
    estilo,
    tag,
  };
}

function isFree(r) {
  return r.is_free_download || (!r.is_set_price && r.price && r.price.amount === 0);
}

async function findFreeDownloads(seenIds) {
  const found = [];
  const perTag = Math.ceil(FREE_PER_DAY / 4);
  for (const [tag, estilo] of shuffle(BANDCAMP_TAGS)) {
    if (found.length >= FREE_PER_DAY) break;
    let taken = 0;
    // New releases first, then the all-time top, so each day brings fresh
    // drops but the backlog of good free stuff still surfaces over time.
    for (const slice of ['new', 'top']) {
      let cursor = '*';
      for (let page = 0; page < 5 && cursor && taken < perTag; page++) {
        try {
          const data = await bandcampDiscover(tag, slice, cursor);
          for (const r of data.results || []) {
            const id = `bc-${r.item_id}`;
            if (taken >= perTag || found.length >= FREE_PER_DAY) break;
            if (!isFree(r) || seenIds.has(id) || FREE_EXCLUDE.test(r.title)) continue;
            found.push(toFreeSuggestion(r, estilo, tag));
            seenIds.add(id);
            taken++;
          }
          cursor = (data.results || []).length ? data.cursor : null;
        } catch (err) {
          console.error('[musicas] bandcamp falhou', tag, err.message);
          cursor = null;
        }
      }
      if (taken >= perTag) break;
    }
  }
  return found;
}

// ---- daily generation ------------------------------------------------

function alreadySuggested(state) {
  const ids = new Set();
  for (const day of Object.values(state.days)) for (const t of [...day.tracks, ...(day.free || [])]) ids.add(t.id);
  return ids;
}

async function toSuggestion(track, artist, estilo, tipo) {
  const apple = await itunesLink(artist.name, track.title);
  return {
    id: track.id,
    title: track.title,
    artist: artist.name,
    artistId: artist.id,
    album: track.album ? track.album.title : null,
    cover: track.album ? track.album.cover_medium : null,
    duration: track.duration,
    explicit: !!track.explicit_lyrics,
    estilo,
    tipo, // 'pool' | 'descoberta'
    links: buildLinks(artist.name, track.title, track.link, apple),
  };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function generateDay(state, date) {
  if (!state.seeded) await seedPool(state);

  const seen = alreadySuggested(state);
  const tracks = [];

  // Least-recently used approved artists first, so the whole pool rotates.
  const approved = Object.values(state.artists).filter((a) => a.status === 'aprovado');
  const picked = shuffle(approved)
    .sort((a, b) => (a.lastUsed || '').localeCompare(b.lastUsed || ''))
    .slice(0, ARTISTS_PER_DAY);

  for (const artist of picked) {
    try {
      const top = await deezer(`/artist/${artist.id}/top?limit=25`);
      const fresh = (top.data || []).filter((t) => !seen.has(t.id) && t.readable !== false);
      for (const t of shuffle(fresh).slice(0, TRACKS_PER_ARTIST)) {
        tracks.push(await toSuggestion(t, artist, artist.estilo, 'pool'));
        seen.add(t.id);
      }
      artist.lastUsed = date;
    } catch (err) {
      console.error('[musicas] top tracks falhou', artist.name, err.message);
    }
  }

  // Discovery: related artists of a few approved ones become "pendente".
  let newPending = 0;
  for (const source of shuffle(approved).slice(0, DISCOVERY_SOURCES_PER_DAY)) {
    if (newPending >= MAX_NEW_PENDING_PER_DAY) break;
    try {
      const rel = await deezer(`/artist/${source.id}/related?limit=20`);
      for (const a of shuffle(rel.data || [])) {
        if (newPending >= MAX_NEW_PENDING_PER_DAY) break;
        if (!addArtist(state, a, source.estilo, 'pendente', `parecido com ${source.name}`)) continue;
        newPending++;
        const top = await deezer(`/artist/${a.id}/top?limit=5`);
        const t = (top.data || []).find((x) => !seen.has(x.id));
        if (t) {
          tracks.push(await toSuggestion(t, state.artists[a.id], source.estilo, 'descoberta'));
          seen.add(t.id);
        }
      }
    } catch (err) {
      console.error('[musicas] related falhou', source.name, err.message);
    }
  }

  const free = await findFreeDownloads(seen);
  state.days[date] = { generatedAt: new Date().toISOString(), free, tracks };
  return state.days[date];
}

let generating = null;
function generateToday({ force = false } = {}) {
  if (generating) return generating;
  const date = todayBrasilia();
  generating = withState(async (state) => {
    const existing = state.days[date];
    if (existing && !force) {
      // Days generated before the free-download source existed.
      if (!existing.free) existing.free = await findFreeDownloads(alreadySuggested(state));
      return existing;
    }
    console.log(`[musicas] gerando sugestoes de ${date}...`);
    const day = await generateDay(state, date);
    console.log(`[musicas] ${day.free.length} gratis + ${day.tracks.length} sugestoes geradas para ${date}`);
    return day;
  }).finally(() => {
    generating = null;
  });
  return generating;
}

// Checks hourly; generates the day's batch once it's past 6h in Brasilia.
function startMusicScheduler() {
  const tick = () => {
    const state = load();
    const day = state.days[todayBrasilia()];
    if ((!day || !day.free) && hourBrasilia() >= 6) {
      generateToday().catch((err) => console.error('[musicas] geracao falhou:', err.message));
    }
  };
  setTimeout(tick, 10 * 1000);
  setInterval(tick, 60 * 60 * 1000);
}

// ---- actions from the admin page -------------------------------------

function setArtistStatus(artistId, status) {
  return withState((state) => {
    const a = state.artists[artistId];
    if (!a) return null;
    a.status = status;
    return a;
  });
}

function setArtistEstilo(artistId, estilo) {
  return withState((state) => {
    const a = state.artists[artistId];
    if (!a || !ESTILOS.includes(estilo)) return null;
    a.estilo = estilo;
    return a;
  });
}

async function addArtistByName(name, estilo) {
  const a = await findArtistByName(name);
  if (!a) return null;
  return withState((state) => {
    if (state.artists[a.id]) {
      state.artists[a.id].status = 'aprovado';
      if (ESTILOS.includes(estilo)) state.artists[a.id].estilo = estilo;
    } else {
      addArtist(state, a, ESTILOS.includes(estilo) ? estilo : 'Hip hop', 'aprovado', 'adicionado manualmente');
    }
    return state.artists[a.id];
  });
}

// mark: 'playlist' | 'descartada' | null
function setTrackMark(trackId, mark) {
  return withState((state) => {
    if (mark) state.marks[trackId] = mark;
    else delete state.marks[trackId];
    return mark;
  });
}

// Deezer preview URLs are signed and expire, so we resolve a fresh one on play.
async function previewUrl(trackId) {
  const t = await deezer(`/track/${encodeURIComponent(trackId)}`);
  return t.preview || null;
}

module.exports = {
  ESTILOS,
  load,
  todayBrasilia,
  generateToday,
  startMusicScheduler,
  setArtistStatus,
  setArtistEstilo,
  addArtistByName,
  setTrackMark,
  previewUrl,
};
