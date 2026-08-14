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
  scene: 'moon',        // moon 月夜 / dusk 暮色 / bamboo 竹林 / rain 雨夜
  bgm: 'zen',           // zen 禅意 / rain 雨声 / chime 风铃 / off 关闭
};

const SCENES = [
  ['moon', '月夜'], ['dusk', '暮色'], ['bamboo', '竹林'], ['rain', '雨夜'],
];
const BGMS = [
  ['zen', '禅意'], ['rain', '雨声'], ['chime', '风铃'], ['off', '关闭'],
];

let cfg = migrate(load('muyu.cfg', DEFAULT_CFG), rawCfg());

function rawCfg() {
  try { return JSON.parse(localStorage.getItem('muyu.cfg')) || {}; } catch { return {}; }
}

/** 老档只有 music 布尔开关，换成 bgm 选项。
 *  必须拿没被默认值填充过的原始存档来判断：load() 合并完默认值之后，
 *  「用户关过背景音」和「用户没设置过」就分不出来了。 */
function migrate(c, raw) {
  if (typeof raw.music === 'boolean' && raw.bgm === undefined) {
    c.bgm = raw.music ? 'zen' : 'off';
  }
  if (!SCENES.some(s => s[0] === c.scene)) c.scene = 'moon';
  if (!BGMS.some(b => b[0] === c.bgm)) c.bgm = 'zen';
  delete c.music;
  return c;
}
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
// 模态比例刻意排得密而不规则：木头是各向异性的，模态多且互不成整数比，
// 稀疏的谐波列听起来就成了钟或木琴。
const MODES = [
  [1.00, 0.30, 0.60],   // 基频腔体，撑起"笃"的音高
  [1.63, 0.19, 0.30],
  [2.42, 0.12, 0.19],
  [3.37, 0.075, 0.12],
  [4.79, 0.045, 0.07],
  [6.55, 0.028, 0.04],
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

/** 敲击点 → 音色。参数含义见 buildKnock。
 *  真木鱼就是这样：中间腔体空、壁薄，敲下去沉且余韵长；越靠边壁越厚实，
 *  腔体带不动，只剩短促发脆的木头声、音高还偏高；下方开口槽附近最"活"。
 *  nx/ny 是相对木鱼椭圆中心的归一化坐标（±1 为边缘）。 */
function timbreAt(nx, ny) {
  // 到边缘的距离决定壁厚：越靠边木头越实，音越高越脆
  const dEdge = Math.min(1, Math.hypot(nx, ny));
  // 甜点不在几何中心，而在开口槽正上方那块鼓面（略偏下），那里腔体带得最动
  const dSweet = Math.min(1, Math.hypot(nx, (ny - 0.25) / 0.95));

  return {
    detune: 1 + 0.40 * dEdge * dEdge,     // 边缘比甜点高约五个半音
    body: 1.10 - 0.75 * dSweet,           // 腔体共振：甜点足、边缘瘪
    edge: 0.70 + 1.15 * dEdge,            // 槌头触木的"嗒"：边缘最突出
  };
}

/** 在 ctx 上于 t 时刻构建一次敲击，接到 dest；vel 为力度 0~1
 *  tone: detune 音高倍率 / body 腔体共振量 0~1.3 / edge 高频瞬态量 */
function buildKnock(ctx, dest, t, vel = 1, tone = {}) {
  const { detune = 1, body = 1, edge = 1 } = tone;
  const out = ctx.createGain();
  // 边缘音瞬态成分重，不按 edge 补偿回来会顶到 1.0 以上削波
  out.gain.value = 0.72 * vel / (0.62 + 0.42 * edge);
  out.connect(dest);

  // 木头之所以听起来是木头：高频阻尼远大于低频，敲下去那一瞬亮，几十毫秒就闷掉。
  // 少了这道扫下来的低通，同样的模态听着就是电子木琴。
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.Q.value = 0.6;
  const open = 5200 * (0.7 + 0.5 * edge);
  damp.frequency.setValueAtTime(open, t);
  damp.frequency.exponentialRampToValueAtTime(1500 - 550 * body, t + 0.075);
  damp.connect(out);

  MODES.forEach(([ratio, dur, amp], i) => {
    const f = F0 * ratio * detune;
    // 敲边缘时低模态被压住、高模态相对更突出，音色就从"笃"变成"嗒"
    const w = i === 0 ? 0.42 + 0.58 * body : 1.30 - 0.30 * body;
    const life = dur * (0.34 + 0.66 * body);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // 受击瞬间木材刚度非线性，音高冲高再落回——这个下滑是"敲"而不是"弹"的关键
    osc.frequency.setValueAtTime(f * 1.14, t);
    osc.frequency.exponentialRampToValueAtTime(f, t + 0.018);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp * w, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + life);
    osc.connect(g).connect(damp);
    osc.start(t);
    osc.stop(t + life + 0.02);

    // 每个模态配一份窄带噪声：木纤维的沙沙底噪，纯正弦没有这个就发假。
    // 越高的模态噪声占比越大，因为高频那几支本来就更接近噪声而非正弦。
    if (i < 4) {
      // 噪声得比包络长，否则源播完了包络还在降，尾巴会凭空断掉
      const n = excitation(ctx, 220, 0.6);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 9 - i * 1.5;
      const ng = ctx.createGain();
      const na = amp * w * (0.28 + 0.16 * i);
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(na, t + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + life * 0.7);
      n.connect(bp).connect(ng).connect(damp);
      n.start(t);
    }
  });

  // 槌头触木：木槌是木头不是塑料，这一下应该是"嗒"不是"啪"，
  // 所以带通夹住而不是单纯高通——不然高频尖头会盖过木腔。
  const click = excitation(ctx, 10, 1.1);
  const cbp = ctx.createBiquadFilter();
  cbp.type = 'bandpass';
  cbp.frequency.value = 1750 * (0.85 + 0.35 * edge);
  cbp.Q.value = 0.9;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(1.35 * edge, t);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.026);
  click.connect(cbp).connect(cg).connect(out);
  click.start(t);

  // 木块被砸的箱体感：一记极低频短脉冲，音量小但少了它敲击不"实"
  const thump = ctx.createOscillator();
  thump.type = 'sine';
  thump.frequency.setValueAtTime(150, t);
  thump.frequency.exponentialRampToValueAtTime(78, t + 0.05);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.20 * body, t + 0.004);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
  thump.connect(tg).connect(out);
  thump.start(t); thump.stop(t + 0.12);

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

