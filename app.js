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

// ── 音效（Web Audio 合成，无外部文件）────────────
let ac = null;
function knockSound() {
  if (!cfg.sound) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    const t = ac.currentTime;
    const jit = 0.94 + Math.random() * 0.12;

    // 木腔共鸣：快速下滑的三角波
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880 * jit, t);
    osc.frequency.exponentialRampToValueAtTime(300 * jit, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    osc.connect(g).connect(ac.destination);
    osc.start(t); osc.stop(t + 0.2);

    // 敲击瞬态：带通噪声
    const n = ac.createBufferSource();
    const buf = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / ch.length);
    n.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2100 * jit; bp.Q.value = 1.1;
    const ng = ac.createGain();
    ng.gain.setValueAtTime(0.35, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    n.connect(bp).connect(ng).connect(ac.destination);
    n.start(t);
  } catch { /* 音频不可用就静默 */ }
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

  const fish = $('fish');
  fish.classList.remove('hit');
  void fish.offsetWidth;
  fish.classList.add('hit');
  const halo = $('halo');
  halo.classList.add('hit');
  setTimeout(() => halo.classList.remove('hit'), 320);

  const amt = $('pendingNum').parentElement;
  amt.classList.add('zeroed');
  setTimeout(() => amt.classList.remove('zeroed'), 200);

  const f = document.createElement('div');
  f.className = 'float' + (p.amount >= ratePerSecond() * 1800 ? ' big' : '');
  f.textContent = p.amount > 0 ? `+¥${money(p.amount)}` : '功德 +0';
  f.style.left = (42 + Math.random() * 16) + '%';
  $('floats').appendChild(f);
  setTimeout(() => f.remove(), 1300);

  knockSound();
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
$('fish').addEventListener('click', knock);
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
    if (document.activeElement && /INPUT|BUTTON/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    knock();
  }
  if (e.code === 'Escape') closeSheet();
});

// 页面回到前台时立刻刷新（补上后台期间的累积）
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// ── 启动 ──────────────────────────────────────
render();
setInterval(render, 200);
if (!cfg.salary) setTimeout(openSheet, 600);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
