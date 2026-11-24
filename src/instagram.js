const axios = require('axios');

// Minimal Instagram Graph API client used by /manychat.
// Works with both kinds of token:
//   IGAA...  Instagram Login (graph.instagram.com)  - instagram_business_basic,
//            instagram_business_manage_comments, instagram_business_manage_messages
//   EAA...   Facebook Login / Page token (graph.facebook.com) - instagram_basic,
//            instagram_manage_comments, instagram_manage_messages, pages_messaging
const VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v21.0';

function hostFor(token) {
  if (process.env.INSTAGRAM_GRAPH_HOST) return process.env.INSTAGRAM_GRAPH_HOST.replace(/\/$/, ''); // tests / proxies
  return String(token || '').startsWith('EAA') ? 'https://graph.facebook.com' : 'https://graph.instagram.com';
}

function erroGraph(err) {
  const e = err && err.response && err.response.data && err.response.data.error;
  if (e) return `${e.message || 'erro'}${e.code ? ` (código ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''})` : ''}`;
  return (err && err.message) || 'erro desconhecido';
}

function client(token) {
  const base = `${hostFor(token)}/${VERSION}`;
  const get = async (path, params = {}) => (await axios.get(base + path, { params: { ...params, access_token: token }, timeout: 20000 })).data;
  const post = async (path, body) => (await axios.post(base + path, body, { params: { access_token: token }, timeout: 20000 })).data;

  return {
    host: hostFor(token),

    // { id, username } of the Instagram professional account behind the token.
    async conta() {
      if (!String(token || '').startsWith('EAA')) {
        const me = await get('/me', { fields: 'user_id,username' });
        return { id: String(me.user_id || me.id), username: me.username };
      }
      const pages = await get('/me/accounts', { fields: 'name,access_token,instagram_business_account{id,username}', limit: 50 });
      const pg = (pages.data || []).find((p) => p.instagram_business_account);
      // Messages and replies go out with the page token (user tokens cannot send them).
      if (pg) return { id: pg.instagram_business_account.id, username: pg.instagram_business_account.username, tokenEnvio: pg.access_token };
      // Page token: /me is the page itself.
      const me = await get('/me', { fields: 'instagram_business_account{id,username}' });
      if (me.instagram_business_account) return { id: me.instagram_business_account.id, username: me.instagram_business_account.username };
      throw new Error('O token não tem acesso a nenhuma conta comercial do Instagram.');
    },

    async midias(igId, limit = 5) {
      const r = await get(`/${igId}/media`, { fields: 'id,caption,permalink,timestamp,media_type', limit });
      return r.data || [];
    },

    // Top-level comments of a post (all pages, newest first, up to `max`).
    async comentarios(mediaId, max = 500) {
      const out = [];
      let r = await get(`/${mediaId}/comments`, { fields: 'id,text,timestamp,username,from{id,username},replies{username}', limit: 50 });
      while (r) {
        out.push(...(r.data || []));
        const next = r.paging && r.paging.next;
        if (!next || out.length >= max) break;
        r = (await axios.get(next, { timeout: 20000 })).data;
      }
      return out.slice(0, max);
    },

    responderComentario: (commentId, message) => post(`/${commentId}/replies`, { message }),
    enviarMensagem: (body) => post('/me/messages', body),
  };
}

module.exports = { client, erroGraph, hostFor };