function knockSound(vel = 1, tone = {}) {
  if (!cfg.sound) return;
  try {
    const ctx = audio();
    if (!ctx) return;
    // 还没 running（刚 resume）就往后错开一点点排，免得包络落在时钟启动之前被吞掉
    const t = ctx.currentTime + (ctx.state === 'running' ? 0 : 0.02);
    // 随机微扰收窄到 ±1%，别把位置带来的音色差给盖过去
    const jitter = 0.99 + Math.random() * 0.02;
    buildKnock(ctx, ctx.destination, t, vel,
      { ...tone, detune: (tone.detune || 1) * jitter });
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

/** 一滴水落进积水：极短的下滑正弦，尾巴带一点点混响就很像 */
function playDrop(ctx, dest) {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = 620 + Math.random() * 900;
  o.frequency.setValueAtTime(f * 1.9, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.75, t + 0.055);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.10 + Math.random() * 0.07, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  o.connect(g).connect(dest);
  o.start(t); o.stop(t + 0.18);
}

/** 一串风铃：三角波，几个不成谐的音一起响，长余韵 */
function playChime(ctx, dest) {
  const t0 = ctx.currentTime;
  const base = [1174.66, 1318.51, 1567.98, 1760.00, 2093.00][Math.floor(Math.random() * 5)];
  const n = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * (0.06 + Math.random() * 0.1);
    const f = base * (i ? 1 + (Math.random() - 0.5) * 0.5 : 1);
    [[1, 2.6, 0.055], [2.71, 1.5, 0.022], [4.1, 0.9, 0.010]].forEach(([r, dur, amp]) => {
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f * r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(dest);
      o.start(t); o.stop(t + dur + 0.1);
    });
  }
}

/** 雨：白噪过低通就是雨，再叠一层带通的"沙"，用 LFO 让雨势有大小 */
function buildRain(ctx, master, nodes) {
  const t = ctx.currentTime;
  const len = Math.floor(ctx.sampleRate * 3);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    let last = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      // 粉噪化：白噪太"嘶"，一阶积分压一下高频才像雨
      last = (last + (Math.random() * 2 - 1) * 0.35) * 0.97;
      ch[i] = last;
      if (Math.abs(last) > peak) peak = Math.abs(last);
    }
    // 这个递归的直流增益是 1/(1-0.97) ≈ 33 倍，不归一化直接就削爆了
    const norm = peak > 0 ? 0.25 / peak : 1;
    for (let i = 0; i < len; i++) ch[i] *= norm;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf; src.loop = true;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.4;
  const hiss = ctx.createBiquadFilter();
  hiss.type = 'bandpass'; hiss.frequency.value = 5200; hiss.Q.value = 0.7;
  const hissGain = ctx.createGain(); hissGain.gain.value = 0.22;

  const body = ctx.createGain(); body.gain.value = 0.85;
  src.connect(lp).connect(body).connect(master);
  src.connect(hiss).connect(hissGain).connect(master);

  // 雨势起伏：极慢 LFO 扫低通，听感上就是一阵大一阵小
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 700;
  lfo.connect(lfoGain).connect(lp.frequency);

  src.start(t); lfo.start(t);
  nodes.push(src, lfo);
}

