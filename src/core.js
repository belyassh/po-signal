/*
 * Ядро: подключение к Pocket Option (протокол socket.io поверх WebSocket),
 * разбор котировок и списка пар, буфер тиков. Не зависит от Cloudflare —
 * сокет передаётся снаружи (openSocket), поэтому код можно тестировать где угодно.
 *
 * Протокол повторяет библиотеку PocketOptionAPI (pocketoptionapi_async):
 *   сервер "0{sid}" → мы "40" → сервер "40{sid}" → мы 42["auth",{...}]
 *   → сервер 451-["successauth",...] → мы 42["changeSymbol",{asset,period}]
 *   → поток бинарных кадров [["SOL-USD_otc", 1731912345.12, 85.0135]]
 */

export const REGIONS_DEMO = [
  'wss://demo-api-eu.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://try-demo-eu.po.market/socket.io/?EIO=4&transport=websocket',
];
export const REGIONS_REAL = [
  'wss://api-eu.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-fr.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-l.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-asia.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-sc.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-hk.po.market/socket.io/?EIO=4&transport=websocket',
  'wss://api-us-north.po.market/socket.io/?EIO=4&transport=websocket',
];
export const WS_HEADERS = {
  Origin: 'https://pocketoption.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const MAX_TICKS = 100_000;
const NO_DATA_RESUBSCRIBE = 12_000;
const NO_DATA_RECONNECT = 45_000;
const HANDSHAKE_TIMEOUT = 15_000;
const PING_EVERY = 20_000;

export const SSID_HELP = 'SSID должен выглядеть так: 42["auth",{"session":"...","isDemo":1,"uid":12345,"platform":1}] — '
  + 'скопируй его целиком из DevTools на компьютере (F12 → Network → WS)';

export const normAsset = a => String(a || '').trim().replace(/^#/, '').toLowerCase();
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const toTs = x => (x > 1e11 ? x / 1000 : x);

export function parseSsid(s) {
  s = String(s || '').trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error(SSID_HELP);
  let d;
  try { d = JSON.parse(s.slice(i, j + 1)); } catch { throw new Error(SSID_HELP); }
  if (!d || typeof d !== 'object' || !d.session) throw new Error('В SSID нет поля session. ' + SSID_HELP);
  return d;
}

/** Тики из любых известных форматов → [[asset, ts, price], ...] */
export function extractTicks(obj, depth = 0) {
  const out = [];
  if (depth > 4 || obj == null) return out;
  if (Array.isArray(obj)) {
    if (obj.length >= 3 && typeof obj[0] === 'string' && isNum(obj[1]) && isNum(obj[2])) {
      out.push([obj[0], toTs(obj[1]), obj[2]]);
    } else {
      for (const it of obj) if (it && typeof it === 'object') out.push(...extractTicks(it, depth + 1));
    }
  } else if (typeof obj === 'object') {
    const asset = obj.asset || obj.symbol || '';
    if (Array.isArray(obj.history) && asset) {
      for (const h of obj.history) if (Array.isArray(h) && h.length >= 2 && isNum(h[0]) && isNum(h[1])) out.push([asset, toTs(h[0]), h[1]]);
    }
    if (!out.length && Array.isArray(obj.candles) && asset && isNum(obj.period) && obj.period <= 5) {
      for (const c of obj.candles) if (Array.isArray(c) && c.length >= 3 && isNum(c[0]) && isNum(c[2])) out.push([asset, toTs(c[0]), c[2]]);
    }
    if (Array.isArray(obj.data)) out.push(...extractTicks(obj.data, depth + 1));
  }
  return out;
}

/** Список пар с выплатами: [[id, "#AAPL", "Apple", "stock", ?, payout, ..., is_otc(9), ..., active(14)], ...] */
export function parseAssetList(obj) {
  if (!Array.isArray(obj) || obj.length < 5) return null;
  const out = {};
  let n = 0;
  for (const a of obj) {
    if (!(Array.isArray(a) && a.length >= 15 && typeof a[1] === 'string' && typeof a[2] === 'string'
      && typeof a[3] === 'string' && isNum(a[5]))) continue;
    out[a[1]] = { symbol: a[1], name: a[2], type: a[3], payout: a[5], otc: !!a[9], active: !!a[14] };
    n++;
  }
  return n >= 5 ? out : null;
}

function decode(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}

// =========================================================================
// Буфер котировок + каталог пар (общая часть для живого потока и симуляции)
// =========================================================================
class BaseFeed {
  constructor({ fallbackCatalog = [], now = () => Date.now() } = {}) {
    this.now = now;
    this.asset = 'SOL-USD_otc';
    this.ticks = [];
    this.version = 0;
    this.status = 'starting';
    this.statusText = 'Запуск…';
    this.source = '';
    this.account = '';
    this.lastTickWall = 0;
    this.catalog = {};
    this.catalogSource = 'none';
    this.catalogVersion = 0;
    if (fallbackCatalog.length) {
      const c = {};
      for (const a of fallbackCatalog) c[a.symbol] = a;
      this.setCatalog(c, 'fallback');
    }
  }

  setStatus(status, text) { this.status = status; this.statusText = text; }

  setCatalog(cat, source) {
    if (!cat || !Object.keys(cat).length) return;
    this.catalog = cat; this.catalogSource = source; this.catalogVersion++;
  }

  assetInfo(asset = this.asset) {
    const k = normAsset(asset);
    for (const [sym, info] of Object.entries(this.catalog)) if (normAsset(sym) === k) return info;
    return null;
  }

  get payout() {
    const i = this.assetInfo();
    return i && isNum(i.payout) && i.payout > 0 ? i.payout / 100 : null;
  }

  /** Сменить пару; restored — сохранённая ранее история этой пары (может быть пустой). */
  resetAsset(asset, restored = []) {
    this.asset = asset;
    this.ticks = restored.slice(-MAX_TICKS);
    this.version++;
    this.lastTickWall = 0;
  }

  addTicks(asset, batch) {
    if (!batch.length || normAsset(asset) !== normAsset(this.asset)) return 0;
    batch.sort((a, b) => a[0] - b[0]);
    const lastTs = this.ticks.length ? this.ticks[this.ticks.length - 1][0] : -1;
    let added;
    if (batch[0][0] > lastTs) {
      for (const t of batch) this.ticks.push([Math.round(t[0] * 1000) / 1000, t[1]]);
      added = batch.length;
    } else {
      const m = new Map(this.ticks.map(t => [Math.round(t[0] * 1000), t[1]]));
      const before = m.size;
      for (const [t, p] of batch) { const k = Math.round(t * 1000); if (!m.has(k)) m.set(k, p); }
      this.ticks = [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, p]) => [k / 1000, p]);
      added = m.size - before;
      if (added) this.version++;
    }
    if (this.ticks.length > MAX_TICKS * 1.1) this.ticks = this.ticks.slice(-MAX_TICKS);
    if (added) this.lastTickWall = this.now();
    return added;
  }

  /** Тики новее ts; при ts<=0 — последние 35 минут. */
  since(ts) {
    const t = this.ticks;
    if (!t.length) return [];
    if (!(ts > 0)) ts = t[t.length - 1][0] - 35 * 60;
    let lo = 0, hi = t.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t[m][0] <= ts) lo = m + 1; else hi = m; }
    return t.slice(lo);
  }
}

