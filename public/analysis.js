/*
 * Простой анализ посекундного графика: четыре классических индикатора голосуют
 * за ЛОНГ (вверх) или ШОРТ (вниз). Работает прямо в браузере.
 *
 * Это учебный алгоритм: он описывает, что цена делала последние ~2 минуты,
 * и не знает будущего. Насколько это помогает угадывать, показывает backtest().
 */
(function (root) {
  'use strict';
  const WINDOW_SEC = 120;
  const MIN_DATA_SEC = 60;
  const NEUTRAL_THRESHOLD = 0.2;
  const GAP_SEC = 20;            // разрыв в данных длиннее — история режется на куски
  const WEIGHTS = { trend: 1.0, momentum: 1.0, rsi: 0.7, bollinger: 0.7 };

  const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
  const fmt = x => (x >= 0 ? '+' : '') + x.toFixed(1);

  // ---- подготовка: цена закрытия каждой секунды [start, end] ----
  function resample1s(ticks, start, end) {
    const out = [];
    if (!ticks.length) return out;
    let lo = 0, hi = ticks.length;               // последний тик с t <= start
    while (lo < hi) { const m = (lo + hi) >> 1; if (ticks[m][0] <= start) lo = m + 1; else hi = m; }
    let idx = lo - 1;
    let last = idx >= 0 ? ticks[idx][1] : ticks[0][1];
    let i = Math.max(idx + 1, 0);
    for (let sec = start; sec <= end; sec++) {
      while (i < ticks.length && ticks[i][0] < sec + 1) { last = ticks[i][1]; i++; }
      out.push(last);
    }
    return out;
  }

  function ema(v, period) {
    const k = 2 / (period + 1);
    let e = v[0];
    for (let i = 1; i < v.length; i++) e = v[i] * k + e * (1 - k);
    return e;
  }
  function rsi(v, period = 14) {
    const d = [];
    for (let i = 1; i < v.length; i++) d.push(v[i] - v[i - 1]);
    if (d.length < period) return 50;
    let g = 0, l = 0;
    for (let i = 0; i < period; i++) { g += Math.max(d[i], 0); l += Math.max(-d[i], 0); }
    let ag = g / period, al = l / period;
    for (let i = period; i < d.length; i++) {
      ag = (ag * (period - 1) + Math.max(d[i], 0)) / period;
      al = (al * (period - 1) + Math.max(-d[i], 0)) / period;
    }
    if (al === 0 && ag === 0) return 50;
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
  }
  function stdev(v) {
    const n = v.length;
    if (n < 2) return 0;
    let m = 0; for (const x of v) m += x; m /= n;
    let s = 0; for (const x of v) s += (x - m) * (x - m);
    return Math.sqrt(s / (n - 1));
  }

  // ---- сигнал по ряду посекундных цен (последний элемент — «сейчас») ----
  function analyzeCloses(c) {
    const diffs = [];
    for (let i = 1; i < c.length; i++) diffs.push(c[i] - c[i - 1]);
    const sigma = stdev(diffs);
    if (!(sigma > 0)) {
      return { signal: 'NEUTRAL', score: 0, indicators: [
        { key: 'flat', name: 'Волатильность', value: '0', vote: 0, text: 'Цена не двигается — анализировать нечего' }] };
    }
    const inds = [];

    const d = (ema(c, 5) - ema(c, 20)) / sigma;
    inds.push({ key: 'trend', name: 'Тренд EMA5/EMA20', value: fmt(d) + 'σ', vote: clamp(d / 2),
      text: d > 0 ? 'EMA5 выше EMA20 — короткий тренд вверх' : d < 0 ? 'EMA5 ниже EMA20 — короткий тренд вниз' : 'EMA совпадают' });

    const look = Math.min(30, c.length - 1);
    const z = (c[c.length - 1] - c[c.length - 1 - look]) / (sigma * Math.sqrt(look));
    inds.push({ key: 'momentum', name: `Импульс за ${look}с`, value: fmt(z) + 'σ', vote: clamp(z / 1.5),
      text: z > 1 ? 'Цена заметно выросла' : z < -1 ? 'Цена заметно упала' : 'Движение в пределах шума' });

    const r = rsi(c, 14);
    let v, t;
    if (r <= 30) { v = clamp((30 - r) / 20, 0, 1); t = 'RSI ниже 30 — перепроданность, ждём отскок вверх'; }
    else if (r >= 70) { v = -clamp((r - 70) / 20, 0, 1); t = 'RSI выше 70 — перекупленность, ждём откат вниз'; }
    else { v = 0; t = 'RSI в нейтральной зоне 30–70'; }
    inds.push({ key: 'rsi', name: 'RSI(14)', value: r.toFixed(0), vote: v, text: t });

    const last20 = c.slice(-20);
    const mid = last20.reduce((a, b) => a + b, 0) / last20.length;
    const sd = stdev(last20);
    const pos = sd > 0 ? (c[c.length - 1] - mid) / (2 * sd) : 0;
    v = pos ? -Math.sign(pos) * clamp((Math.abs(pos) - 0.8) / 0.4, 0, 1) : 0;
    t = pos >= 0.8 ? 'Цена у верхней границы канала — возможен откат вниз'
      : pos <= -0.8 ? 'Цена у нижней границы канала — возможен отскок вверх' : 'Цена внутри канала';
    inds.push({ key: 'bollinger', name: 'Боллинджер(20,2)', value: (pos >= 0 ? '+' : '') + pos.toFixed(2), vote: v, text: t });

    let tw = 0, s = 0;
    for (const i of inds) { tw += WEIGHTS[i.key]; s += WEIGHTS[i.key] * i.vote; }
    const score = s / tw;
    const signal = score >= NEUTRAL_THRESHOLD ? 'LONG' : score <= -NEUTRAL_THRESHOLD ? 'SHORT' : 'NEUTRAL';
    for (const i of inds) i.vote = Math.round(i.vote * 1000) / 1000 || 0;
    return { signal, score: Math.round(score * 1000) / 1000, indicators: inds };
  }

  function analyze(ticks) {
    if (!ticks.length) return { ok: false, error: 'Нет данных — дождись котировок' };
    const end = Math.floor(ticks[ticks.length - 1][0]);
    // берём только непрерывный кусок в конце
    let firstIdx = ticks.length - 1;
    while (firstIdx > 0 && ticks[firstIdx][0] - ticks[firstIdx - 1][0] <= GAP_SEC && end - ticks[firstIdx - 1][0] < WINDOW_SEC + 5) firstIdx--;
    const first = Math.floor(ticks[firstIdx][0]);
    const have = end - first;
    if (have < MIN_DATA_SEC) return { ok: false, error: `Мало данных: ${have} с из ${MIN_DATA_SEC}. Подожди немного.` };
    const start = Math.max(first, end - WINDOW_SEC + 1);
    const closes = resample1s(ticks, start, end);
    const res = analyzeCloses(closes);
    res.ok = true;
    res.price = ticks[ticks.length - 1][1];
    res.ts = ticks[ticks.length - 1][0];
    res.window_sec = closes.length;
    return res;
  }

  // ---- бэктест ----
  function wilson(w, n, z = 1.96) {
    if (!n) return [0, 1];
    const p = w / n, den = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / den;
    const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  const breakeven = p => (p > 0 ? 1 / (1 + p) : 1);

  function segments(ticks) {
    const segs = [];
    let s = 0;
    for (let i = 1; i <= ticks.length; i++) {
      if (i === ticks.length || ticks[i][0] - ticks[i - 1][0] > GAP_SEC) { segs.push(ticks.slice(s, i)); s = i; }
    }
    return segs.filter(x => x.length > 1);
  }

  function backtest(ticks, expiry, payout, step) {
    step = step || Math.max(expiry, 1);
    const warm = WINDOW_SEC;
    let wins = 0, losses = 0, ties = 0, longs = 0, shorts = 0, skipped = 0, histSec = 0;
    for (const seg of segments(ticks)) {
      const start = Math.floor(seg[0][0]), end = Math.floor(seg[seg.length - 1][0]);
      const grid = resample1s(seg, start, end);
      histSec += grid.length;
      for (let i = warm - 1; i < grid.length - expiry; i += step) {
        const sig = analyzeCloses(grid.slice(i - warm + 1, i + 1)).signal;
        if (sig === 'NEUTRAL') { skipped++; continue; }
        const entry = grid[i], exit = grid[i + expiry];
        if (exit === entry) { ties++; continue; }
        if (sig === 'LONG') longs++; else shorts++;
        if ((sig === 'LONG') === (exit > entry)) wins++; else losses++;
      }
    }
    const need = warm + expiry + 1;
    const trades = wins + losses;
    const be = breakeven(payout);
    const out = { ok: true, expiry, history_sec: histSec, trades, wins, losses, ties, skipped, longs, shorts,
      payout, breakeven: Math.round(be * 10000) / 10000 };
    if (trades === 0) {
      if (skipped + ties < 20) {
        return { ok: false, error: `Мало истории для бэктеста (${Math.round(histSec / 60)} мин, проверено точек: ${skipped + ties}). Пусть приложение поработает подольше — нужно хотя бы ${Math.ceil((need + 20 * step) / 60)} мин.` };
      }
      out.winrate = null; out.verdict = 'Алгоритм не дал ни одного сигнала на этой истории.';
      return out;
    }
    const wr = wins / trades;
    const [lo, hi] = wilson(wins, trades);
    const ev = wr * payout - (1 - wr);
    Object.assign(out, { winrate: wr, ci_low: lo, ci_high: hi, ev_per_100: Math.round(ev * 10000) / 100 });
    if (trades < 30) out.verdict = 'Слишком мало сделок для вывода — собери больше истории.';
    else if (lo > be) out.verdict = 'На этой истории алгоритм статистически выше безубытка. Проверь ещё раз на новых данных, прежде чем верить.';
    else if (wr > be) out.verdict = 'Чуть выше безубытка, но в пределах случайности — это может быть везение.';
    else out.verdict = 'Ниже безубытка: при такой выплате этот алгоритм на дистанции теряет деньги.';
    return out;
  }

  function priceAt(ticks, ts) {
    let lo = 0, hi = ticks.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ticks[m][0] <= ts) lo = m + 1; else hi = m; }
    return lo > 0 ? ticks[lo - 1][1] : null;
  }

  const api = { analyze, analyzeCloses, backtest, breakeven, priceAt, resample1s, WINDOW_SEC };
  root.PoAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
