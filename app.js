/* 赛博木鱼 —— 功德即工资
 * 只在设定的上班时段内累计未结功德，敲一下结算清零。
 * 纯原生，无依赖，状态存 localStorage。
 */
'use strict';

const DAY = 86400;
const CAP_SECONDS = 3600;      // 未结功德封顶：1 小时工作量
const LOOKBACK_DAYS = 60;      // 回溯上限，防止长期未打开时空转

const $ = id => document.getElementById(id);

// ── 配置与存档 ────────────────────────────────
const DEFAULT_CFG = {
  salary: 0,
  days: 21.75,
  start: '09:00',
  end: '18:00',
  lunchOn: true,
  lunchStart: '12:00',
  lunchEnd: '13:00',
  week: [1, 2, 3, 4, 5],
  sound: true,
  music: true,
};

let cfg = load('muyu.cfg', DEFAULT_CFG);
let state = load('muyu.state', { total: 0, count: 0, best: 0, lastSettle: Date.now() });

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
  } catch { return Object.assign({}, fallback); }
}
function save() {
  localStorage.setItem('muyu.cfg', JSON.stringify(cfg));
  localStorage.setItem('muyu.state', JSON.stringify(state));
}

// ── 时间与班表计算 ────────────────────────────
const hms = hm => {
  const [h, m] = String(hm).split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
};
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const dayStart = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };

/** 每日计薪秒数（扣掉落在班内的午休） */
function dailyPaidSeconds(c = cfg) {
  let len = hms(c.end) - hms(c.start);
  if (len <= 0) len += DAY;                       // 支持跨夜班
  if (c.lunchOn) {
    let ls = hms(c.lunchStart) - hms(c.start);
    let le = hms(c.lunchEnd) - hms(c.start);
    if (ls < 0) ls += DAY;
    if (le <= ls) le += DAY;
    len -= overlap(ls, le, 0, len);
  }
  return Math.max(0, len);
}

/** 每秒收入（元/秒） */
function ratePerSecond(c = cfg) {
  const paid = dailyPaidSeconds(c);
  if (!c.salary || !c.days || !paid) return 0;
  return c.salary / (c.days * paid);
}

/** 某一天（以 dayStart 秒计）的班次绝对区间，非工作日返回 null */
function shiftOf(ds, c = cfg) {
  const wd = new Date(ds * 1000).getDay();
  if (!c.week.includes(wd)) return null;
  let len = hms(c.end) - hms(c.start);
  if (len <= 0) len += DAY;
  const ws = ds + hms(c.start);
  const shift = { ws, we: ws + len, lunch: null };
  if (c.lunchOn) {
    let ls = ds + hms(c.lunchStart);
    let le = ds + hms(c.lunchEnd);
    if (ls < ws) ls += DAY;
    if (le <= ls) le += DAY;
    shift.lunch = [ls, le];
  }
  return shift;
}

/** [t0,t1] 之间落在班表内的计薪秒数（t 单位：秒） */
function paidSecondsBetween(t0, t1, c = cfg) {
  if (t1 <= t0) return 0;
  t0 = Math.max(t0, t1 - LOOKBACK_DAYS * DAY);
  let sec = 0;
  // 从前一天开始扫，覆盖跨夜班
  for (let d = dayStart(t0 * 1000) - DAY; d <= t1; d += DAY) {
    const s = shiftOf(d, c);
    if (!s) continue;
    let hit = overlap(s.ws, s.we, t0, t1);
    if (hit <= 0) continue;
    if (s.lunch) hit -= overlap(s.lunch[0], s.lunch[1], Math.max(s.ws, t0), Math.min(s.we, t1));
    sec += Math.max(0, hit);
  }
  return sec;
}

/** 当前是否在计薪时段 */
function workStatus(now = Date.now() / 1000) {
  if (!cfg.salary) return 'unset';
  for (let d = dayStart(now * 1000) - DAY; d <= now; d += DAY) {
    const s = shiftOf(d);
    if (!s || now < s.ws || now >= s.we) continue;
    if (s.lunch && now >= s.lunch[0] && now < s.lunch[1]) return 'lunch';
    return 'work';
  }
  const wd = new Date(now * 1000).getDay();
  return cfg.week.includes(wd) ? 'off' : 'weekend';
}