// =========================================================================
// Живой поток Pocket Option
// =========================================================================
export class PocketOptionFeed extends BaseFeed {
  /**
   * openSocket(url, headers) → Promise<WebSocket-подобный объект>
   *   (send, close, addEventListener('message'|'close'|'error'))
   */
  constructor({ openSocket, period = 60, ...rest }) {
    super(rest);
    this.openSocket = openSocket;
    this.period = period;
    this.ssid = null;           // разобранный JSON
    this.ws = null;
    this.phase = 'idle';        // idle | connecting | handshake | authed
    this.phaseAt = 0;
    this.subscribedAt = 0;
    this.subscribedAsset = null;
    this.resubs = 0;
    this.lastPing = 0;
    this.nextTryAt = 0;
    this.failures = 0;
    this.regionIdx = 0;
    this.running = false;
    this.source = 'Pocket Option · нет SSID';
  }

  setSsid(raw) {
    const d = parseSsid(raw);
    this.ssid = d;
    this.account = d.isDemo === 0 || d.isDemo === false ? 'real' : 'demo';
    this.source = 'Pocket Option · ' + (this.account === 'demo' ? 'демо-счёт' : 'реальный счёт');
    return '42["auth",' + JSON.stringify(d) + ']';
  }

  get hasSsid() { return !!this.ssid; }

