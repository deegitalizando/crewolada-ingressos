// Buttons of the public "link in bio" page (/links), editable in /admin/links.
// Until the admin saves a list, the defaults below are shown (same buttons the
// page always had). db.linkButtons is the saved list, in display order.
//
// Button fields:
//   id         stable key
//   tipo       'link' (opens url) | 'ingressos' (opens the ticket chooser)
//   estilo     'normal' | 'principal' (gold, big) | 'destaque' (rainbow border)
//   icone      one of ICONES
//   rotulo     small line above the title ("Assista")
//   selo       optional tag next to the rotulo ("Novo")
//   titulo     main text
//   descricao  optional line below the title
//   url        https://..., /path, mailto: or tel:
//   novaAba    open in a new tab
//   visivel    false hides it without deleting
//   destino    (Ingressos button only) 'auto' = list of events on sale,
//              'evento' = straight to eventoId's page, 'link' = straight to url
const store = require('./store');

const ICONES = {
  ingresso: 'Ingresso',
  whatsapp: 'WhatsApp',
  youtube: 'YouTube / vídeo',
  playlist: 'Playlist',
  musica: 'Música (equalizador animado)',
  microfone: 'Microfone',
  livro: 'Livro / história',
  instagram: 'Instagram',
  link: 'Link',
};
const ESTILOS = { normal: 'Normal', principal: 'Principal (dourado)', destaque: 'Destaque (borda colorida)' };

function defaults(communityUrl) {
  return [
    { id: 'ingressos', tipo: 'ingressos', destino: 'auto', eventoId: '', estilo: 'principal', icone: 'ingresso', rotulo: 'Garanta o seu', selo: '', titulo: 'Ingressos', descricao: '', url: '', novaAba: false, visivel: true },
    { id: 'criesuamusica', tipo: 'link', estilo: 'destaque', icone: 'musica', rotulo: 'Novidade', selo: 'Novo', titulo: 'Crie Sua Própria Música com Nossa IA', descricao: 'Letra, voz e batida feitas pra você em 1 minuto.', url: '/criesuamusica', novaAba: false, visivel: true },
    { id: 'comunidade', tipo: 'link', estilo: 'normal', icone: 'whatsapp', rotulo: 'Comunidade no WhatsApp', selo: '', titulo: 'Entre na nossa comunidade', descricao: 'Fique por dentro de tudo em primeira mão.', url: communityUrl || '/', novaAba: true, visivel: true },
    { id: 'youtube', tipo: 'link', estilo: 'normal', icone: 'youtube', rotulo: 'Assista', selo: '', titulo: 'Nosso canal do YouTube', descricao: '', url: '/youtube', novaAba: false, visivel: true },
    { id: 'contato', tipo: 'link', estilo: 'normal', icone: 'microfone', rotulo: 'Convide', selo: '', titulo: 'Leve a Crewolada para seu evento', descricao: '', url: '/contato', novaAba: false, visivel: true },
    { id: 'playlist', tipo: 'link', estilo: 'normal', icone: 'playlist', rotulo: 'Ouça', selo: '', titulo: 'Playlist', descricao: '', url: '/playlist', novaAba: false, visivel: true },
    { id: 'sobre', tipo: 'link', estilo: 'normal', icone: 'livro', rotulo: 'Conheça', selo: '', titulo: 'Nossa história', descricao: '', url: '/sobre', novaAba: false, visivel: true },
  ];
}

// Accepts full https/http links, site paths (/contato), mailto: and tel:. Never javascript: etc.
function isValidUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) || /^\/(?!\/)[^\s]*$/.test(s) || /^(mailto|tel):[^\s]+$/i.test(s);
}

const txt = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

// Cleans a list coming from the admin form. Returns { botoes } or { error }.
function sanitize(list) {
  if (!Array.isArray(list)) return { error: 'Lista de botões inválida.' };
  const ids = new Set();
  const botoes = [];
  let temIngressos = false;
  for (const raw of list.slice(0, 30)) {
    if (!raw || typeof raw !== 'object') continue;
    const tipo = raw.tipo === 'ingressos' && !temIngressos ? 'ingressos' : 'link';
    if (tipo === 'ingressos') temIngressos = true;
    const titulo = txt(raw.titulo, 80);
    if (!titulo) return { error: 'Todo botão precisa de um título.' };
    const destino = tipo === 'ingressos' && ['evento', 'link'].includes(raw.destino) ? raw.destino : 'auto';
    const eventoId = tipo === 'ingressos' && destino === 'evento' ? txt(raw.eventoId, 80) : '';
    if (destino === 'evento' && !eventoId) return { error: 'Escolha o evento para onde o botão Ingressos deve levar.' };
    const url = tipo === 'ingressos' && destino !== 'link' ? '' : txt(raw.url, 500);
    if (url !== '' || tipo === 'link') {
      if (!isValidUrl(url)) return { error: `O link do botão "${titulo}" é inválido. Use https://... ou um caminho do site como /contato.` };
    }
    let id = txt(raw.id, 40).replace(/[^a-z0-9-]/gi, '') || `botao-${botoes.length + 1}`;
    for (let i = 2; ids.has(id); i += 1) id = `${id}-${i}`;
    ids.add(id);
    botoes.push({
      id,
      tipo,
      ...(tipo === 'ingressos' ? { destino, eventoId } : {}),
      estilo: ESTILOS[raw.estilo] ? raw.estilo : 'normal',
      icone: ICONES[raw.icone] ? raw.icone : 'link',
      rotulo: txt(raw.rotulo, 40),
      selo: txt(raw.selo, 12),
      titulo,
      descricao: txt(raw.descricao, 120),
      url,
      novaAba: Boolean(raw.novaAba),
      visivel: raw.visivel !== false,
    });
  }
  if (!botoes.length) return { error: 'Deixe pelo menos um botão (você pode ocultá-lo em vez de excluir).' };
  return { botoes };
}

function getButtons(db, communityUrl) {
  const saved = (db || store.load()).linkButtons;
  if (Array.isArray(saved) && saved.length) return saved;
  return defaults(communityUrl);
}

module.exports = { ICONES, ESTILOS, defaults, getButtons, sanitize, isValidUrl };