// ── 未结功德 ──────────────────────────────────
function pendingNow() {
  const r = ratePerSecond();
  if (!r) return { amount: 0, capped: false, ratio: 0 };
  const now = Date.now() / 1000;
  const sec = paidSecondsBetween(state.lastSettle / 1000, now);
  const capped = sec >= CAP_SECONDS;
  return {
    amount: r * Math.min(sec, CAP_SECONDS),
    capped,
    ratio: Math.min(1, sec / CAP_SECONDS),
  };
}

// ── 音效：木鱼的模态合成（无外部音频文件）──────────
// 木头被敲 = 极短的冲击激励 + 木腔几个不成谐波列的共振模态，各自快速衰减。
// 想调音色：F0 决定音高（大木鱼调低到 ~380，小木鱼 ~700）；
// 嫌闷就把下面 click 那段的 cg.gain 调大，嫌吵就调小。
// 模态：[频率比, 衰减秒, 音量]
const MODES = [
  [1.00, 0.34, 0.60],   // 基频腔体，撑起"笃"的音高
  [1.94, 0.16, 0.24],   // 非整数比 → 木头的闷，不是钟的谐波列
  [3.31, 0.075, 0.11],
  [5.12, 0.035, 0.05],
];
const F0 = 540;

let ac = null;
const noiseCache = new Map();

/** 一段噪声源：ms 毫秒，pow 越大衰减越陡 */
function excitation(ctx, ms = 5, pow = 2) {
  const key = `${ctx.sampleRate}/${ms}/${pow}`;
  let buf = noiseCache.get(key);
  if (!buf) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * ms / 1000));
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, pow);
    }
    noiseCache.set(key, buf);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

/** 在 ctx 上于 t 时刻构建一次敲击，接到 dest；vel 为力度 0~1 */
function buildKnock(ctx, dest, t, vel = 1, detune = 1) {
  const out = ctx.createGain();
  out.gain.value = 0.6 * vel;
  out.connect(dest);

  // 各模态用衰减正弦谐振，能量和衰减时间才控得准
  for (const [ratio, dur, amp] of MODES) {
    const f = F0 * ratio * detune;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f * 1.06, t);              // 敲击瞬间张力略高，很快回落
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // 木质颗粒：带通噪声，让它不像纯电子正弦
  const grain = excitation(ctx, 6, 2);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = F0 * 1.5 * detune; bp.Q.value = 2.2;
  const gg = ctx.createGain();
  gg.gain.setValueAtTime(1.6, t);
  gg.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  grain.connect(bp).connect(gg).connect(out);
  grain.start(t);

  // 槌头触木的"哒"：木头敲击必须有的高频瞬态，衰减平缓些才听得见
  const click = excitation(ctx, 12, 0.8);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 2400;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(1.1, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.022);
  click.connect(hp).connect(cg).connect(out);
  click.start(t);

  return out;
}

/** 拿到（必要时创建）音频上下文；浏览器要求先有用户交互 */
function audio() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    unlock(ac);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

/** iOS 上 resume() 是异步的，不先喂一帧静音把时钟跑起来，第一下敲击会丢音 */
function unlock(ctx) {
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* 解锁失败就算了，后面照常尝试发声 */ }
}

function knockSound(vel = 1) {
  if (!cfg.sound) return;
  try {
    const ctx = audio();
    if (!ctx) return;
    // 还没 running（刚 resume）就往后错开一点点排，免得包络落在时钟启动之前被吞掉
    const t = ctx.currentTime + (ctx.state === 'running' ? 0 : 0.02);
    buildKnock(ctx, ctx.destination, t, vel, 0.97 + Math.random() * 0.06);
  } catch { /* 音频不可用就静默 */ }
}

// ── 禅意背景音：drone + 五声音阶随机音 + 偶尔一记磬 ──────────
// 同样是现场合成，不引任何音频文件。
const SCALE = [293.66, 329.63, 369.99, 440.00, 493.88, 587.33];  // D 宫五声：宫商角徵羽
let bgm = null;

/** 程序生成混响脉冲响应——没有它，合成音会干得像电子琴 */
function makeReverb(ctx, seconds = 3.2, decay = 2.4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  const conv = ctx.createConvolver();
  conv.buffer = buf;
  return conv;
}