  start() { this.running = true; this.nextTryAt = 0; this.tick(); }
  stop(text = 'Остановлено') { this.running = false; this.closeSocket(); this.setStatus('idle', text); }

  reconnect() { this.closeSocket(); this.failures = 0; this.nextTryAt = 0; this.tick(); }

  setAsset(asset, restored = []) {
    this.resetAsset(asset, restored);
    if (this.phase === 'authed') this.subscribe();
  }

  closeSocket() {
    const ws = this.ws;
    this.ws = null; this.phase = 'idle'; this.subscribedAsset = null;
    if (ws) try { ws.close(1000, 'bye'); } catch {}
  }

  fail(text, delay) {
    this.closeSocket();
    this.failures++;
    const d = delay ?? Math.min(3000 * 2 ** (this.failures - 1), 60_000);
    this.nextTryAt = this.now() + d;
    this.setStatus('error', `${text}. Повтор через ${Math.round(d / 1000)} с…`);
  }

  /** Вызывать регулярно (раз в 1–2 с): переподключения, пинги, контроль тишины. */
  tick() {
    if (!this.running) return;
    const now = this.now();
    if (!this.ssid) { this.setStatus('no_ssid', 'Нужен SSID — открой ⚙ Настройки'); return; }
    if (this.phase === 'idle') {
      if (now >= this.nextTryAt) this.connect();
      return;
    }
    if (this.phase === 'connecting') return;
    if (this.phase === 'handshake') {
      if (now - this.phaseAt > HANDSHAKE_TIMEOUT) { this.regionIdx++; this.fail('Сервер Pocket Option не ответил'); }
      return;
    }
    // authed
    if (now - this.lastPing > PING_EVERY) { this.send('42["ps"]'); this.lastPing = now; }
    if (this.subscribedAsset !== this.asset) { this.subscribe(); return; }
    const silent = now - Math.max(this.lastTickWall, this.subscribedAt);
    if (this.lastTickWall && now - this.lastTickWall < 5000) this.setStatus('live', 'Онлайн');
    if (silent > NO_DATA_RECONNECT) {
      this.fail(`Нет котировок ${this.asset} уже ${Math.round(silent / 1000)} с (пара закрыта или неверное название)`);
    } else if (silent > NO_DATA_RESUBSCRIBE * (this.resubs + 1)) {
      this.resubs++;
      this.subscribe(true);
      this.setStatus('waiting', `Нет данных по ${this.asset}, повторная подписка…`);
    }
  }

  async connect() {
    this.phase = 'connecting'; this.phaseAt = this.now();
    this.setStatus('connecting', 'Подключение к Pocket Option…');
    const list = this.account === 'real' ? REGIONS_REAL : REGIONS_DEMO;
    let lastErr = null;
    for (let k = 0; k < list.length; k++) {
      const url = list[(this.regionIdx + k) % list.length];
      try {
        const ws = await this.openSocket(url, WS_HEADERS);
        if (this.phase !== 'connecting') { try { ws.close(); } catch {} return; }  // успели отменить
        this.regionIdx = (this.regionIdx + k) % list.length;
        this.attach(ws);
        return;
      } catch (e) { lastErr = e; }
    }
    this.phase = 'idle';
    this.fail('Не удалось открыть соединение' + (lastErr ? ` (${lastErr.message || lastErr})` : ''));
  }