/** 按 cfg.bgm 起对应的背景音；off 或没设薪资就不响 */
function startBGM() {
  if (bgm || cfg.bgm === 'off') return;
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

  const nodes = [];
  bgm = { master, bus, timers: [], nodes, kind: cfg.bgm };

  // 低频持续音，托住整个空间。雨声自带铺底，不需要再压一层嗡嗡
  if (cfg.bgm !== 'rain') {
    const drone = ctx.createGain();
    drone.gain.value = cfg.bgm === 'chime' ? 0.028 : 0.055;
    drone.connect(master);
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
  }

  const every = (fn, min, span, first) => {
    const tick = () => {
      if (!bgm) return;
      fn(ctx, bgm.bus);
      bgm.timers.push(setTimeout(tick, min + Math.random() * span));
    };
    bgm.timers.push(setTimeout(tick, first));
  };

  if (cfg.bgm === 'zen') {
    const note = () => playTone(ctx, SCALE[Math.floor(Math.random() * SCALE.length)],
      5 + Math.random() * 3, 0.08 + Math.random() * 0.04, bgm.bus);
    every(note, 5000, 7000, 1200);
    every(playBell, 45000, 50000, 20000 + Math.random() * 25000);
  } else if (cfg.bgm === 'rain') {
    buildRain(ctx, master, nodes);
    every(playDrop, 2600, 6000, 3000);          // 檐下滴水，疏落几声就够
  } else if (cfg.bgm === 'chime') {
    every(playChime, 6000, 11000, 900);
  }
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

// ── 月相：按月龄画残缺 ────────────────────────
// 农历月就是朔望月，初一为朔、十五前后为望，所以月龄直接决定月亮的缺法。
// 用平均朔望月推月龄，误差半天以内，看形状足够；要精确到分钟得算摄动，不值当。
const SYNODIC = 29.530588853 * 86400e3;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);      // 2000-01-06 的朔，公认参考点

/** 0=朔 0.25=上弦 0.5=望 0.75=下弦 */
function moonPhase(now = Date.now()) {
  return ((now - NEW_MOON) % SYNODIC + SYNODIC) % SYNODIC / SYNODIC;
}