/** 一记柔和的长音 */
function playTone(ctx, freq, dur, amp, dest) {
  const t = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.9);      // 慢起音，不突兀
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(dest);
  [[freq, 'sine', 1], [freq * 2.002, 'sine', 0.22], [freq * 3, 'triangle', 0.06]]
    .forEach(([f, type, a]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = a;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + dur + 0.1);
    });
}

/** 一记磬：高频、模态、长余韵 */
function playBell(ctx, dest) {
  const t = ctx.currentTime;
  const f0 = 880 * (0.98 + Math.random() * 0.04);
  [[1, 3.4, 0.20], [2.76, 2.2, 0.09], [5.4, 1.4, 0.04]].forEach(([r, dur, amp]) => {
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = f0 * r;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.1);
  });
}

function startBGM() {
  if (bgm || !cfg.music) return;
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(0.5, t + 5);        // 5 秒淡入，别吓人
  master.connect(ctx.destination);

  const wet = makeReverb(ctx);
  const wetGain = ctx.createGain(); wetGain.gain.value = 0.55;
  wet.connect(wetGain).connect(master);
  const bus = ctx.createGain();                            // 干湿都走
  bus.connect(master);
  bus.connect(wet);

  // 低频持续音，托住整个空间
  const drone = ctx.createGain();
  drone.gain.value = 0.055;
  drone.connect(master);
  const nodes = [];
  [73.42, 110.0].forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = 'sine'; o.frequency.value = f;
    const g = ctx.createGain(); g.gain.value = i ? 0.5 : 1;
    // 极慢的音量起伏，像呼吸
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.035 + i * 0.014;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.35;
    lfo.connect(lfoGain).connect(g.gain);
    o.connect(g).connect(drone);
    o.start(t); lfo.start(t);
    nodes.push(o, lfo);
  });

  bgm = { master, bus, timers: [], nodes };

  const nextNote = () => {
    if (!bgm) return;
    playTone(ctx, SCALE[Math.floor(Math.random() * SCALE.length)],
             5 + Math.random() * 3, 0.08 + Math.random() * 0.04, bgm.bus);
    bgm.timers.push(setTimeout(nextNote, 5000 + Math.random() * 7000));
  };
  const nextBell = () => {
    if (!bgm) return;
    playBell(ctx, bgm.bus);
    bgm.timers.push(setTimeout(nextBell, 45000 + Math.random() * 50000));
  };
  bgm.timers.push(setTimeout(nextNote, 1200));
  bgm.timers.push(setTimeout(nextBell, 20000 + Math.random() * 25000));
}

function stopBGM() {
  if (!bgm) return;
  const b = bgm;
  bgm = null;
  b.timers.forEach(clearTimeout);
  try {
    const t = ac.currentTime;
    b.master.gain.cancelScheduledValues(t);
    b.master.gain.setValueAtTime(b.master.gain.value, t);
    b.master.gain.linearRampToValueAtTime(0.0001, t + 1.5);   // 淡出，别咔一声
    setTimeout(() => {
      b.nodes.forEach(n => { try { n.stop(); } catch {} });    // 常驻振荡器必须停，否则白烧 CPU
      try { b.master.disconnect(); } catch {}
    }, 1800);
  } catch { /* ignore */ }
}

// ── 渲染 ──────────────────────────────────────
const money = v => v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_TEXT = {
  unset: ['未设置薪资', false],
  work: ['上班中 · 功德累积', true],
  lunch: ['午休中 · 暂停计薪', false],
  off: ['已下班 · 停止计薪', false],
  weekend: ['休息日 · 停止计薪', false],
};