  attach(ws) {
    this.ws = ws; this.phase = 'handshake'; this.phaseAt = this.now();
    ws.addEventListener('message', ev => { if (this.ws === ws) this.onMessage(ev.data); });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null; this.phase = 'idle';
      this.fail('Соединение закрыто');
    });
    ws.addEventListener('error', () => {
      if (this.ws !== ws) return;
      this.fail('Ошибка соединения');
    });
  }

  send(s) { try { this.ws && this.ws.send(s); } catch {} }

  authMessage() {
    const d = { session: this.ssid.session, isDemo: this.account === 'demo' ? 1 : 0,
      uid: this.ssid.uid || 0, platform: this.ssid.platform || 1, isFastHistory: true };
    return '42["auth",' + JSON.stringify(d) + ']';
  }

  onMessage(data) {
    const binary = typeof data !== 'string';
    const m = decode(data);
    if (binary) { this.onData(safeJson(m)); return; }
    if (m === '2') { this.send('3'); return; }
    if (m[0] === '0' && m.includes('sid')) { this.send('40'); return; }
    if (m.startsWith('40')) { this.send(this.authMessage()); return; }
    if (m.startsWith('42') && m.includes('NotAuthorized')) {
      this.fail('Pocket Option отклонил SSID — он устарел, вставь новый', 5 * 60_000);
      return;
    }
    if (m.startsWith('451-') || m.startsWith('42')) {
      const arr = safeJson(m.startsWith('451-') ? m.slice(m.indexOf('-') + 1) : m.slice(2));
      if (!Array.isArray(arr)) return;
      if (arr[0] === 'successauth') { this.onAuthed(); return; }
      const payload = arr[1];
      if (payload && !(typeof payload === 'object' && payload._placeholder)) this.onData(payload);
    }
  }

  onAuthed() {
    this.phase = 'authed'; this.failures = 0; this.lastPing = this.now();
    this.setStatus('waiting', 'Авторизовано, подписываюсь…');
    this.subscribe();
  }

  subscribe(extra = false) {
    if (this.subscribedAsset && this.subscribedAsset !== this.asset) this.send('42["unsubfor",' + JSON.stringify(this.subscribedAsset) + ']');
    this.send('42["changeSymbol",' + JSON.stringify({ asset: this.asset, period: this.period }) + ']');
    if (extra) this.send('42["subfor",' + JSON.stringify(this.asset) + ']');
    if (this.subscribedAsset !== this.asset) { this.resubs = 0; this.subscribedAt = this.now(); }
    if (!extra) this.setStatus('waiting', `Подписка на ${this.asset}, ждём котировки…`);
    this.subscribedAsset = this.asset;
  }

  onData(obj) {
    if (obj == null) return;
    const cat = parseAssetList(obj);
    if (cat) { this.setCatalog(cat, 'live'); return; }
    const ticks = extractTicks(obj);
    if (!ticks.length) return;
    const by = new Map();
    for (const [a, t, p] of ticks) { if (!by.has(a)) by.set(a, []); by.get(a).push([t, p]); }
    for (const [a, b] of by) this.addTicks(a, b);
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

// =========================================================================
// Симуляция (DEMO=1) — посмотреть интерфейс без Pocket Option
// =========================================================================
export class DemoFeed extends BaseFeed {
  constructor(opts = {}) {
    super(opts);
    this.source = 'СИМУЛЯЦИЯ — не реальные котировки';
    this.setCatalog(this.catalog, 'demo');
    this.running = false;
    this.hasSsid = false;
  }
  setSsid() { throw new Error('В режиме симуляции SSID не нужен'); }
  start() { this.running = true; if (!this.ticks.length) this.seed(); this.setStatus('live', 'Онлайн · симуляция'); }
  stop() { this.running = false; }
  reconnect() {}
  setAsset(asset) { this.resetAsset(asset, []); this.seed(); }
  seed() {
    const a = this.asset.toLowerCase();
    let h = 0; for (const ch of a) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    this.base = a.includes('sol') ? 85.013 : a.includes('btc') ? 65000 : 0.5 + (h % 20000) / 100;
    this.dec = this.base < 1000 ? 5 : 2;
    this.vol = this.base * 1.8e-7 * (this.dec === 5 ? 1 : 30);
    this.p = this.base;
    const now = this.now() / 1000;
    const hist = [];
    for (let t = now - 90 * 60; t < now; t += 0.4 + Math.random() * 0.7) hist.push([t, this.step()]);
    this.addTicks(this.asset, hist);
    this.lastStep = now;
  }
  step() {
    const g = Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
    this.p += g * this.vol - (this.p - this.base) * 0.002;
    return Number(this.p.toFixed(this.dec));
  }
  tick() {
    if (!this.running) return;
    const now = this.now() / 1000;
    const batch = [];
    while (this.lastStep + 0.7 < now) { this.lastStep += 0.4 + Math.random() * 0.7; batch.push([Math.min(this.lastStep, now), this.step()]); }
    if (batch.length) this.addTicks(this.asset, batch);
  }
}