const PHASE_NAMES = ['朔月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];

/** 亮面路径：外缘半圆 + 终结线椭圆弧。
 *  终结线是圆在斜光下的投影，所以是椭圆而不是圆——用两个圆去交是画不对月牙的。 */
function moonPath(p, R = 48) {
  const d = Math.cos(2 * Math.PI * p);        // 1 朔 → -1 望
  // 朔前后严格画就是一片全黑，屏幕上只剩个盘子很难看。留一道最细的牙
  // （相当于把月龄 1 天画成 1.5 天的样子），拿一点准确度换画面。
  const rx = Math.min(Math.abs(d), 0.93) * R;
  const right = p < 0.5;                      // 上半月亮面在右，下半月在左（北半球）
  const outer = right ? 1 : 0;
  const inner = ((d > 0) === right) ? 0 : 1;  // 蛾眉时终结线与外缘同侧弯，凸月时反向
  return `M0,${-R} A${R},${R} 0 0,${outer} 0,${R} A${rx},${R} 0 0,${inner} 0,${-R} Z`;
}

function renderMoon() {
  const p = moonPhase();
  $('moonLit').setAttribute('d', moonPath(p));
  const lit = (1 - Math.cos(2 * Math.PI * p)) / 2;          // 照亮比例 0~1
  const moon = $('moon');
  moon.style.setProperty('--glow', (0.22 + 0.78 * lit).toFixed(3));
  moon.setAttribute('aria-label',
    `${PHASE_NAMES[Math.round(p * 8) % 8]}（月龄 ${(p * 29.53).toFixed(1)} 天）`);
}

// ── 场景 ──────────────────────────────────────
// 四套主题共用一份 DOM，切换只改 body 上的 data-scene，CSS 负责谁露面。
const THEME_COLOR = { moon: '#080d11', dusk: '#2a1a1f', bamboo: '#070f0a', rain: '#04090d' };

function applyScene() {
  document.body.dataset.scene = cfg.scene;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = THEME_COLOR[cfg.scene] || THEME_COLOR.moon;
  if (cfg.scene === 'bamboo') makeLeaves();
}

/** 竹叶只在第一次进竹林时生成，别页面一开就挂 12 个动画在那空转 */
function makeLeaves() {
  const box = $('leaves');
  if (box.childElementCount) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 12; i++) {
    const p = document.createElement('i');
    p.style.left = (Math.random() * 100).toFixed(1) + '%';
    p.style.setProperty('--dx', (Math.random() * 120 - 60).toFixed(0) + 'px');
    p.style.animationDuration = (14 + Math.random() * 16).toFixed(0) + 's';
    p.style.animationDelay = (-Math.random() * 26).toFixed(0) + 's';
    p.style.opacity = (0.35 + Math.random() * 0.4).toFixed(2);
    frag.appendChild(p);
  }
  box.appendChild(frag);
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

  // 敲哪儿就是哪儿的音色：把落点换算成相对木鱼椭圆中心的归一化坐标
  const nx = (pt.x - fr.width * FISH.cx) / (fr.width * FISH.rx * FISH.inset);
  const ny = (pt.y - fr.height * FISH.cy) / (fr.height * FISH.ry * FISH.inset);
  knockSound(p.amount > 0 ? 1 : 0.55, timbreAt(nx, ny));
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
  markPicker('scenePicker', cfg.scene);
  markPicker('bgmPicker', cfg.bgm);
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

/** 分段选择器：一组按钮里点亮一个 */
function markPicker(id, value) {
  document.querySelectorAll(`#${id} button`).forEach(b =>
    b.classList.toggle('on', b.dataset.v === value));
}
function pickerValue(id, fallback) {
  return document.querySelector(`#${id} button.on`)?.dataset.v || fallback;
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
    scene: pickerValue('scenePicker', cfg.scene),
    bgm: pickerValue('bgmPicker', cfg.bgm),
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

// 场景与背景音即时生效：挑主题这种事，得当场看见听见才知道要不要
document.querySelectorAll('#scenePicker button').forEach(b =>
  b.addEventListener('click', () => {
    markPicker('scenePicker', b.dataset.v);
    cfg.scene = b.dataset.v;
    applyScene();
  }));
document.querySelectorAll('#bgmPicker button').forEach(b =>
  b.addEventListener('click', () => {
    markPicker('bgmPicker', b.dataset.v);
    cfg.bgm = b.dataset.v;
    stopBGM();
    if (cfg.bgm !== 'off') setTimeout(startBGM, 60);   // 等上一套淡出，别叠在一起
  }));

$('btnSave').addEventListener('click', () => {
  const c = readForm();
  if (c.salary <= 0) return toast('先填个月薪吧');
  if (!c.week.length) return toast('至少选一个工作日');
  if (dailyPaidSeconds(c) <= 0) return toast('班表时间不对，算下来没得赚');
  cfg = c;
  save();
  closeSheet();
  render();
  applyScene();
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

// 页面回到前台时刷新；切走就停背景音，别在后台白耗电
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBGM();
  else { render(); renderMoon(); if (cfg.bgm !== 'off' && cfg.salary) startBGM(); }
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
addEventListener('pointerdown', () => { if (cfg.bgm !== 'off' && cfg.salary) startBGM(); }, { once: true });

applyScene();
render();
setInterval(render, 200);
renderMoon();
setInterval(renderMoon, 36e5);        // 月亮一小时才动得出肉眼可见的一点，别跟着 render 跑
if (!cfg.salary) setTimeout(openSheet, 600);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