function render() {
  const p = pendingNow();
  $('pendingNum').textContent = money(p.amount);
  $('capFill').style.width = (p.ratio * 100) + '%';
  $('capFill').classList.toggle('full', p.capped);

  const st = workStatus();
  const [text, on] = STATUS_TEXT[st];
  $('statusText').textContent = text;
  $('statusDot').classList.toggle('on', on);

  const hint = $('pendingHint');
  if (p.capped) {
    hint.textContent = '已达上限 · 摸太久了，赶紧敲';
    hint.classList.add('warn');
  } else {
    hint.classList.remove('warn');
    hint.textContent = st === 'unset' ? '先去设置里填月薪'
      : st === 'work' ? '攒得越久，一敲越响'
      : '不在计薪时段，敲了也是零';
  }

  $('statTotal').textContent = '¥' + money(state.total);
  $('statCount').textContent = state.count.toLocaleString('zh-CN');
  $('statBest').textContent = '¥' + money(state.best);

  const r = ratePerSecond();
  $('rateNote').textContent = r
    ? `每秒 ¥${r.toFixed(4)} · 每分钟 ¥${(r * 60).toFixed(2)} · 每小时 ¥${(r * 3600).toFixed(2)}`
    : '';
}

// ── 木槌跟随指针 ──────────────────────────────
const mallet = $('mallet');
const fishBtn = $('fish');

// 木鱼在 SVG viewBox(240×200) 里的椭圆：中心 (120,106)，半径 88×62
const FISH = { cx: 120 / 240, cy: 106 / 200, rx: 88 / 240, ry: 62 / 200, inset: 0.82 };
// 停靠位（相对 .fish-btn 的比例）。注意：不能写成 CSS 的 translate 百分比，
// 那是相对木槌自身尺寸算的，会把槌甩到左上角去。
const DOCK = { x: 0.62, y: 0.44 };

/** 把槌头移到 (clientX, clientY)；不传则回到停靠位。
 *  按钮是矩形而木鱼是椭圆，指针落在四角空白时把槌头吸附回木鱼面上，
 *  否则槌头会悬在木鱼外的半空中。 */
function aimMallet(clientX, clientY) {
  const r = fishBtn.getBoundingClientRect();
  if (clientX == null) {                 // 归位：木鱼右上表面
    mallet.classList.remove('follow');
    mallet.style.setProperty('--mx', r.width * DOCK.x + 'px');
    mallet.style.setProperty('--my', r.height * DOCK.y + 'px');
    return;
  }
  const cx = r.width * FISH.cx, cy = r.height * FISH.cy;
  const rx = r.width * FISH.rx * FISH.inset, ry = r.height * FISH.ry * FISH.inset;
  let x = clientX - r.left, y = clientY - r.top;
  const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
  if (d > 1) {                       // 落在木鱼外 → 拉到最近的木鱼边缘
    x = cx + (x - cx) / d;
    y = cy + (y - cy) / d;
  }
  mallet.classList.add('follow');
  mallet.style.setProperty('--mx', x + 'px');
  mallet.style.setProperty('--my', y + 'px');
}

/** 槌头当前落点，用于涟漪和飘字定位 */
function malletPoint() {
  const r = fishBtn.getBoundingClientRect();
  const mx = mallet.style.getPropertyValue('--mx');
  const my = mallet.style.getPropertyValue('--my');
  return mx ? { x: parseFloat(mx), y: parseFloat(my) }
            : { x: r.width * DOCK.x, y: r.height * DOCK.y };
}

// ── 敲击 ──────────────────────────────────────
function knock() {
  const p = pendingNow();
  state.lastSettle = Date.now();
  if (p.amount > 0) {
    state.total += p.amount;
    state.count += 1;
    state.best = Math.max(state.best, p.amount);
  }
  save();

  // 木鱼形变
  fishBtn.classList.remove('hit');
  void fishBtn.offsetWidth;
  fishBtn.classList.add('hit');
  setTimeout(() => fishBtn.classList.remove('hit'), 430);

  // 木槌抬起落下
  mallet.classList.remove('strike');
  void mallet.offsetWidth;
  mallet.classList.add('strike');
  setTimeout(() => mallet.classList.remove('strike'), 310);

  const halo = $('halo');
  halo.classList.add('hit');
  setTimeout(() => halo.classList.remove('hit'), 320);

  const amt = $('pendingNum').parentElement;
  amt.classList.add('zeroed');
  setTimeout(() => amt.classList.remove('zeroed'), 200);

  // 涟漪从敲击点扩散
  const pt = malletPoint();
  const rp = document.createElement('div');
  rp.className = 'ripple';
  rp.style.left = pt.x + 'px';
  rp.style.top = pt.y + 'px';
  fishBtn.appendChild(rp);
  setTimeout(() => rp.remove(), 560);

  const f = document.createElement('div');
  f.className = 'float' + (p.amount >= ratePerSecond() * 1800 ? ' big' : '');
  f.textContent = p.amount > 0 ? `+¥${money(p.amount)}` : '功德 +0';
  const fr = fishBtn.getBoundingClientRect();
  const wr = fishBtn.parentElement.getBoundingClientRect();
  f.style.left = (fr.left - wr.left + pt.x) + 'px';
  f.style.top = (fr.top - wr.top + pt.y - 20) + 'px';
  $('floats').appendChild(f);
  setTimeout(() => f.remove(), 1300);

  knockSound(p.amount > 0 ? 1 : 0.55);
  if (navigator.vibrate) navigator.vibrate(p.amount > 0 ? 18 : 8);
  render();
}

