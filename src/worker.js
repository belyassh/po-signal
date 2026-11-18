/*
 * PO Signal на Cloudflare Workers.
 *   - статика (интерфейс) отдаётся из ./public без участия кода
 *   - /api/* — проверка пароля и пересылка в Durable Object PoFeed
 *   - cron раз в минуту будит Durable Object после деплоя/перезапуска
 */
export { PoFeed } from './feed-do.js';

const COOKIE = 'pos_session';
const VERSION = '3.0-cf';

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...extra },
  });
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function getCookie(req, name) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

const feedStub = env => env.FEED.get(env.FEED.idFromName('main'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') return new Response('ok');
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    const password = env.APP_PASSWORD || '';
    const authEnabled = !!password;
    const token = authEnabled ? await hmacHex(password, 'po-signal-session-v1') : '';
    const authed = !authEnabled || safeEqual(getCookie(request, COOKIE), token);
    const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

    if (path === '/api/login' && request.method === 'POST') {
      if (!authEnabled) return json({ ok: true });
      const body = await request.json().catch(() => ({}));
      if (safeEqual(body.password || '', password)) {
        return json({ ok: true }, 200, { 'Set-Cookie': cookie(token, 60 * 60 * 24 * 60) });
      }
      await new Promise(r => setTimeout(r, 1000));   // притормаживаем подбор пароля
      return json({ ok: false, error: 'Неверный пароль' }, 403);
    }
    if (path === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });

    if (path === '/api/config') {
      let info = { demo: false, has_ssid: false, account: '' };
      if (authed) {
        try { info = await (await feedStub(env).fetch('https://feed/info')).json(); } catch {}
      }
      return json({ version: VERSION, auth: authEnabled, authed, ...info,
        can_set_ssid: authEnabled && !info.demo });
    }

    if (!authed) return json({ error: 'auth' }, 401);
    if (path === '/api/ssid' && !authEnabled) {
      return json({ ok: false, error: 'Смена SSID через интерфейс доступна только при заданном APP_PASSWORD' }, 403);
    }

    const routes = { '/api/state': 'GET', '/api/history': 'GET', '/api/assets': 'GET', '/api/asset': 'POST', '/api/ssid': 'POST' };
    if (routes[path] !== request.method) return json({ error: 'not found' }, 404);

    const inner = new Request('https://feed' + path.slice(4) + url.search, {
      method: request.method,
      headers: { 'Content-Type': 'application/json' },
      body: request.method === 'POST' ? await request.text() : undefined,
    });
    const resp = await feedStub(env).fetch(inner);
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);
    return out;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(feedStub(env).fetch('https://feed/kick'));
  },
};
