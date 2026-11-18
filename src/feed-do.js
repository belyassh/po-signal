/*
 * Durable Object: один на всё приложение. Держит соединение с Pocket Option,
 * хранит котировки в памяти и раз в минуту сохраняет их в SQLite,
 * чтобы история пережила перезапуски и деплои.
 */
import { PocketOptionFeed, DemoFeed, parseSsid } from './core.js';
import fallbackCatalog from './assets_fallback.json';

const KEEP_HOURS = 6;          // сколько истории храним в SQLite
const RESTORE_HOURS = 2;       // сколько поднимаем в память при старте
const ALARM_EVERY = 30_000;

async function openSocket(url, headers) {
  const resp = await fetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket', ...headers } });
  const ws = resp.webSocket;
  if (!ws) throw new Error('HTTP ' + resp.status);
  ws.accept();
  return ws;
}

async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

export class PoFeed {
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.demo = env.DEMO === '1' || env.DEMO === 'true';
    this.idleMs = (parseFloat(env.IDLE_MINUTES || '0') || 0) * 60_000;
    this.lastClient = Date.now();
    const common = { fallbackCatalog };
    this.feed = this.demo
      ? new DemoFeed(common)
      : new PocketOptionFeed({ ...common, openSocket: deps.openSocket || openSocket, period: parseInt(env.PERIOD || '60', 10) || 60 });
    this.savedUpTo = 0;   // последняя сохранённая минута для текущей пары
    this.timer = null;
    state.blockConcurrencyWhile(() => this.init());
  }

  // ------------------------------------------------------------------ setup
  async init() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS ticks_min (asset TEXT, minute INTEGER, data TEXT, PRIMARY KEY (asset, minute))');
    const asset = this.kvGet('asset') || this.env.ASSET || 'SOL-USD_otc';
    this.loadAsset(asset, false);
    if (!this.demo) {
      const ssid = await this.pickSsid();
      if (ssid) {
        try { this.feed.setSsid(ssid); } catch (e) { this.feed.setStatus('error', 'Ошибка SSID: ' + e.message); }
      }
    }
    this.startFeed();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + ALARM_EVERY);
  }

  /** SSID из интерфейса действует, пока секрет SSID на Cloudflare не поменяли. */
  async pickSsid() {
    const envSsid = (this.env.SSID || '').trim();
    const saved = this.kvGet('ssid');
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (s.ssid && s.env_hash === await sha256(envSsid)) return s.ssid;
      } catch {}
    }
    return envSsid;
  }

  startFeed() {
    if (this.feed.running) return;
    this.feed.start();
    if (!this.timer) this.timer = setInterval(() => this.feed.tick(), this.demo ? 700 : 1500);
  }

  stopFeed(text) {
    this.checkpoint();
    this.feed.stop(text);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  kvGet(k) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  kvSet(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v); }

  // ------------------------------------------------------------------ история
  loadAsset(asset, live = true) {
    const fromMin = Math.floor(Date.now() / 60_000) - RESTORE_HOURS * 60;
    const rows = this.sql.exec('SELECT minute, data FROM ticks_min WHERE asset = ? AND minute >= ? ORDER BY minute', asset, fromMin).toArray();
    const ticks = [];
    for (const r of rows) for (const t of JSON.parse(r.data)) ticks.push(t);
    this.savedUpTo = rows.length ? rows[rows.length - 1].minute : 0;
    if (live) this.feed.setAsset(asset, ticks);
    else this.feed.resetAsset(asset, ticks);
  }

  /** Сохраняет завершённые минуты текущей пары: одна строка на минуту. */
  checkpoint() {
    if (this.demo) return;
    const ticks = this.feed.ticks;
    if (!ticks.length) return;
    const curMin = Math.floor(Date.now() / 60_000);
    const groups = new Map();
    for (let i = ticks.length - 1; i >= 0; i--) {
      const m = Math.floor(ticks[i][0] / 60);
      if (m <= this.savedUpTo) break;
      if (m >= curMin) continue;
      if (!groups.has(m)) groups.set(m, []);
      groups.get(m).push(ticks[i]);
    }
    const mins = [...groups.keys()].sort((a, b) => a - b);
    for (const m of mins) {
      this.sql.exec('INSERT OR REPLACE INTO ticks_min (asset, minute, data) VALUES (?, ?, ?)',
        this.feed.asset, m, JSON.stringify(groups.get(m).reverse()));
    }
    if (mins.length) this.savedUpTo = mins[mins.length - 1];
    this.sql.exec('DELETE FROM ticks_min WHERE minute < ?', curMin - KEEP_HOURS * 60);
  }

  /** Вся сохранённая история пары + свежие тики из памяти. Строки из БД склеиваются без разбора (экономим CPU). */
  historyBody() {
    const fromMin = Math.floor(Date.now() / 60_000) - KEEP_HOURS * 60;
    const rows = this.sql.exec('SELECT data FROM ticks_min WHERE asset = ? AND minute >= ? AND minute <= ? ORDER BY minute',
      this.feed.asset, fromMin, this.savedUpTo).toArray();
    const tail = this.feed.ticks.filter(t => Math.floor(t[0] / 60) > this.savedUpTo);
    const parts = rows.map(r => r.data);
    parts.push(JSON.stringify(tail));
    return '{"asset":' + JSON.stringify(this.feed.asset) + ',"chunks":[' + parts.join(',') + ']}';
  }

  // ------------------------------------------------------------------ запросы
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/kick') {                      // cron: не считается заходом пользователя
      if (!this.idleMs) this.startFeed();
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + ALARM_EVERY);
      return json({ ok: true });
    }
    this.lastClient = Date.now();
    if (!this.feed.running) {
      this.startFeed();
      if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + ALARM_EVERY);
    }
    const f = this.feed;

    if (path === '/info') {
      return json({ demo: this.demo, has_ssid: !!f.hasSsid, account: f.account });
    }
    if (path === '/state') {
      const since = parseFloat(url.searchParams.get('since') || '0') || 0;
      const info = f.assetInfo() || {};
      return json({
        asset: f.asset, asset_name: info.name || f.asset, asset_type: info.type || '',
        status: f.status, status_text: f.statusText, source: f.source, demo: this.demo,
        payout: f.payout, version: f.version, catalog_version: f.catalogVersion,
        ticks: f.since(since),
      });
    }
    if (path === '/history') {
      return new Response(this.historyBody(), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (path === '/assets') {
      return json({ source: f.catalogSource, assets: Object.values(f.catalog) });
    }
    if (request.method === 'POST' && path === '/asset') {
      const body = await request.json().catch(() => ({}));
      const asset = String(body.asset || '').trim();
      if (!asset || asset.length > 40 || !/^[A-Za-z0-9_\-#.]+$/.test(asset)) return json({ ok: false, error: 'Некорректное название актива' }, 400);
      this.checkpoint();
      this.loadAsset(asset, true);
      this.kvSet('asset', asset);
      return json({ ok: true, asset });
    }
    if (request.method === 'POST' && path === '/ssid') {
      if (this.demo) return json({ ok: false, error: 'В режиме симуляции SSID не нужен' }, 400);
      const body = await request.json().catch(() => ({}));
      let ssid;
      try { parseSsid(body.ssid); ssid = String(body.ssid).trim(); }
      catch (e) { return json({ ok: false, error: e.message }, 400); }
      f.setSsid(ssid);
      this.kvSet('ssid', JSON.stringify({ ssid, env_hash: await sha256((this.env.SSID || '').trim()), saved_at: Date.now() }));
      f.reconnect();
      return json({ ok: true, saved: true, account: f.account });
    }
    return json({ error: 'not found' }, 404);
  }

  async alarm() {
    if (this.idleMs && Date.now() - this.lastClient > this.idleMs) {
      if (this.feed.running) this.stopFeed('Пауза: приложение давно не открывали');
      return;                                    // без нового будильника — объект сможет уснуть
    }
    this.startFeed();
    this.feed.tick();
    try { this.checkpoint(); } catch (e) { console.log('checkpoint', e); }
    await this.state.storage.setAlarm(Date.now() + ALARM_EVERY);
  }
}