// ── 设置面板 ──────────────────────────────────
function openSheet() {
  $('inSalary').value = cfg.salary || '';
  $('inDays').value = cfg.days;
  $('inStart').value = cfg.start;
  $('inEnd').value = cfg.end;
  $('inLunchOn').checked = cfg.lunchOn;
  $('inLunchStart').value = cfg.lunchStart;
  $('inLunchEnd').value = cfg.lunchEnd;
  $('inSound').checked = cfg.sound;
  $('inMusic').checked = cfg.music;
  document.querySelectorAll('#weekPicker button').forEach(b =>
    b.classList.toggle('on', cfg.week.includes(+b.dataset.d)));
  syncLunchRow();
  previewCalc();
  $('sheet').classList.add('show');
  $('sheetMask').classList.add('show');
  $('sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('sheet').classList.remove('show');
  $('sheetMask').classList.remove('show');
  $('sheet').setAttribute('aria-hidden', 'true');
}
function syncLunchRow() {
  $('lunchRow').classList.toggle('off', !$('inLunchOn').checked);
}

function readForm() {
  return {
    salary: parseFloat($('inSalary').value) || 0,
    days: parseFloat($('inDays').value) || 21.75,
    start: $('inStart').value || '09:00',
    end: $('inEnd').value || '18:00',
    lunchOn: $('inLunchOn').checked,
    lunchStart: $('inLunchStart').value || '12:00',
    lunchEnd: $('inLunchEnd').value || '13:00',
    week: [...document.querySelectorAll('#weekPicker button.on')].map(b => +b.dataset.d),
    sound: $('inSound').checked,
    music: $('inMusic').checked,
  };
}

function previewCalc() {
  const c = readForm();
  const box = $('calcPreview');
  const paid = dailyPaidSeconds(c);
  if (!c.salary || !c.week.length || !paid) {
    box.innerHTML = '填好月薪和班表，这里会算给你看。';
    return;
  }
  const r = ratePerSecond(c);
  box.innerHTML =
    `每天计薪 <b>${(paid / 3600).toFixed(2)}</b> 小时 · 每月 <b>${c.days}</b> 天<br>` +
    `时薪 <b>¥${(r * 3600).toFixed(2)}</b> · 每分钟 <b>¥${(r * 60).toFixed(2)}</b><br>` +
    `未结功德封顶 <b>¥${(r * CAP_SECONDS).toFixed(2)}</b>（1 小时工作量）`;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2000);
}

// ── 事件绑定 ──────────────────────────────────
// 木槌跟着指针走，落点即敲击点
fishBtn.addEventListener('pointermove', e => aimMallet(e.clientX, e.clientY));
fishBtn.addEventListener('pointerleave', () => aimMallet(null));
fishBtn.addEventListener('pointerdown', e => {
  e.preventDefault();                       // 别让浏览器再补一次 click
  aimMallet(e.clientX, e.clientY);
  knock();
});
fishBtn.addEventListener('pointerup', e => {
  if (e.pointerType !== 'mouse') aimMallet(null);   // 触摸抬手后木槌归位
});
// iOS 的侧边静音键会把网页音频整体掐掉，且网页无法检测、无法绕过，只能提示一句
{
  const iOS = /iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) $('iosAudioNote').hidden = false;
}

// ── 全屏 ──────────────────────────────────────
// iOS Safari 不给普通元素全屏（只有 video 行），检测不到 API 就干脆不显示按钮，
// 那边的“全屏”靠添加到主屏幕（manifest display:fullscreen）来实现。
(() => {
  const btn = $('btnFull');
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const standalone = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
    || navigator.standalone === true;
  if (!req || standalone) return;             // 已经是全屏形态，或系统不支持

  btn.hidden = false;
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const sync = () => {
    document.body.classList.toggle('is-full', isFull());
    btn.setAttribute('aria-label', isFull() ? '退出全屏' : '全屏');
  };
  btn.addEventListener('click', () => {
    if (isFull()) { try { exit.call(document); } catch { /* 退不出就算了 */ } return; }
    // 有的浏览器（尤其是各家 ROM 自带的）API 在、调用不报错，但就是不全屏。
    // 光靠 catch 抓不到，得回头看一眼到底进没进，不然按钮点下去毫无反馈。
    try { req.call(el, { navigationUI: 'hide' }); } catch { /* 下面统一提示 */ }
    setTimeout(() => {
      if (!isFull()) toast('这个浏览器不给网页全屏，试试菜单里「添加到主屏幕」');
    }, 500);
  });
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev =>
    document.addEventListener(ev, sync));
  sync();
})();

$('btnSettings').addEventListener('click', openSheet);
$('sheetMask').addEventListener('click', closeSheet);
$('inLunchOn').addEventListener('change', () => { syncLunchRow(); previewCalc(); });
$('sheet').addEventListener('input', previewCalc);

document.querySelectorAll('#weekPicker button').forEach(b =>
  b.addEventListener('click', () => { b.classList.toggle('on'); previewCalc(); }));

$('btnSave').addEventListener('click', () => {
  const c = readForm();
  if (c.salary <= 0) return toast('先填个月薪吧');
  if (!c.week.length) return toast('至少选一个工作日');
  if (dailyPaidSeconds(c) <= 0) return toast('班表时间不对，算下来没得赚');
  cfg = c;
  save();
  closeSheet();
  render();
  cfg.music ? startBGM() : stopBGM();
  toast('已保存，开始摸鱼');
});

$('btnReset').addEventListener('click', () => {
  if (!confirm('清空累计功德和敲击记录？此操作不可撤销。')) return;
  state = { total: 0, count: 0, best: 0, lastSettle: Date.now() };
  save();
  render();
  toast('功德已清零，重新做人');
});

document.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'Enter') {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || (ae.tagName === 'BUTTON' && ae !== fishBtn))) return;
    if ($('sheet').classList.contains('show')) return;
    e.preventDefault();
    knock();
  }
  if (e.code === 'Escape') closeSheet();
});

// 背景音开关即时生效（不用等保存）
$('inMusic').addEventListener('change', e => {
  cfg.music = e.target.checked;
  cfg.music ? startBGM() : stopBGM();
});

// 页面回到前台时刷新；切走就停背景音，别在后台白耗电
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBGM();
  else { render(); if (cfg.music && cfg.salary) startBGM(); }
});

// 停靠位按木鱼实际尺寸算，尺寸变了要重算
addEventListener('resize', () => { if (!mallet.classList.contains('follow')) aimMallet(null); });
aimMallet(null);

// ── 启动 ──────────────────────────────────────
// 浮尘：数量克制，纯 CSS 动画，静止时不占 JS
(() => {
  const box = $('dust');
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 16; i++) {
    const p = document.createElement('i');
    const s = (1 + Math.random() * 2.2).toFixed(1);
    p.style.width = p.style.height = s + 'px';
    p.style.left = (Math.random() * 100).toFixed(1) + '%';
    p.style.setProperty('--dx', (Math.random() * 90 - 45).toFixed(0) + 'px');
    p.style.setProperty('--dy', (55 + Math.random() * 50).toFixed(0) + 'vh');
    p.style.animationDuration = (28 + Math.random() * 34).toFixed(0) + 's';
    p.style.animationDelay = (-Math.random() * 50).toFixed(0) + 's';
    frag.appendChild(p);
  }
  box.appendChild(frag);
})();

// 浏览器不允许无交互自动播放，等第一次点击/触摸再起背景音
addEventListener('pointerdown', () => { if (cfg.music && cfg.salary) startBGM(); }, { once: true });

render();
setInterval(render, 200);
if (!cfg.salary) setTimeout(openSheet, 600);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
