// 单文件 exe 入口：无参数 = GUI 模式；--worker = 下载内核模式
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const IS_WORKER = process.argv.includes('--worker');
let EXEDIR = process.env.GALLERY_BASE || path.dirname(process.execPath);
let ROOT = EXEDIR;
if (path.basename(EXEDIR).toLowerCase() === 'app') ROOT = path.dirname(EXEDIR);
const DATA = path.join(ROOT, 'data');
const LOGDIR = path.join(ROOT, 'logs');
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (e) {}
let DEST = path.join(ROOT, 'cosplay');
const PORT = 7799;

const CURL = 'C:\\Windows\\System32\\curl.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const STATUS = path.join(DATA, 'gui_status.json');
const DAILY = path.join(DATA, 'daily_quota.json');
const STATE = path.join(DATA, 'batch_state.json');
const CFG = path.join(DATA, 'manual_config.json');
const LOGF = path.join(LOGDIR, 'worker.log');
const GROUPS = path.join(DATA, 'coser_groups.json');
const PAGES = path.join(DATA, 'pages_all');
const STASH = path.join(DATA, 'stash_all');
const PICKLOG = path.join(LOGDIR, 'pick.log');
const MOVELOG = path.join(LOGDIR, 'move.log');
const PICKSTATE = path.join(DATA, 'pick_state.json');
const PICKRESULT = path.join(DATA, 'pick_result.txt');
const MOVEPROG = path.join(DATA, 'move_progress.json');
const LIBJSON = path.join(DATA, 'lib_stats.json');
const XDIR = path.join(ROOT, 'cosplay', '_X');
const XROOT = path.join(ROOT, 'X');
const VIDEODIR = path.join(XROOT, 'Video');
const GIFDIR = path.join(XROOT, 'GIF');
const PICTUREDIR = path.join(XROOT, 'Picture');

const WORKS = ['碧蓝档案', '蔚蓝档案', '碧蓝航线', 'NIKKE胜利女神妮姬', 'NIKKE胜利女神', 'Nikke胜利女神', '胜利女神妮姬',
  '鸣潮', '明日方舟', '原神', '崩坏学园2', '崩坏3rd', '崩坏三', '崩坏', 'FateGrandorder', 'FateGrand Order', 'FateGrandOrder',
  'Fate', '从零开始的异世界生活', '孤独摇滚', '守望先锋', '永劫无间', '交错战线', '洛天依', '巧克力与香子兰',
  '东方Project', '葬送的芙莉莲', '少女前线', 'Overlord', 'KAGUYANO', 'NIKKE', '绝区零', '崩坏星穹铁道', '星穹铁道', '王者荣耀', '英雄联盟', '碧蓝幻想'];

function loadJson(p, d) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } }
function saveJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 1)); } catch (e) {} }
function today() { return new Date().toLocaleDateString('sv-SE'); }
function clean(s) { return String(s).replace(/[\\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 50); }
function freeGB() { try { const st = fs.statfsSync('D:\\'); return +((st.bavail * st.bsize) / 1073741824).toFixed(1); } catch (e) { return 0; } }
function runCurl(a, ms) { return cp.spawnSync(CURL, a, { encoding: 'utf8', windowsHide: true, timeout: ms || 900000, maxBuffer: 20 * 1024 * 1024 }); }
function getArg(n, d) { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

function refreshDest() {
  try {
    const cfg = loadJson(CFG, {});
    const r = String(cfg.libraryRoot || '').trim();
    if (r) { try { fs.mkdirSync(r, { recursive: true }); } catch (e) {} DEST = r; }
    else DEST = path.join(ROOT, 'cosplay');
  } catch (e) {}
}
refreshDest();

function splitTitle(title, coser) {
  let t = String(title).replace(/&amp;/g, '&').trim();
  if (t.startsWith(coser)) t = t.slice(coser.length).trim();
  let work = '其他';
  for (const w of WORKS) { if (t.includes(w)) { work = w; t = t.replace(w, ' ').replace(/\s+/g, ' ').trim(); break; } }
  const role = t.replace(/^[\s\-_·:：]+/, '').replace(/[\s\-_·:：]+$/, '').trim() || '未分类';
  return { work: clean(work), role: clean(role) };
}

/* ============================ WORKER ============================ */
function runWorker() {
  try { fs.appendFileSync(path.join(ROOT, 'worker_boot.log'), new Date().toISOString() + '  boot argv=' + JSON.stringify(process.argv.slice(1)) + '\n'); } catch (e) {}
  const MINUTES = Math.max(1, parseFloat(getArg('minutes', '240')));
  const QUOTA_GB = Math.max(0.1, parseFloat(getArg('quota', '20')));
  const ONLY_COSER = String(getArg('coser', '') || '').trim();
  const TIME_BUDGET = MINUTES * 60000;
  const BATCH = 700;

  const state = loadJson(STATE, { coserIdx: 0, done: [] });
  const groups = loadJson(GROUPS, []);
  let daily = loadJson(DAILY, { date: today(), bytes: 0, images: 0 });
  if (daily.date !== today()) daily = { date: today(), bytes: 0, images: 0 };

  if (ONLY_COSER) {
    let idx = -1;
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].coser === ONLY_COSER || clean(groups[i].coser) === ONLY_COSER) { idx = i; break; }
    }
    if (idx < 0) {
      saveJson(STATUS, { running: false, error: '没找到这位 coser：' + ONLY_COSER, finishedAt: new Date().toISOString() });
      setTimeout(function () { process.exit(0); }, 300);
      return;
    }
    state.coserIdx = idx;
    saveJson(STATE, state);
  }

  const logLines = [];
  let bytesRun = 0, imgRun = 0, curDone = 0, curTotal = 0;

  function hhmmss() {
    const d = new Date();
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function out(msg) {
    const line = hhmmss() + '  ' + msg;
    logLines.push(line);
    if (logLines.length > 200) logLines.shift();
    try { fs.appendFileSync(LOGF, line + '\n'); } catch (e) {}
    push();
  }
  function push(patch) {
    const g = groups[state.coserIdx] || null;
    const body = Object.assign({
      running: true,
      startedAt: loadJson(STATUS, {}).startedAt || new Date().toISOString(),
      pid: process.pid,
      minutes: MINUTES,
      quotaGB: QUOTA_GB,
      coserIdx: state.coserIdx,
      coser: g ? g.coser : null,
      albumsLeft: g ? g.albums.length : 0,
      doneCount: state.done.length,
      totalCoser: groups.length,
      bytesToday: daily.bytes,
      imagesToday: daily.images,
      runBytes: bytesRun,
      runImages: imgRun,
      curDone: curDone,
      curTotal: curTotal,
      diskFreeGB: freeGB(),
      log: logLines.slice(-70)
    }, patch || {});
    saveJson(STATUS, body);
  }

  const quota = QUOTA_GB * 1073741824;
  const t0 = Date.now();
  fs.mkdirSync(PAGES, { recursive: true });
  fs.mkdirSync(STASH, { recursive: true });
  out('启动：最长 ' + MINUTES + ' 分钟 / 今日配额 ' + QUOTA_GB + ' GB' + (ONLY_COSER ? (' / 只下 ' + ONLY_COSER) : ''));

  try {
    while (state.coserIdx < groups.length) {
      if (daily.bytes >= quota) { out('今日配额已满，收工'); break; }
      if (Date.now() - t0 > TIME_BUDGET) { out('本轮时间到，收工'); break; }
      if (freeGB() < 40) { out('磁盘不足 40 GB，收工'); break; }

      const g = groups[state.coserIdx];
      const coserDir = clean(g.coser) || ('unknown_' + state.coserIdx);
      out('>>> [' + (state.coserIdx + 1) + '/' + groups.length + '] ' + coserDir + ' · ' + g.albums.length + ' 本');

      const conf = [];
      for (const it of g.albums) {
        const id = (it.url.match(/\/(\d+)\.html/) || [])[1];
        const p = path.join(PAGES, id + '.html');
        if (fs.existsSync(p) && fs.statSync(p).size > 3000) continue;
        conf.push('url = "' + it.url + '"');
        conf.push('output = "' + p.replace(/\\/g, '/') + '"');
      }
      if (conf.length) {
        const cf = path.join(ROOT, 'w_pages.conf');
        fs.writeFileSync(cf, conf.join('\n'));
        runCurl(['-K', cf, '-x', 'http://127.0.0.1:7890', '-k', '-s', '-L', '--max-time', '45',
          '--parallel', '--parallel-max', '5', '--retry', '2', '--retry-delay', '1',
          '-A', UA, '-H', 'Accept-Language: zh-CN,zh;q=0.9', '-H', 'Referer: https://www.hentaiclub.net/'], 400000);
        out('    页面抓取完成');
      }

      const tasks = [];
      for (const it of g.albums) {
        const id = (it.url.match(/\/(\d+)\.html/) || [])[1];
        const p = path.join(PAGES, id + '.html');
        if (!fs.existsSync(p)) continue;
        const h = fs.readFileSync(p, 'utf8');
        const imgs = [...new Set([...h.matchAll(/https:\/\/cdn\.sshs\.rip\/[a-z0-9\/]+\.webp/gi)].map((m) => m[0]))];
        if (!imgs.length) continue;
        const { work, role } = splitTitle(it.title, g.coser);
        const dstDir = path.join(DEST, coserDir, work, role);
        const tmpDir = path.join(STASH, id);
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}
        try { fs.mkdirSync(dstDir, { recursive: true }); } catch (e) {}
        imgs.forEach((u, i) => {
          const md5 = (u.split('/').pop() || '').replace(/[^\w.]/g, '');
          const name = String(i + 1).padStart(4, '0') + '_' + md5;
          tasks.push({ u, dst: path.join(dstDir, name), tmp: path.join(tmpDir, name) });
        });
      }

      for (const t of tasks) {
        try {
          if (fs.existsSync(t.tmp) && !(fs.existsSync(t.dst) && fs.statSync(t.dst).size > 2000)) {
            fs.mkdirSync(path.dirname(t.dst), { recursive: true });
            fs.renameSync(t.tmp, t.dst);
          }
        } catch (e) {}
      }
      const pending = tasks.filter((t) => !(fs.existsSync(t.dst) && fs.statSync(t.dst).size > 2000));
      curTotal = pending.length;
      curDone = 0;
      out('    共 ' + tasks.length + ' 张，待下 ' + pending.length + ' 张');

      let i = 0;
      while (i < pending.length) {
        if (Date.now() - t0 > TIME_BUDGET) break;
        if (daily.bytes >= quota) break;
        const slice = pending.slice(i, i + BATCH);
        const c = [];
        for (const t of slice) { c.push('url = "' + t.u + '"'); c.push('output = "' + t.tmp.replace(/\\/g, '/') + '"'); }
        const cf = path.join(ROOT, 'w_dl.conf');
        fs.writeFileSync(cf, c.join('\n'));
        runCurl(['-K', cf, '-x', 'http://127.0.0.1:7890', '-k', '-s', '-L', '--max-time', '35',
          '--parallel', '--parallel-max', '14', '--retry', '1', '--retry-delay', '1',
          '-A', UA, '-H', 'Referer: https://www.hentaiclub.net/'], 500000);
        let addB = 0, addN = 0;
        for (const t of slice) {
          try { if (fs.existsSync(t.tmp) && fs.statSync(t.tmp).size > 2000) { addB += fs.statSync(t.tmp).size; addN++; } } catch (e) {}
        }
        bytesRun += addB; imgRun += addN;
        daily.bytes += addB; daily.images += addN;
        saveJson(DAILY, daily);
        i += slice.length;
        curDone = i;
        out('    ' + i + '/' + pending.length + ' 张 │ 本轮 +' + (bytesRun / 1073741824).toFixed(2) + ' GB │ 今日 ' + (daily.bytes / 1073741824).toFixed(2) + ' GB');
      }

      let moved = 0;
      for (const t of tasks) {
        try {
          if (fs.existsSync(t.tmp) && !(fs.existsSync(t.dst) && fs.statSync(t.dst).size > 2000)) {
            fs.mkdirSync(path.dirname(t.dst), { recursive: true });
            fs.renameSync(t.tmp, t.dst); moved++;
          }
        } catch (e) {}
      }
      const left = tasks.filter((t) => !(fs.existsSync(t.dst) && fs.statSync(t.dst).size > 2000));
      if (left.length === 0) {
        state.done.push(coserDir);
        state.coserIdx++;
        saveJson(STATE, state);
        out('    ✓ ' + coserDir + ' 完成（搬入 ' + moved + ' 张）');
        if (ONLY_COSER) break;
      } else {
        out('    搬入 ' + moved + ' 张，还剩 ' + left.length + ' 张，下次继续');
        saveJson(STATE, state);
        break;
      }
    }
    out('已停止');
    push({ running: false, finishedAt: new Date().toISOString() });
  } catch (e) {
    out('出错：' + String(e).slice(0, 200));
    push({ running: false, error: String(e).slice(0, 300), finishedAt: new Date().toISOString() });
  }
  setTimeout(() => process.exit(0), 300);
}

/* ============================= GUI ============================= */
function runGui() {
  let worker = null;
  let libCache = { images: 0, bytes: 0, at: 0 };

  process.on('uncaughtException', function (e) {
    try {
      fs.appendFileSync(path.join(LOGDIR, 'crash.log'), new Date().toISOString() + '  ' + String((e && e.stack) || e).slice(0, 600) + '\n');
    } catch (x) {}
  });
  process.on('unhandledRejection', function (e) {
    try {
      fs.appendFileSync(path.join(LOGDIR, 'crash.log'), new Date().toISOString() + '  REJECT ' + String(e).slice(0, 300) + '\n');
    } catch (x) {}
  });

  let pidCache = { pid: 0, alive: false, at: 0 };
  function pidAlive(pid) {
    if (!pid) return false;
    if (pidCache.pid === pid && Date.now() - pidCache.at < 5000) return pidCache.alive;
    try {
      const r = cp.spawnSync('C:\\Windows\\System32\\tasklist.exe', ['/FI', 'PID eq ' + pid], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const alive = String(r.stdout || '').includes(String(pid));
      pidCache = { pid: pid, alive: alive, at: Date.now() };
      return alive;
    } catch (e) { return false; }
  }

  let libStats = { images: 0, bytes: 0, at: 0, busy: false };
  try {
    const cached = loadJson(LIBJSON, null);
    if (cached && cached.images >= 0) libStats = { images: cached.images, bytes: cached.bytes || 0, at: 0, busy: false };
  } catch (e) {}

  function queueLibRefresh() {
    if (libStats.busy) return;
    if (Date.now() - libStats.at < 600000) return;
    libStats.busy = true;
    const dirs = [DEST];
    let n = 0, b = 0;
    function step() {
      const d = dirs.pop();
      if (!d) {
        libStats = { images: n, bytes: b, at: Date.now(), busy: false };
        try { fs.writeFileSync(LIBJSON, JSON.stringify({ images: n, bytes: b })); } catch (e) {}
        return;
      }
      try {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) dirs.push(p);
          else { n++; try { b += fs.statSync(p).size; } catch (x) {} }
        }
      } catch (x) {}
      setImmediate(step);
    }
    setImmediate(step);
  }

  function status() {
    const st = loadJson(STATUS, {});
    const dl = loadJson(DAILY, { date: today(), bytes: 0, images: 0 });
    const cfg = loadJson(CFG, { quotaGB: 20, minutes: 10 });
    const state = loadJson(STATE, { coserIdx: 0, done: [] });
    const groups = loadJson(GROUPS, []);
    const g = groups[state.coserIdx] || null;
    const running = !!(st.running && (worker || pidAlive(st.pid)));
    queueLibRefresh();
    const lib = libStats;
    return {
      running,
      quotaGB: cfg.quotaGB || 20,
      minutes: cfg.minutes || 10,
      libraryRoot: cfg.libraryRoot || DEST,
      drives: (function () {
        const a = [];
        for (let i = 67; i <= 90; i++) {
          const d = String.fromCharCode(i) + ':\\';
          try { fs.accessSync(d); a.push(d); } catch (e) {}
        }
        return a;
      })(),
      bytesToday: dl.date === today() ? dl.bytes : 0,
      imagesToday: dl.date === today() ? dl.images : 0,
      doneCount: state.done.length,
      coserIdx: state.coserIdx,
      coser: st.coser || (g ? g.coser : null),
      albumsLeft: st.albumsLeft || (g ? g.albums.length : 0),
      runBytes: st.runBytes || 0,
      curDone: st.curDone || 0,
      curTotal: st.curTotal || 0,
      totalCoser: groups.length,
      libImages: lib.images,
      libGB: +(lib.bytes / 1073741824).toFixed(2),
      diskFreeGB: freeGB(),
      log: (st.log || []).slice(-60),
      startedAt: st.startedAt || null
    };
  }

  function safeJoin(rel) {
    const cleaned = String(rel || '').replace(/\.\./g, '').replace(/^[\\\/]+/, '');
    const p = path.normalize(path.join(DEST, cleaned));
    if (p !== DEST && !p.startsWith(DEST + path.sep)) return null;
    return p;
  }

  let treeCache = { at: 0, data: null };
  function galleryTree() {
    if (treeCache.data && Date.now() - treeCache.at < 120000) return treeCache.data;
    const out = [];
    try {
      for (const c of fs.readdirSync(DEST, { withFileTypes: true })) {
        if (!c.isDirectory()) continue;
        const cdir = path.join(DEST, c.name);
        const works = [];
        for (const w of fs.readdirSync(cdir, { withFileTypes: true })) {
          if (!w.isDirectory()) continue;
          const wdir = path.join(cdir, w.name);
          const roles = [];
          for (const r of fs.readdirSync(wdir, { withFileTypes: true })) {
            if (!r.isDirectory()) continue;
            let n = 0;
            try { n = fs.readdirSync(path.join(wdir, r.name)).length; } catch (e) {}
            roles.push({ name: r.name, count: n });
          }
          works.push({ name: w.name, roles });
        }
        out.push({ name: c.name, works });
      }
    } catch (e) {}
    treeCache = { at: Date.now(), data: out };
    return out;
  }

  const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Gentleman Gallery</title>
<style>

*{box-sizing:border-box}
:root{--bg:#0E1A2B;--bg2:#112035;--card:#16263D;--card2:#112035;--track:#1B3049;--line:#2A4460;--line2:#3E6288;--p1:#5FB6D9;--p2:#A0E7F3;--main:#7EC8E3;--gold:#E8C87A;--fg:#EAF4FA;--fg2:#8FA9C0;--fg3:#6E8CA8;--danger:#FB7185;--shadow:rgba(0,0,0,.42);--glow:rgba(126,200,227,.5)}
body[data-theme="ganyu"]{--bg:#0E1A2B;--bg2:#112035;--card:#16263D;--card2:#112035;--track:#1B3049;--line:#2A4460;--line2:#3E6288;--p1:#5FB6D9;--p2:#A0E7F3;--main:#7EC8E3;--gold:#E8C87A;--fg:#EAF4FA;--fg2:#8FA9C0;--fg3:#6E8CA8;--danger:#FB7185;--shadow:rgba(0,0,0,.42);--glow:rgba(126,200,227,.5)--glass:rgba(22,38,61,0.05);--gline:rgba(160,231,243,.16);--gshine:rgba(160,231,243,.30);}
body[data-theme="yae"]{--bg:#1A0E1F;--bg2:#150A1A;--card:#2A1533;--card2:#1F0F27;--track:#361E42;--line:#4A2A5C;--line2:#6B3F85;--p1:#C264D8;--p2:#F0A6F5;--main:#D98BE8;--gold:#E8C87A;--fg:#F7ECFA;--fg2:#B89CC6;--fg3:#8E6FA0;--danger:#FB7185;--shadow:rgba(0,0,0,.45);--glow:rgba(217,139,232,.5)--glass:rgba(42,21,51,0.05);--gline:rgba(240,166,245,.16);--gshine:rgba(240,166,245,.30);}
body[data-theme="yoimiya"]{--bg:#1F1208;--bg2:#180D05;--card:#2E1D10;--card2:#241509;--track:#3D2716;--line:#54351F;--line2:#75502F;--p1:#E8892B;--p2:#FFC46B;--main:#F5A623;--gold:#FFD98E;--fg:#FFF6E8;--fg2:#C4A882;--fg3:#9A7A55;--danger:#FB7185;--shadow:rgba(0,0,0,.45);--glow:rgba(245,166,35,.5)--glass:rgba(46,29,16,0.05);--gline:rgba(255,196,107,.16);--gshine:rgba(255,196,107,.30);}
body[data-theme="nahida"]{--bg:#0C1A14;--bg2:#081410;--card:#13291F;--card2:#0E2018;--track:#1B3829;--line:#26503B;--line2:#397A57;--p1:#5FCFA0;--p2:#A6F0C8;--main:#7ED9B4;--gold:#E8C87A;--fg:#EAFAF2;--fg2:#8FB8A4;--fg3:#5F8570;--danger:#FB7185;--shadow:rgba(0,0,0,.42);--glow:rgba(126,217,180,.5)--glass:rgba(19,41,31,0.05);--gline:rgba(166,240,200,.16);--gshine:rgba(166,240,200,.30);}
body[data-theme="furina"]{--bg:#0D1524;--bg2:#0A1020;--card:#172238;--card2:#111A2C;--track:#1F2E48;--line:#2E4060;--line2:#4A6390;--p1:#7FB0E8;--p2:#B8DCF7;--main:#9CC9F0;--gold:#D8DEE9;--fg:#F0F6FC;--fg2:#93A8C4;--fg3:#6A7F9E;--danger:#FB7185;--shadow:rgba(0,0,0,.42);--glow:rgba(156,201,240,.5)--glass:rgba(23,34,56,0.05);--gline:rgba(184,220,247,.16);--gshine:rgba(184,220,247,.30);}
body[data-theme="faruzan"]{--bg:#09181A;--bg2:#061214;--card:#12262A;--card2:#0D1E21;--track:#1A3438;--line:#25464A;--line2:#3A6E74;--p1:#4FBFB0;--p2:#8FE8DC;--main:#64D0C2;--gold:#D4B45A;--fg:#E8FAF8;--fg2:#8DB8B2;--fg3:#5F8782;--danger:#FB7185;--shadow:rgba(0,0,0,.45);--glow:rgba(100,208,194,.5)--glass:rgba(18,38,42,0.05);--gline:rgba(143,232,220,.16);--gshine:rgba(143,232,220,.30);}
body[data-theme="zhongli"]{--bg:#1A1206;--bg2:#140E04;--card:#2A1E0E;--card2:#20160A;--track:#382816;--line:#4E3820;--line2:#6E5030;--p1:#C99539;--p2:#E8C87A;--main:#D4A94C;--gold:#F0D48E;--fg:#FBF4E6;--fg2:#BFA680;--fg3:#8E7550;--danger:#FB7185;--shadow:rgba(0,0,0,.45);--glow:rgba(212,169,76,.5)--glass:rgba(42,30,14,0.05);--gline:rgba(240,212,142,.16);--gshine:rgba(240,212,142,.30);}
body[data-theme="elaina"]{--bg:#17141F;--bg2:#12101A;--card:#221D2E;--card2:#1A1626;--track:#2C2640;--line:#3E3459;--line2:#5A4C7E;--p1:#9B8FB5;--p2:#E8E0F5;--main:#B8A8D8;--gold:#E8E0F5;--fg:#F2EEF8;--fg2:#A89BC0;--fg3:#7A6E96;--danger:#E88BA8;--shadow:rgba(0,0,0,.5);--glow:rgba(184,168,216,.42);--glass:rgba(23,20,31,0.14);--gline:rgba(184,168,216,.22);--gshine:rgba(232,224,245,.16)}

body[data-theme="paper"]{--bg:#F4F2EF;--bg2:#EFECE7;--card:#FFFFFF;--card2:#FAF8F5;--track:#ECEAE5;--line:#E6E3DE;--line2:#DCD8D0;--p1:#8A8880;--p2:#1C1B19;--main:#1C1B19;--gold:#8A8880;--fg:#1C1B19;--fg2:#4A4944;--fg3:#8A8880;--danger:#8A3B2A;--shadow:rgba(0,0,0,.08);--glow:rgba(28,27,25,.18);--glass:rgba(255,255,255,0.05);--gline:rgba(28,27,25,.10);--gshine:rgba(255,255,255,.6)}
body[data-theme="darkroom"]{--bg:#000000;--bg2:#050505;--card:#0C0C0C;--card2:#090909;--track:#18181B;--line:#3F3F46;--line2:#52525B;--p1:#71717A;--p2:#FAFAFA;--main:#FAFAFA;--gold:#A1A1AA;--fg:#FAFAFA;--fg2:#A1A1AA;--fg3:#71717A;--danger:#EF4444;--shadow:rgba(0,0,0,.6);--glow:rgba(250,250,250,.18);--glass:rgba(12,12,12,0.05);--gline:rgba(250,250,250,.12);--gshine:rgba(250,250,250,.16)}
body[data-theme="agency"]{--bg:#FDF2F8;--bg2:#FAE8F4;--card:#FFFFFF;--card2:#FEF8FC;--track:#F1EEF5;--line:#FBCFE8;--line2:#F9A8D4;--p1:#F472B6;--p2:#EC4899;--main:#EC4899;--gold:#0891B2;--fg:#831843;--fg2:#475569;--fg3:#9D174D;--danger:#DC2626;--shadow:rgba(131,24,67,.10);--glow:rgba(236,72,153,.24);--glass:rgba(255,255,255,0.05);--gline:rgba(236,72,153,.18);--gshine:rgba(255,255,255,.62)}
body[data-theme="saas"]{--bg:#F8FAFC;--bg2:#F1F5F9;--card:#FFFFFF;--card2:#FBFDFF;--track:#E9EFF8;--line:#E2E8F0;--line2:#CBD5E1;--p1:#3B82F6;--p2:#2563EB;--main:#2563EB;--gold:#EA580C;--fg:#1E293B;--fg2:#475569;--fg3:#64748B;--danger:#DC2626;--shadow:rgba(30,41,59,.08);--glow:rgba(37,99,235,.22);--glass:rgba(255,255,255,0.05);--gline:rgba(37,99,235,.14);--gshine:rgba(255,255,255,.6)}
body[data-theme="social"]{--bg:#FFF1F2;--bg2:#FFE4E6;--card:#FFFFFF;--card2:#FFF7F8;--track:#F0ECF2;--line:#FECDD3;--line2:#FDA4AF;--p1:#FB7185;--p2:#E11D48;--main:#E11D48;--gold:#2563EB;--fg:#881337;--fg2:#475569;--fg3:#9F1239;--danger:#DC2626;--shadow:rgba(136,19,55,.10);--glow:rgba(225,29,72,.24);--glass:rgba(255,255,255,0.05);--gline:rgba(225,29,72,.16);--gshine:rgba(255,255,255,.62)}
body[data-theme="silicon"]{--bg:#0F0A14;--bg2:#0A0710;--card:#1A1026;--card2:#160C22;--track:#241833;--line:#3B2A52;--line2:#5B4079;--p1:#C084FC;--p2:#818CF8;--main:#C084FC;--gold:#F0ABFC;--fg:#F5F3FF;--fg2:#C4B5FD;--fg3:#8B7BA8;--danger:#FB7185;--shadow:rgba(0,0,0,.55);--glow:rgba(192,132,252,.42);--glass:rgba(26,16,38,0.05);--gline:rgba(192,132,252,.24);--gshine:rgba(240,171,252,.18)}
body[data-theme="wallet"]{--bg:#1A192E;--bg2:#15142A;--card:#21203B;--card2:#1A192E;--track:#2F2745;--line:#362F54;--line2:#3F375F;--p1:#7985FF;--p2:#6AD8FD;--main:#7985FF;--gold:#D489FF;--fg:#F0F0F0;--fg2:#A9A3C4;--fg3:#6B5A96;--danger:#FB7185;--shadow:rgba(0,0,0,.45);--glow:rgba(121,133,255,.42);--glass:rgba(33,32,59,0.05);--gline:rgba(121,133,255,.22);--gshine:rgba(106,216,253,.16)}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;transition:background .25s}
body #gg-wall{position:fixed;inset:0;z-index:0;background-size:cover;background-position:center;opacity:.34;filter:saturate(1.08);pointer-events:none;transition:opacity .5s}
body::before{content:"";position:fixed;inset:-20%;z-index:1;background:
radial-gradient(48% 42% at 18% 12%,var(--gshine),transparent 62%),
radial-gradient(42% 38% at 82% 22%,var(--gline),transparent 66%),
radial-gradient(52% 46% at 50% 92%,var(--gshine),transparent 70%),transparent;filter:saturate(1.05);animation:ggDrift 26s ease-in-out infinite alternate}
body::after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.5;background:
radial-gradient(circle at 22% 28%,rgba(255,255,255,.05),transparent 40%),
radial-gradient(circle at 78% 70%,rgba(255,255,255,.04),transparent 42%)}
@keyframes ggDrift{0%{transform:translate3d(-1.5%,-1%,0) scale(1.02)}100%{transform:translate3d(1.5%,1%,0) scale(1.06)}}

#ei-portrait-line{opacity:0;
  -webkit-mask-image:linear-gradient(115deg,transparent 0%,#000 22%,#000 78%,transparent 100%);
  mask-image:linear-gradient(115deg,transparent 0%,#000 22%,#000 78%,transparent 100%);
  -webkit-mask-size:300% 100%;mask-size:300% 100%;
  -webkit-mask-position:100% 0;mask-position:100% 0;
  filter:drop-shadow(0 0 8px rgba(160,231,243,.9)) drop-shadow(0 0 20px rgba(184,168,216,.7));
  animation:eiLineIn 2.6s cubic-bezier(.4,0,.2,1) .15s forwards}
@keyframes eiLineIn{
  0%{opacity:0;-webkit-mask-position:130% 0;mask-position:130% 0}
  12%{opacity:1}
  72%{opacity:1;-webkit-mask-position:0% 0;mask-position:0% 0}
  88%{opacity:1}
  100%{opacity:0;-webkit-mask-position:0% 0;mask-position:0% 0}
}
.ei-stack{position:absolute;z-index:3;left:50%;top:50%;width:min(52vh,52vw);height:min(52vh,52vw);transform:translate(-50%,-50%);opacity:1}
.ei-stack img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain}
#ei-portrait-open{opacity:0}
#ei-portrait{opacity:1}
@keyframes eiStackIn{0%{opacity:0;filter:brightness(0) invert(1)}70%{opacity:1;filter:brightness(0) invert(1)}100%{opacity:1;filter:none}}

@keyframes eiEdgeShow{0%{opacity:0}40%{opacity:1}78%{opacity:1}100%{opacity:.55}}
#ei-portrait-open{display:none}
#ei-portrait{opacity:0;animation:eiColorIn 1.5s ease 2.05s forwards}
@keyframes eiBlinkOpen{0%,88%{opacity:0}88.01%,96%{opacity:1}96.01%,100%{opacity:0}}
@keyframes eiBlinkClose{0%,88%{opacity:1}88.01%,96%{opacity:0}96.01%,100%{opacity:1}}
.ei-sweep{position:absolute;z-index:4;left:50%;top:50%;width:min(78vh,78vw);height:min(78vh,78vw);transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;opacity:0;
  background:conic-gradient(from 0deg,transparent 0deg,rgba(160,231,243,0) 18deg,rgba(160,231,243,.85) 40deg,rgba(255,255,255,1) 46deg,rgba(184,168,216,.75) 54deg,rgba(160,231,243,0) 76deg,transparent 360deg);
  mix-blend-mode:screen;filter:blur(.4px);
  animation:eiSweep2 3.2s linear .6s forwards}
@keyframes eiSweep2{
  0%{opacity:0;transform:translate(-50%,-50%) rotate(-60deg)}
  10%{opacity:1}
  85%{opacity:.95}
  100%{opacity:0;transform:translate(-50%,-50%) rotate(300deg)}
}
#ei-portrait-OLD{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;
  transform:translate(-50%,-50%);
  opacity:0;
  animation:eiNeonFade 1.5s ease 0.2s forwards, eiColorize 1.5s ease 2.05s forwards}
@keyframes eiNeonFade{
  0%{opacity:0;filter:brightness(0) invert(1) drop-shadow(0 0 6px #A0E7F3)}
  55%{opacity:1;filter:brightness(0) invert(1) drop-shadow(0 0 22px #A0E7F3) drop-shadow(0 0 46px rgba(184,168,216,.8))}
  100%{opacity:1;filter:brightness(0) invert(1) drop-shadow(0 0 30px #A0E7F3) drop-shadow(0 0 68px rgba(184,168,216,.9))}
}
@keyframes eiColorize{
  0%{filter:brightness(0) invert(1) drop-shadow(0 0 30px #A0E7F3) drop-shadow(0 0 68px rgba(184,168,216,.9))}
  35%{filter:brightness(.75) saturate(1.5) drop-shadow(0 0 26px rgba(160,231,243,.8))}
  100%{filter:none}
}
.ei-sweep{position:absolute;z-index:4;left:50%;top:50%;width:min(74vh,74vw);height:min(74vh,74vw);transform:translate(-50%,-50%);border-radius:50%;pointer-events:none;opacity:0;
  background:conic-gradient(from 0deg,transparent 0deg,rgba(160,231,243,0) 26deg,rgba(160,231,243,.75) 48deg,rgba(232,224,245,.95) 56deg,rgba(184,168,216,.7) 66deg,transparent 96deg,transparent 360deg);
  mix-blend-mode:screen;
  animation:eiSweep 2.2s cubic-bezier(.4,0,.2,1) 1.15s forwards}
@keyframes eiSweep{
  0%{opacity:0;transform:translate(-50%,-50%) rotate(-40deg) scale(.86)}
  18%{opacity:.95}
  78%{opacity:.85}
  100%{opacity:0;transform:translate(-50%,-50%) rotate(340deg) scale(1.12)}
}
#gg-elaina-intro::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;opacity:0;
  background:radial-gradient(circle at 50% 50%,rgba(160,231,243,.22),transparent 55%);
  animation:eiFlash 1.6s ease 1.35s forwards}
@keyframes eiFlash{0%{opacity:0}26%{opacity:1}100%{opacity:0}}
.ei-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;background:#06060A}
#gg-elaina-intro.has-video .ei-sky,#gg-elaina-intro.has-video .ei-stars,#gg-elaina-intro.has-video .ei-circle,#gg-elaina-intro.has-video .ei-sweep,#gg-elaina-intro.has-video .ei-stack,#gg-elaina-intro.has-video .ei-name,#gg-elaina-intro.has-video .ei-sub{display:none}
#gg-elaina-intro{position:fixed;inset:0;z-index:99999;display:none;align-items:center;justify-content:center;background:#0B0812;overflow:hidden;cursor:pointer}
#gg-elaina-intro.on{display:flex}
.ei-sky{position:absolute;inset:0;background:radial-gradient(60% 50% at 50% 40%,rgba(90,76,126,.42),transparent 70%),radial-gradient(40% 30% at 70% 70%,rgba(184,168,216,.18),transparent 70%),#0B0812}
.ei-stars{position:absolute;inset:0}
.ei-stars i{position:absolute;display:block;width:2px;height:2px;border-radius:50%;background:#E8E0F5;opacity:0;animation:eiTwinkle 2.6s ease-in-out infinite}
@keyframes eiTwinkle{0%,100%{opacity:0;transform:scale(.6)}50%{opacity:.9;transform:scale(1.4)}}
.ei-circle{width:min(76vh,76vw);height:min(76vh,76vw);position:relative;z-index:2;filter:drop-shadow(0 0 22px rgba(184,168,216,.35))}
#eiRing1{transform-origin:200px 200px;animation:eiSpin 22s linear infinite}
#eiRing2{transform-origin:200px 200px;animation:eiSpinRev 34s linear infinite}
#eiRunes{transform-origin:200px 200px;animation:eiPulse 3.2s ease-in-out infinite}
#eiHat{opacity:0;animation:eiFadeUp 1.2s cubic-bezier(.22,1,.36,1) .25s forwards}
#eiWand{opacity:0;animation:eiFadeUp 1s cubic-bezier(.22,1,.36,1) .55s forwards}
@keyframes eiSpin{to{transform:rotate(360deg)}}
@keyframes eiSpinRev{to{transform:rotate(-360deg)}}
@keyframes eiPulse{0%,100%{opacity:.35}50%{opacity:.95}}
@keyframes eiFadeUp{0%{opacity:0;transform:translateY(14px)}100%{opacity:1;transform:translateY(0)}}
.ei-name{position:absolute;z-index:4;bottom:13%;left:0;right:0;text-align:center;font-size:clamp(26px,4.4vw,52px);letter-spacing:.44em;font-weight:300;color:#F2EEF8;text-shadow:0 0 30px rgba(184,168,216,.65);opacity:0;animation:eiFadeUp 1.1s ease .85s forwards;font-family:'Lanxi-鱼尾行书',serif}
.ei-sub{position:absolute;z-index:4;bottom:8%;left:0;right:0;text-align:center;font-size:clamp(9px,1.1vw,13px);letter-spacing:.7em;color:rgba(232,224,245,.68);opacity:0;animation:eiFadeUp 1.1s ease 1.15s forwards}
.ei-tip{position:absolute;z-index:4;bottom:20px;left:0;right:0;text-align:center;font-size:10px;letter-spacing:.3em;color:rgba(232,224,245,.32)}
#gg-elaina-intro.out{animation:eiOut .8s ease forwards}
@keyframes eiOut{to{opacity:0;visibility:hidden}}

#gg-intro{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--bg);animation:ggFadeOut .9s ease 1.5s forwards;pointer-events:none}
#gg-intro svg{width:170px;height:170px;color:var(--main);filter:drop-shadow(0 0 22px var(--glow))}
#gg-intro-crystal{transform-origin:100px 100px;transform-box:fill-box;animation:ggSpin 1.8s cubic-bezier(.22,1,.36,1) forwards;animation-delay:.1s}
#gg-intro-name{margin-top:18px;font-size:10.5px;letter-spacing:.5em;color:var(--main);opacity:0;animation:ggNameIn .9s ease .5s forwards}
@keyframes ggSpin{0%{transform:scale(.25) rotate(-25deg);opacity:0}55%{opacity:1}100%{transform:scale(1) rotate(0deg);opacity:1}}
@keyframes ggNameIn{to{opacity:.85}}
@keyframes ggFadeOut{to{opacity:0;visibility:hidden}}
.crest{display:flex;justify-content:center;padding:4px 0 10px;color:var(--main);opacity:.85}
.crest svg{width:38px;height:38px;filter:drop-shadow(0 0 10px var(--glow))}
@media(prefers-reduced-motion:reduce){#gg-intro{animation:none;display:none}#gg-intro-crystal{animation:none}}
.wrap{max-width:920px;margin:0 auto;padding:28px 22px 40px;position:relative;z-index:3}
.hd{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--line);padding-bottom:12px}
.hd h1{font-size:22px;margin:0;font-weight:600;letter-spacing:.02em;background:linear-gradient(90deg,var(--p2),var(--main),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent}
.hd .st{font-size:12px;letter-spacing:.16em;color:var(--main)}
.bar{margin-top:22px;background:var(--glass);border:1px solid var(--gline);border-radius:18px;padding:20px 22px;box-shadow:0 10px 34px var(--shadow),inset 0 1px 0 var(--gshine);backdrop-filter:blur(1px) saturate(1.02);-webkit-backdrop-filter:blur(1px) saturate(1.02)}
.bar .row{display:flex;justify-content:space-between;font-size:13px;color:var(--fg2)}
.bar .big{font-size:28px;font-weight:600;letter-spacing:-.01em;margin:6px 0 12px;color:var(--fg)}
.track{height:12px;background:var(--track);border-radius:99px;overflow:hidden}
.fill{height:100%;width:0;background:linear-gradient(90deg,var(--p1),var(--p2));border-radius:99px;transition:width .5s ease;box-shadow:0 0 15px var(--glow)}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}
.card{background:var(--glass);border:1px solid var(--gline);border-radius:16px;padding:14px 16px;box-shadow:0 8px 24px var(--shadow),inset 0 1px 0 var(--gshine);backdrop-filter:blur(1px) saturate(1.02);-webkit-backdrop-filter:blur(1px) saturate(1.02);transition:.2s}
.card:hover{border-color:var(--line2);box-shadow:0 8px 26px var(--glow)}
.card .k{font-size:11px;letter-spacing:.1em;color:var(--gold)}
.card .v{font-size:19px;font-weight:600;margin-top:6px;letter-spacing:-.01em;color:var(--fg)}
.ctrl{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button{border:0;border-radius:99px;padding:11px 24px;font-size:13px;cursor:pointer;font-family:inherit;transition:.2s}
.primary{background:linear-gradient(135deg,var(--main),var(--p2));color:#08202F;font-weight:700;box-shadow:0 6px 22px var(--glow)}
.primary:hover{filter:brightness(1.08)}
.ghost{background:var(--track);color:var(--fg);border:1px solid var(--line)}
.ghost:hover{border-color:var(--main);box-shadow:0 0 16px var(--glow)}
.danger{background:rgba(60,30,40,.5);color:var(--danger);border:1px solid rgba(251,113,133,.35)}
button:disabled{opacity:.35;cursor:default}
.set{margin-top:14px;display:flex;gap:16px;align-items:center;font-size:13px;color:var(--fg2);flex-wrap:wrap}
textarea,.ta{width:100%;box-sizing:border-box;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:9px 11px;font-family:inherit;font-size:12px;resize:vertical;outline:none}
textarea:focus,.ta:focus{border-color:var(--main);box-shadow:0 0 0 3px var(--glow)}
textarea::placeholder,.ta::placeholder{color:var(--fg3)}
.set input,.set select{width:80px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:9px;padding:7px 10px;font-family:inherit;font-size:13px;outline:none}
.set select{width:auto;cursor:pointer}
.set input:focus,.set select:focus{border-color:var(--main);box-shadow:0 0 0 3px var(--glow)}
.log{margin-top:18px;background:var(--glass);border:1px solid var(--gline);border-radius:16px;padding:14px 16px;backdrop-filter:blur(1px) saturate(1.02);-webkit-backdrop-filter:blur(1px) saturate(1.02)}
.log h3{margin:0 0 8px;font-size:11px;letter-spacing:.14em;color:var(--gold);font-weight:600}
.log pre{margin:0;max-height:300px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.7;color:var(--fg2);white-space:pre-wrap}
.tag{display:inline-block;font-size:11px;padding:2px 9px;border-radius:99px;background:var(--track);color:var(--fg2);margin-left:8px}
.tag.on{background:linear-gradient(135deg,var(--main),var(--p2));color:#08202F;font-weight:700}
.tabs{display:none}
.tab{border:1px solid var(--line);background:var(--track);color:var(--fg2);border-radius:99px;padding:8px 20px;font-size:13px;cursor:pointer;font-family:inherit;transition:.2s}
.tab:hover{border-color:var(--main);color:var(--fg)}
.tab.act{background:linear-gradient(135deg,var(--main),var(--p2));color:#08202F;border-color:transparent;font-weight:700;box-shadow:0 4px 16px var(--glow)}
.gal{display:grid;grid-template-columns:230px 1fr;gap:14px;margin-top:16px}
.side{background:var(--glass);border:1px solid var(--gline);border-radius:16px;padding:10px;max-height:640px;overflow:auto;font-size:12.5px;box-shadow:0 8px 24px var(--shadow),inset 0 1px 0 var(--gshine);backdrop-filter:blur(1px) saturate(1.02);-webkit-backdrop-filter:blur(1px) saturate(1.02)}
.coser{padding:7px 9px;border-radius:9px;cursor:pointer;color:var(--fg);display:flex;justify-content:space-between;gap:6px;transition:.15s}
.coser:hover{background:var(--track)}
.coser.sel{background:linear-gradient(135deg,var(--main),var(--p2));color:#08202F;font-weight:600}
.cmeta{display:flex;align-items:center;gap:7px;color:var(--gold)}
.dl{display:inline-block;width:18px;height:18px;line-height:17px;text-align:center;border-radius:50%;background:var(--track);color:var(--fg);font-size:11px;cursor:pointer;font-weight:400}
.dl:hover{background:linear-gradient(135deg,var(--main),var(--p2));color:#08202F}
.coser.sel .dl{background:rgba(0,0,0,.22);color:#08202F}
.work{padding:5px 9px 5px 22px;color:var(--fg2);cursor:pointer;border-radius:8px;font-size:12px}
.work:hover{background:var(--track)}
.role{padding:4px 9px 4px 34px;color:var(--fg3);cursor:pointer;border-radius:8px;font-size:11.5px}
.role:hover{background:var(--track);color:var(--p2)}
.role.sel{color:#08202F;background:linear-gradient(135deg,var(--main),var(--p2));font-weight:600}
.main{background:var(--glass);border:1px solid var(--gline);border-radius:16px;padding:14px;min-height:420px;box-shadow:0 8px 24px var(--shadow),inset 0 1px 0 var(--gshine);backdrop-filter:blur(1px) saturate(1.02);-webkit-backdrop-filter:blur(1px) saturate(1.02)}
.crumb{font-size:12px;color:var(--fg2);margin-bottom:10px;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}
.cell{aspect-ratio:3/4;background:var(--track);border-radius:11px;overflow:hidden;cursor:zoom-in;border:1px solid var(--line);transition:.2s}
.cell:hover{border-color:var(--main);box-shadow:0 0 20px var(--glow)}
.cell img{width:100%;height:100%;object-fit:cover;display:block}
.pager{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:14px;font-size:12px;color:var(--fg2)}
.modal{position:fixed;inset:0;background:rgba(4,8,14,.96);display:none;align-items:center;justify-content:center;z-index:99;cursor:zoom-out;padding:24px}
.modal.on{display:flex}
.modal img{max-width:94vw;max-height:92vh;border-radius:12px;box-shadow:0 20px 70px var(--glow)}
.empty{color:var(--main);font-size:12.5px;padding:26px 6px;text-align:center}
.mnav{position:absolute;top:50%;margin-top:-23px;width:46px;height:46px;border-radius:50%;background:rgba(255,255,255,.14);border:1px solid var(--main);color:var(--fg);font-size:26px;line-height:40px;text-align:center;cursor:pointer;font-family:inherit;padding:0;z-index:2;transition:.2s}
.mnav:hover{background:rgba(255,255,255,.28)}
.mnav.prev{left:26px}
.mnav.next{right:26px}
.mcount{position:absolute;bottom:20px;left:50%;margin-left:-60px;width:120px;text-align:center;color:var(--fg2);font-size:12px;letter-spacing:.12em}
.modal img{cursor:default}
.themeGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;margin-top:6px}
.tcard{border-radius:16px;overflow:hidden;cursor:pointer;border:1px solid var(--line);background:var(--glass);transition:.2s;position:relative}
.tcard:hover{transform:translateY(-2px);border-color:var(--main);box-shadow:0 10px 26px var(--glow)}
.tcard.act{border-color:var(--main);box-shadow:0 0 0 2px var(--main),0 10px 26px var(--glow)}
.tcard .thumb{height:96px;background-size:cover;background-position:center;position:relative}
.tcard .thumb::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,.45))}
.tcard .meta{padding:10px 12px}
.tcard .nm{font-size:12.5px;font-weight:700;color:var(--fg)}
.tcard .el{font-size:10px;letter-spacing:.1em;color:var(--main);margin-top:3px;text-transform:uppercase}
.tcard .dotline{position:absolute;left:12px;bottom:10px;display:flex;gap:4px;z-index:2}
.tcard .dotline i{display:block;width:7px;height:7px;border-radius:50%;border:1px solid rgba(255,255,255,.5)}
.tHead{display:flex;align-items:baseline;gap:14px;margin-top:2px}
.tTitle{font-size:17px;font-weight:700;color:var(--fg);letter-spacing:.04em}
.tSub{font-size:11px;color:var(--fg3);letter-spacing:.08em}
.tFilters{display:flex;gap:8px;margin:14px 0 16px;flex-wrap:wrap}
.tf{padding:6px 18px;border-radius:99px;border:1px solid var(--line);background:var(--glass);color:var(--fg2);font-size:12px;cursor:pointer;font-family:inherit;transition:.18s}
.tf:hover{border-color:var(--main);color:var(--fg)}
.tf.act{background:var(--main);color:var(--bg);border-color:var(--main);font-weight:700}
.themeGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:6px}
.tcard{border-radius:14px;overflow:hidden;cursor:pointer;border:1px solid var(--line);position:relative;transition:.22s;min-height:132px;display:flex;flex-direction:column;justify-content:space-between;padding:15px 16px}
.tcard:hover{transform:translateY(-3px);border-color:var(--main);box-shadow:0 14px 34px var(--glow)}
.tcard.act{border-color:var(--main);box-shadow:0 0 0 2px var(--main),0 14px 34px var(--glow)}
.tcard .tcTop{display:flex;align-items:flex-start;justify-content:space-between}
.tcard .tcIcon{width:26px;height:26px;opacity:.92}
.tcard .tcIcon svg{width:100%;height:100%;display:block}
.tcard .tcMark{width:52px;height:52px;opacity:.42}
.tcard .tcMark svg{width:100%;height:100%;display:block}
.tcard .tcBottom{}
.tcard .tcEn{font-size:18px;font-weight:600;letter-spacing:.01em;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.45);line-height:1.2}
.tcard .tcCn{font-size:11.5px;color:rgba(255,255,255,.78);margin-top:5px;letter-spacing:.06em}
.tcard .tcTag{position:absolute;right:12px;bottom:11px;font-size:9.5px;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.18);color:rgba(255,255,255,.9);letter-spacing:.08em}
.tFoot{margin-top:18px;font-size:11px;color:var(--fg3);line-height:1.9}
.xbar{position:fixed;top:0;left:0;right:0;height:30px;display:flex;align-items:center;gap:6px;padding:0 10px;z-index:50;background:color-mix(in srgb, var(--main) 8%, transparent);backdrop-filter:blur(1px);border-bottom:1px solid color-mix(in srgb, var(--fg) 10%, transparent)}
.xbtn{background:color-mix(in srgb, var(--fg) 6%, transparent);color:var(--fg);border:1px solid color-mix(in srgb, var(--fg) 12%, transparent);border-radius:7px;padding:3px 12px;font-size:11px;cursor:pointer;font-family:inherit;transition:.16s}
.xbtn:hover{background:color-mix(in srgb, var(--main) 40%, transparent);border-color:var(--main)}
.shell{padding-top:30px}
.shell{display:flex;min-height:100vh;position:relative;z-index:2}
.snav{width:210px;flex:0 0 210px;padding:22px 14px 18px;display:flex;flex-direction:column;background:var(--glass);border-right:1px solid var(--gline);backdrop-filter:blur(1px)}
.brand{display:flex;align-items:center;gap:10px;padding:0 6px 20px;border-bottom:1px solid var(--gline)}
.blogo{width:30px;height:30px;color:var(--main);flex:0 0 30px}
.blogo img{width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;box-shadow:0 0 0 1px color-mix(in srgb, var(--fg) 18%, transparent)}
.blogo svg{width:100%;height:100%}
.bname{font-size:13.5px;font-weight:700;line-height:1.2;color:var(--fg);letter-spacing:.03em}
.bname span{font-weight:400;font-size:11px;color:var(--fg2);letter-spacing:.16em}
.snavList{margin-top:16px;display:flex;flex-direction:column;gap:4px;flex:1}
.snavItem{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;cursor:pointer;font-size:13px;color:var(--fg2);transition:.16s}
.snavItem .si{width:16px;text-align:center;font-size:13px;opacity:.85}
.snavItem:hover{background:var(--track);color:var(--fg)}
.snavItem.act{background:var(--main);color:var(--bg);font-weight:700}
.snavItem.act .si{opacity:1}
.sfoot{padding-top:14px;border-top:1px solid var(--gline);text-align:center}
.sfLabel{font-size:9.5px;letter-spacing:.2em;color:var(--fg3)}
.sfVal{margin-top:5px;font-size:12.5px;font-weight:700;color:var(--main)}
.smain{flex:1;min-width:0;overflow-y:auto}
.smain .wrap{max-width:none;margin:0;padding:26px 26px 36px}
@media(max-width:820px){.shell{flex-direction:column}.snav{width:auto;flex:0 0 auto;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid var(--gline)}.brand{border-bottom:0;padding:0 12px 0 0}.snavList{flex-direction:row;margin-top:0;overflow-x:auto}.sfoot{display:none}}
.themeSel{display:flex;gap:10px;align-items:center;font-size:12px;color:var(--fg2);margin-top:10px}
.themeSel select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:9px;padding:6px 12px;font-family:inherit;font-size:12.5px;cursor:pointer;outline:none}
/* ===== 全透明覆盖 ===== */
.bar,.card,.side,.main,.log,.tcard,.themeGrid .tcard,.themeSel select{
  background:color-mix(in srgb, var(--main) 7%, transparent) !important;
  border-color:color-mix(in srgb, var(--fg) 14%, transparent) !important;
  backdrop-filter:blur(1px);
}
button.ghost,.tab,.tf,.snav,.snavItem:hover{
  background:color-mix(in srgb, var(--fg) 5%, transparent) !important;
  border-color:color-mix(in srgb, var(--fg) 13%, transparent) !important;
}
button.primary,.tab.act,.tf.act,.snavItem.act,.tag.on{
  background:color-mix(in srgb, var(--main) 78%, transparent) !important;
  color:var(--bg) !important;
  border-color:transparent !important;
}
.set input,.set select,textarea,.ta,.themeSel select,.tf{
  background:color-mix(in srgb, var(--bg) 42%, transparent) !important;
  border-color:color-mix(in srgb, var(--fg) 15%, transparent) !important;
  color:var(--fg) !important;
}
.cell{
  background:color-mix(in srgb, var(--main) 6%, transparent) !important;
  border-color:color-mix(in srgb, var(--fg) 12%, transparent) !important;
}
.track{background:color-mix(in srgb, var(--fg) 8%, transparent) !important}
.tag{background:color-mix(in srgb, var(--fg) 8%, transparent) !important}
.modal{background:color-mix(in srgb, var(--bg) 88%, transparent) !important}
.coser:hover,.work:hover,.role:hover{background:color-mix(in srgb, var(--main) 12%, transparent) !important}
.coser.sel,.role.sel{background:color-mix(in srgb, var(--main) 82%, transparent) !important;color:var(--bg) !important}
.tcard .thumb{background:transparent !important}
.tcard .meta{}
.snav{background:color-mix(in srgb, var(--main) 6%, transparent) !important;border-right-color:color-mix(in srgb, var(--fg) 12%, transparent) !important}
#gg-wall{opacity:1}
</style></head><body data-theme="elaina">
<div id="gg-elaina-intro">
<video id="ei-video" class="ei-video" src="/wallpaper?theme=elaina&type=intro-video" playsinline muted autoplay></video>
<div class="ei-sky"></div>
<div class="ei-stars" id="eiStars"></div>
<svg class="ei-circle" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
<g id="eiRing1" fill="none" stroke="rgba(232,224,245,.55)" stroke-width="1.1">
<circle cx="200" cy="200" r="150" stroke-dasharray="4 9"/>
<circle cx="200" cy="200" r="118" stroke-dasharray="2 14"/>
</g>
<g id="eiRing2" fill="none" stroke="rgba(184,168,216,.42)" stroke-width=".9">
<circle cx="200" cy="200" r="186" stroke-dasharray="1 20"/>
<path d="M200 20v12M200 368v12M20 200h12M368 200h12" stroke-linecap="round"/>
</g>
<g id="eiRunes" fill="none" stroke="rgba(232,224,245,.7)" stroke-width="1.5">
<path d="M200 66l10 18-10 18-10-18z"/>
<path d="M200 298l8 14-8 14-8-14z"/>
<path d="M66 200l14-8 14 8-14 8z"/>
<path d="M306 200l14-8 14 8-14 8z"/>
</g>
<g id="eiHat" style="display:none" fill="none" stroke="rgba(238,232,250,.95)" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round">
<ellipse cx="200" cy="256" rx="108" ry="27"/>
<path d="M200 256 C 184 214 172 168 163 128 C 157 101 172 88 191 103 C 214 121 228 180 240 220 L 255 256"/>
<path d="M163 128 C 148 113 134 106 119 105"/>
<path d="M170 214 Q 210 230 252 214"/>
<circle cx="200" cy="192" r="4.5"/>
<path d="M196 186 L 200 198 M 204 186 L 200 198"/>
</g>
<g id="eiWand" style="display:none" fill="none" stroke="rgba(238,232,250,.9)" stroke-width="2" stroke-linecap="round">
<path d="M118 300 L 168 258"/>
<circle cx="113" cy="304" r="5.5"/>
<path d="M176 208 L 176 196 M 170 202 L 182 202 M 172 198 L 180 206 M 180 198 L 172 206"/>
<path d="M270 168 L 276 158 M 264 160 L 270 166" stroke-width="1.4" opacity=".8"/>
</g>
</svg>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<defs>
<filter id="eiEdge" x="-20%" y="-20%" width="140%" height="140%">
<feMorphology in="SourceAlpha" operator="dilate" radius="2.2" result="dil"/>
<feComposite in="dil" in2="SourceAlpha" operator="out" result="edge"/>
<feFlood flood-color="#A0E7F3" flood-opacity=".95" result="c1"/>
<feComposite in="c1" in2="edge" operator="in" result="neon"/>
<feGaussianBlur in="neon" stdDeviation="2.4" result="glow"/>
<feMerge><feMergeNode in="glow"/><feMergeNode in="glow"/><feMergeNode in="neon"/></feMerge>
</filter>
<mask id="eiRevealMask">
<rect id="eiRevealRect" x="-40" y="-40" width="0" height="1300" fill="#fff"/>
</mask>
</defs>
</svg>
<div class="ei-stack" id="eiStack">
<img id="ei-portrait-line" src="/wallpaper?theme=elaina&type=line" alt=""/>
<img id="ei-portrait-open" src="/wallpaper?theme=elaina&type=intro-open" alt=""/>
<img id="ei-portrait" src="/wallpaper?theme=elaina&type=intro" alt=""/>
</div>

<div class="ei-sweep"></div>
<div class="ei-name">ELENA</div>
<div class="ei-sub">魔 女 の 旅 々</div>
<div class="ei-tip">点击跳过</div>
</div>
<div id="gg-wall"></div>
<div id="gg-intro">
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
<g id="gg-intro-crystal" stroke="#A0E7F3" stroke-width="2.4" fill="none" stroke-linecap="round">
<path d="M100 22 L100 178"/><path d="M32 61 L168 139"/><path d="M168 61 L32 139"/>
<path d="M100 52 L78 74 M100 52 L122 74 M100 148 L78 126 M100 148 L122 126"/>
<path d="M60 74 L48 100 M60 74 L74 62 M140 126 L152 100 M140 126 L126 138"/>
<path d="M140 74 L152 100 M140 74 L126 62 M60 126 L48 100 M60 126 L74 138"/>
</g>
</svg>
<div id="gg-intro-name">GENTLEMAN GALLERY</div>
</div>
<svg id="gg-bg-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style="position:fixed;inset:0;width:100%;height:100%;z-index:-3;opacity:.5;pointer-events:none">
<defs>
<radialGradient id="ggGlow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#A0E7F3" stop-opacity=".55"/><stop offset="100%" stop-color="#A0E7F3" stop-opacity="0"/></radialGradient>
<linearGradient id="ggLine" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#A0E7F3" stop-opacity=".5"/><stop offset="100%" stop-color="#E8C87A" stop-opacity=".25"/></linearGradient>
</defs>
<circle cx="300" cy="180" r="420" fill="url(#ggGlow)"/>
<circle cx="1320" cy="820" r="480" fill="url(#ggGlow)"/>
<g stroke="url(#ggLine)" fill="none" stroke-width="1.2" opacity=".55">
<circle cx="1200" cy="220" r="150"/><circle cx="1200" cy="220" r="110"/><circle cx="1200" cy="220" r="70"/>
<circle cx="260" cy="760" r="180"/><circle cx="260" cy="760" r="132"/>
</g>
<g id="gg-crystal" stroke="url(#ggLine)" fill="none" stroke-width="1.6" opacity=".4">
<path d="M1200 70 L1200 370 M1080 145 L1320 295 M1320 145 L1080 295"/>
<path d="M1200 130 L1160 170 M1200 130 L1240 170 M1200 310 L1160 270 M1200 310 L1240 270"/>
</g>
<g id="gg-petals" fill="url(#ggLine)" opacity=".18">
<ellipse cx="420" cy="320" rx="70" ry="22" transform="rotate(-24 420 320)"/>
<ellipse cx="500" cy="400" rx="54" ry="17" transform="rotate(18 500 400)"/>
<ellipse cx="360" cy="430" rx="46" ry="14" transform="rotate(42 360 430)"/>
</g>
</svg>

<div class="shell">
<div class="xbar">
<span class="xbtn" style="cursor:default;opacity:.55">Gentleman Gallery</span>
</div>

<aside class="snav">
<div class="brand">
<div class="blogo"><img src="/icon.png" alt=""/></div>
<div class="bname">Gentleman<br><span>Gallery</span></div>
</div>
<nav class="snavList">
<div class="snavItem" data-tab="dl"><span class="si">⇣</span>下载</div>
<div class="snavItem" data-tab="gal"><span class="si">▤</span>图库</div>
<div class="snavItem" data-tab="x"><span class="si">▶</span>视频解析下载</div>
<div class="snavItem" data-tab="fish"><span class="si">◎</span>鱼鱼找鸡</div>
<div class="snavItem" data-tab="themes"><span class="si">✦</span>主题库</div>
</nav>
<div class="sfoot"><div class="sfLabel">当前主题</div><div class="sfVal" id="sfTheme">甘雨</div></div>
</aside>
<main class="smain">
<div class="wrap">
<div class="hd"><h1>Gentleman Gallery</h1><div class="st">LOCAL CONSOLE</div></div>

<div class="tabs">
<button class="tab act" id="tabDl" onclick="switchTab('dl')">下载</button>
<button class="tab" id="tabGal" onclick="switchTab('gal')">图库</button>
<button class="tab" id="tabX" onclick="switchTab('x')">视频解析下载</button>
<button class="tab" id="tabFish" onclick="switchTab('fish')">鱼鱼找鸡</button>
<button class="tab" id="tabThemes" onclick="switchTab('themes')">主题库</button>
</div>
<div id="pageDl">
<div class="bar">
<div class="row"><span>今日进度</span><span id="pct">0%</span></div>
<div class="big"><span id="today">0.00</span> GB <span style="font-size:14px;color:var(--fg3)">/ <span id="quota">20</span> GB</span><span id="runtag" class="tag">空闲</span></div>
<div class="track"><div class="fill" id="fill"></div></div>
</div>
<div class="bar" style="margin-top:12px">
<div class="row"><span>当前 coser 进度</span><span id="cpct">0%</span></div>
<div class="big" style="font-size:17px;margin:6px 0 10px" id="cinfo">空闲</div>
<div class="track"><div class="fill" id="cfill"></div></div>
</div>
<div class="cards">
<div class="card"><div class="k">已完成</div><div class="v"><span id="done">0</span> 位</div></div>
<div class="card"><div class="k">当前</div><div class="v" id="coser" style="font-size:16px">—</div></div>
<div class="card"><div class="k">库里现有</div><div class="v" id="lib">0</div></div>
<div class="card"><div class="k">磁盘剩余</div><div class="v" id="disk">0 GB</div></div>
</div>
<div class="ctrl">
<button class="primary" id="b1" onclick="smartStart()">开始</button>
<button class="danger" id="b3" onclick="stop()">停止</button>
</div>
<div class="set">
<span>每日配额 <input id="q" type="number" min="1" step="1"/></span>
<span>单轮分钟 <input id="m" autocomplete="off" type="number" min="1" step="1"/></span>
<button class="ghost" onclick="saveCfg()">保存设置</button>
<span style="color:var(--fg3)">本轮 +<span id="run">0.00</span> GB</span>
</div>
<div class="set">
<span>按 coser <input id="coserInput" placeholder="输入名字" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" name="gg-coser-nofill" style="width:180px"/></span>
<button class="ghost" onclick="startCoser()">只下这位</button>
<span style="color:var(--fg3)">指定一位，只灌他的全部图集</span>
</div>
<div class="set">
<span>保存目录 <input id="libRoot" autocomplete="off" placeholder="默认 ...\cosplay" style="width:300px" oninput="libRootDirty=true"/></span>

<button class="ghost" onclick="pickFolder()">选择…</button>
<button class="ghost" onclick="moveLibrary()">移动图库</button>
</div>
<div id="moveBox" style="display:none;margin-top:10px;background:var(--glass);border:1px solid var(--gline);border-radius:14px;padding:14px 16px">
<div class="row"><span id="moveTitle">搬运中…</span><span><span id="movePct">0%</span> <b onclick="closeMoveBox()" style="cursor:pointer;margin-left:10px;color:var(--fg3)">关闭</b></span></div>
<div class="track" style="margin-top:9px"><div class="fill" id="moveFill"></div></div>
<pre id="moveLog" style="margin:11px 0 0;max-height:170px;overflow:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;color:var(--fg2);white-space:pre-wrap"></pre>
</div>
<div class="log"><h3>运行日志</h3><pre id="log">加载中…</pre></div>
</div>
<div id="pageThemes" style="display:none">
<div class="tHead">
  <div class="tTitle">主题库</div>
  <div class="tSub">按元素筛选 · 点卡片切换</div>
</div>
<div class="tFilters" id="tFilters"></div>
<div class="themeGrid" id="themeGrid"></div>
<div class="tFoot">壁纸目录：<code>D:\Gentleman Gallery\app\bg\</code> · 支持 &lt;主题&gt;.jpg / .png / .mp4（视频自动播放）</div>
</div>
</div>
<div id="pageFish" style="display:none">
<div class="set"><span>图片路径 <input id="fishPath" style="width:520px" placeholder="D:\图片\a.jpg 或 图库内相对路径"/></span><button class="ghost" onclick="fishRun()">反查这张图</button></div>
<div class="set"><span style="color:var(--fg3)">也可以在「图库」里点开一张图，左下角「反查此人」一样能查</span></div>
<div id="fishDrop" style="border:2px dashed var(--line2);border-radius:14px;padding:26px;text-align:center;color:var(--fg2);margin-top:12px;font-size:13px;transition:.15s;cursor:pointer">
把图片拖到这里，或点一下选图
<input type="file" id="fishFile" accept="image/*" style="display:none"/>
</div>
<div class="log" style="margin-top:12px"><h3>反查结果</h3><pre id="fishOut">填路径点「反查这张图」，或者直接把图片拖进上面那个框。</pre></div>
</div>
<div id="pageX" style="display:none">
<div class="set"><span>链接</span><button class="ghost" onclick="dlFetch()">下载</button><span style="color:var(--fg3)">支持 YouTube / B站 / X / TikTok / Instagram / 小红书 / 微博 / 抖音 / 网易云 等 1000+ 站点，每行一条</span></div>
<div><textarea id="xUrl" autocomplete="off" rows="4" class="ta" placeholder="https://x.com/名字/status/数字"></textarea></div>
<div class="log" style="margin-top:12px"><h3>解析结果</h3><pre id="xLog">粘贴链接后点「解析并下载」</pre></div>
<div id="xList" style="margin-top:12px"></div>
</div>
<div id="pageGal" style="display:none">
<div class="gal">
<div class="side" id="tree"><div class="crest"><svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"><path d="M24 7 L24 41"/><path d="M9.5 15.5 L38.5 32.5"/><path d="M38.5 15.5 L9.5 32.5"/><path d="M24 15 L18.5 20.5 M24 15 L29.5 20.5 M24 33 L18.5 27.5 M24 33 L29.5 27.5"/></g></svg></div><div class="empty">加载中…</div></div>
<div class="main">
<div class="crumb" id="crumb"></div><div style="font-size:11px;color:var(--fg3);margin:4px 0 0">点开任意一张图 → 左下角「反查此人」可查 coser 账号</div><div style="display:none">左边选一个目录</div>
<div class="grid" id="grid"></div>
<div class="pager"><button class="ghost" onclick="pageNav(-1)">上一页</button><span id="pinfo">—</span><button class="ghost" onclick="pageNav(1)">下一页</button></div>
</div>
</div>
</div>
<div class="modal" id="modal" onclick="closeModal()">
<img id="modalImg" alt="" onclick="event.stopPropagation()"/>
<button class="mnav fish" onclick="event.stopPropagation();fishLookup()" title="反查 coser" style="left:26px;top:auto;bottom:22px;width:auto;padding:0 18px;height:40px;font-size:14px;border-radius:20px;background:var(--main);border:1px solid var(--line2);color:var(--bg);font-weight:700">反查此人</button>
<button class="mnav prev" onclick="event.stopPropagation();prevImg()">‹</button>
<button class="mnav next" onclick="event.stopPropagation();nextImg()">›</button>
<div class="mcount" id="mcount"></div>
</div>
</div>
<script>
let cfgMinutes = 10;
async function xFillFromServer(){
  try{
    const atEl = document.getElementById('xAt');
    const cEl = document.getElementById('xCt0');
    if (!atEl || !cEl) return;
    if (atEl.value.trim() || cEl.value.trim()) return;
    const r = await fetch('/api/x-get-cookie');
    const d = await r.json();
    if (d.ok && d.auth_token && d.ct0) {
      atEl.value = d.auth_token;
      cEl.value = d.ct0;
      const log = document.getElementById('xLog');
      if (log && /粘贴链接后点解析|两个框都填好/.test(log.textContent)) {
        log.textContent = '已从登录窗口自动载入 cookie，可以直接验证或拉媒体。';
      }
    }
  }catch(e){}
}
let fishDragInit = false;
function initFishDrag(){
  if (fishDragInit) return;
  const dz = document.getElementById('fishDrop');
  const fi = document.getElementById('fishFile');
  if (!dz || !fi) return;
  fishDragInit = true;
  dz.addEventListener('click', function(){ fi.click(); });
  dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.style.borderColor = '#F5572F'; dz.style.color = '#F5572F'; });
  dz.addEventListener('dragleave', function(){ dz.style.borderColor = 'var(--line2)'; dz.style.color = 'var(--fg2)'; });
  dz.addEventListener('drop', function(e){
    e.preventDefault();
    dz.style.borderColor = 'var(--line2)'; dz.style.color = 'var(--fg2)';
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) fishFromFile(f);
  });
  fi.addEventListener('change', function(){
    if (fi.files && fi.files[0]) fishFromFile(fi.files[0]);
  });
}
async function fishFromFile(f){
  const out = document.getElementById('fishOut');
  if (!out) return;
  if (String(f.type || '').indexOf('image/') !== 0) { out.textContent = '这不是图片文件：' + f.type; return; }
  out.innerHTML = '读取图片 ' + f.name + ' …';
  try{
    const dz = document.getElementById('fishDrop');
    if (dz) {
      const oldP = document.getElementById('fishPreview');
      if (oldP) oldP.remove();
      const u = URL.createObjectURL(f);
      const pv = document.createElement('img');
      pv.id = 'fishPreview';
      pv.src = u;
      pv.style.cssText = 'max-width:180px;max-height:180px;border-radius:10px;margin-top:10px;display:block;margin-left:auto;margin-right:auto';
      dz.appendChild(pv);
    }
  }catch(e){}
  const reader = new FileReader();
  reader.onload = function(){
    try{
      const b64 = String(reader.result || '').split(',')[1] || '';
      startFish({ data: b64, name: f.name }, out, f.name);
    }catch(e){ out.textContent = '出错：' + e; }
  };
  reader.readAsDataURL(f);
}
function openInApp(u){
  try{
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({ type: 'openUrl', url: u });
      return;
    }
  }catch(e){}
  window.open(u, '_blank');
}
function fishRender(text){
  var h = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var bs = String.fromCharCode(92);
  var re = new RegExp('(https?://[^' + bs + 's]+)', 'g');
  h = h.replace(re, function(m){
    return '<a href="#" style="color:#F5572F;text-decoration:underline;cursor:pointer" onclick="openInApp(this.getAttribute(&quot;data-u&quot;));return false" data-u="' + m + '">' + m + '</a>';
  });
  return h;
}

async function pollFishStatus(out, label){
  const t0 = Date.now();
  if (window.__fishTick) clearInterval(window.__fishTick);
  window.__fishTick = setInterval(function(){
    try { out.innerHTML = '反查中… ' + Math.round((Date.now() - t0) / 1000) + 's' + (label ? '（' + label + '）' : ''); } catch(e){}
  }, 400);
  for (let i = 0; i < 240; i++) {
    await new Promise(function(r){ setTimeout(r, 1200); });
    let d = null;
    try { d = await (await fetch('/api/fish-status')).json(); } catch(e) { continue; }
    if (!d || d.running) continue;
    if (window.__fishTick) { clearInterval(window.__fishTick); window.__fishTick = null; }
    if (d.result && d.result.text) {
      out.innerHTML = fishRender(String(d.result.text).split('**').join(''));
    } else {
      out.innerHTML = '没查到：' + (d.error || '无结果');
    }
    return;
  }
  if (window.__fishTick) { clearInterval(window.__fishTick); window.__fishTick = null; }
  out.innerHTML = '超时了（5 分钟还没回），检查代理是否通';
}
async function startFish(payload, out, label){
  out.innerHTML = '开始反查…';
  try {
    const r = await fetch('/api/fish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!d.ok) { out.innerHTML = '失败：' + (d.msg || '未知'); return; }
    pollFishStatus(out, label);
  } catch(e) { out.innerHTML = '出错：' + e; }
}
async function fishRun(){
  const pth = document.getElementById('fishPath').value.trim();
  const out = document.getElementById('fishOut');
  if (!pth) { alert('先填图片路径（绝对路径或图库内相对路径）'); return; }
  startFish({ path: pth }, out, pth.split('/').pop());
}
async function fishLookup(){
  try {
    const gf = gFiles[gIndex];
    if (!gf) { alert('没选中图片：先在右边点开一张图'); return; }
    const relPath = gf.rel || (gDir ? (gDir + '/' + gf.n) : '');
    if (!relPath) { alert('拿不到图片路径'); return; }
    const oldBox = document.getElementById('fishBox');
    if (oldBox) oldBox.remove();
    const bx = document.createElement('div');
    bx.id = 'fishBox';
    bx.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:9999;background:var(--card);color:var(--fg);border:1px solid var(--line);padding:14px 20px;border-radius:14px;font-size:13px;max-width:80%;line-height:1.7;white-space:pre-wrap;box-shadow:0 8px 30px rgba(0,0,0,.35)';
    bx.textContent = '开始反查…';
    document.body.appendChild(bx);
    startFish({ path: relPath }, bx, relPath.split('/').pop());
  } catch (e) {
    alert('反查出错：' + e);
  }
}
async function fishLookupOld(){
  const img = document.getElementById('modalImg');
  const log = document.getElementById('log');
  if (!gFiles[gIndex]) { alert('没选中图片'); return; }
  const rel = gFiles[gIndex].rel || (gDir + '/' + gFiles[gIndex].name);
  const old = document.getElementById('fishBox');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'fishBox';
  box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:60;background:var(--card);color:var(--fg);border:1px solid var(--line);padding:14px 18px;border-radius:14px;font-size:12.5px;max-width:80%;line-height:1.7;white-space:pre-wrap';
  box.textContent = '反查中…（走谷歌 Lens，可能要 10–40 秒）';
  document.body.appendChild(box);
  try{
    const r = await fetch('/api/fish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path: rel})});
    const d = await r.json();
    if (!d.ok) { box.textContent = d.msg || '反查失败'; return; }
    box.textContent = (d.result && d.result.text) ? d.result.text : '（没有结果文本）';
  }catch(e){ box.textContent = '请求失败：' + e; }
}
function applyWallpaper(name){
  try{
    const el = document.getElementById('gg-wall');
    if (!el) return;
    el.innerHTML = '';
    const vidUrl = '/wallpaper?theme=' + encodeURIComponent(name) + '&type=video';
    const imgUrl = '/wallpaper?theme=' + encodeURIComponent(name) + '&t=' + Date.now();
    // 先探测有没有视频
    fetch(vidUrl, { method: 'GET', headers: { 'Range': 'bytes=0-1' } }).then(function(r){
      if (r.status === 200 || r.status === 206) {
        const v = document.createElement('video');
        v.src = vidUrl;
        v.muted = true;
        v.loop = true;
        v.autoplay = true;
        v.playsInline = true;
        v.setAttribute('muted', '');
        v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.34';
        v.onerror = function(){ applyWallpaperImage(el, imgUrl); };
        el.appendChild(v);
        try { v.play(); } catch(e) {}
        el.style.backgroundImage = 'none';
        el.style.opacity = '1';
      } else {
        applyWallpaperImage(el, imgUrl);
      }
    }).catch(function(){ applyWallpaperImage(el, imgUrl); });
  }catch(e){}
}
function applyWallpaperImage(el, imgUrl){
  try{
    el.innerHTML = '';
    const img = new Image();
    img.onload = function(){ el.style.backgroundImage = 'url("' + imgUrl + '")'; el.style.opacity = '0.34'; };
    img.onerror = function(){ el.style.backgroundImage = 'none'; };
    img.src = imgUrl;
  }catch(e){}
}
function updateFootTheme(name){
  try {
    const nm = {ganyu:'甘雨',yae:'八重神子',yoimiya:'宵宫',nahida:'纳西妲',furina:'芙宁娜',faruzan:'法露珊',zhongli:'钟离',elaina:'伊蕾娜',paper:'纸感',darkroom:'暗房',agency:'品牌粉',saas:'工具蓝',social:'社交红',silicon:'硅基紫',wallet:'金融蓝'};
    const el = document.getElementById('sfTheme');
    if (el) el.textContent = nm[name] || name;
  } catch(e){}
}
function notifyThemeToShell(){
  try{
    if (!(window.chrome && window.chrome.webview && window.chrome.webview.postMessage)) return;
    const cs = getComputedStyle(document.body);
    const bg = (cs.getPropertyValue('--bg') || '').trim();
    const fg = (cs.getPropertyValue('--fg') || '').trim();
    const main = (cs.getPropertyValue('--main') || '').trim();
    const line = (cs.getPropertyValue('--line') || '').trim();
    const card = (cs.getPropertyValue('--card') || '').trim();
    window.chrome.webview.postMessage({ type: 'theme', bg: bg, fg: fg, main: main, line: line, card: card });
  }catch(e){}
}
function setTheme(name){
  try{
    document.body.setAttribute('data-theme', name);
    try { localStorage.setItem('gg-theme', name); } catch(e){}
    const sel = document.getElementById('themeSel');
    if (sel && sel.value !== name) sel.value = name;
    applyWallpaper(name);
    setTimeout(notifyThemeToShell, 30);
    updateFootTheme(name);
  }catch(e){}
}
function hashRouter(){
  try{
    const h = (location.hash || '').replace('#','');
    const map = { themes: 'themes', fish: 'fish', x: 'x', gallery: 'gallery', home: 'home' };
    if (map[h]) switchTab(map[h]);
  }catch(e){}
}
window.addEventListener('hashchange', hashRouter);
(function hashRouterInit(){ setTimeout(hashRouter, 60); })();
(function initTheme(){
  try{
    const saved = localStorage.getItem('gg-theme');
    if (saved) { document.body.setAttribute('data-theme', saved); }
    const sel = document.getElementById('themeSel');
    if (sel) sel.value = saved || 'elaina';
    applyWallpaper(saved || 'elaina');
    try { if (!sessionStorage.getItem('gg-intro-played')) { sessionStorage.setItem('gg-intro-played','1'); setTimeout(playElainaIntro, 300); } } catch(e) {}
    setTimeout(notifyThemeToShell, 150);
  }catch(e){}
})();
async function poll(){
  loadCoserNames();
  bindCookieAuto();
  xFillFromServer();
  try{
    const r = await fetch('/api/status');
    const d = await r.json();
    const pct = Math.min(100, d.bytesToday / (d.quotaGB*1073741824) * 100);
    document.getElementById('today').textContent = (d.bytesToday/1073741824).toFixed(2);
    document.getElementById('quota').textContent = d.quotaGB;
    document.getElementById('pct').textContent = pct.toFixed(1)+'%';
    document.getElementById('fill').style.width = pct.toFixed(1)+'%';
    document.getElementById('done').textContent = d.doneCount;
    var _cn = d.coser || '';
    try {
      var _lg = d.log || [];
      for (var _i = _lg.length - 1; _i >= 0; _i--) {
        var _s = String(_lg[_i]);
        var _mm = _s.match(/album (\S+) (?:.*got=|-> )/) && !/aborted|worker|dl /.test(_s) ? _s.match(/album (\S+)/) : null;
        if (_mm) { _cn = _mm[1]; break; }
        var _ms = _s.match(/search \[(\S+?)\]/);
        if (_ms) { _cn = _ms[1]; break; }
      }
    } catch(e) {}
    document.getElementById('coser').textContent = _cn || '全部完成';
    document.getElementById('lib').textContent = d.libImages.toLocaleString()+' 张 / '+d.libGB+' GB';
    document.getElementById('disk').textContent = d.diskFreeGB+' GB';
    document.getElementById('run').textContent = (d.runBytes/1073741824).toFixed(2);
    var ctot = d.curTotal || 0, cdone = d.curDone || 0;
    var cpct = ctot ? Math.min(100, cdone / ctot * 100) : 0;
    document.getElementById('cfill').style.width = cpct.toFixed(1) + '%';
    document.getElementById('cpct').textContent = cpct.toFixed(1) + '%';
    document.getElementById('cinfo').textContent = ctot
      ? ((_cn || d.coser || '') + ' · ' + cdone.toLocaleString() + ' / ' + ctot.toLocaleString() + ' 张')
      : (d.running ? ((_cn || d.coser || '') + ' · 准备中') : '空闲');
    const tag = document.getElementById('runtag');
    tag.textContent = d.running ? '运行中' : '空闲';
    tag.className = 'tag' + (d.running ? ' on' : '');
    var _b1 = document.getElementById('b1'), _b2 = document.getElementById('b2'), _b3 = document.getElementById('b3');
    if (_b1) _b1.disabled = d.running;
    if (_b2) _b2.disabled = d.running;
    if (_b3) _b3.disabled = !d.running;
    if (document.activeElement.id !== 'q') document.getElementById('q').value = d.quotaGB;
    if (document.activeElement.id !== 'm') document.getElementById('m').value = d.minutes;
    if (!libRootDirty && document.activeElement.id !== 'libRoot') document.getElementById('libRoot').value = d.libraryRoot || '';
    cfgMinutes = d.minutes;
    document.getElementById('log').textContent = (d.log||[]).map(function(x){return String(x);}).join(String.fromCharCode(10)) || '（还没有记录）';
  }catch(e){
    document.getElementById('log').textContent = '连接断开：'+e;
  }
}
async function start(minutes){
  await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes})});
  poll();
}
async function stop(){
  await fetch('/api/stop',{method:'POST'});
  poll();
}
async function saveCfg(){
  const quotaGB = parseFloat(document.getElementById('q').value)||20;
  const minutes = parseFloat(document.getElementById('m').value)||10;
  const libraryRoot = document.getElementById('libRoot').value.trim();
  await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({quotaGB,minutes,libraryRoot})});
  libRootDirty = false;
  poll();
}
function showBig(u){
  gIndex = -1;
  for (var i = 0; i < gFiles.length; i++) if (gFiles[i].u === u) { gIndex = i; break; }
  paintModal(u);
}
function paintModal(u){
  document.getElementById('modalImg').src = u;
  document.getElementById('mcount').textContent = gFiles.length ? ((gIndex + 1) + ' / ' + gFiles.length) : '';
  document.getElementById('modal').className = 'modal on';
}
function prevImg(){
  if (gIndex <= 0) return;
  gIndex--;
  paintModal(gFiles[gIndex].u);
}
function nextImg(){
  if (gIndex >= gFiles.length - 1) return;
  gIndex++;
  paintModal(gFiles[gIndex].u);
}
function closeModal(){ document.getElementById('modal').className = 'modal'; }
document.getElementById('grid').addEventListener('click', function(ev){
  var cell = ev.target.closest ? ev.target.closest('.cell') : null;
  if (cell && cell.getAttribute('data-u')) showBig(cell.getAttribute('data-u'));
});
document.getElementById('tree').addEventListener('click', function(ev){
  var t = ev.target;
  var dl = t.closest ? t.closest('.dl') : null;
  if (dl) {
    ev.stopPropagation();
    var row = dl.closest('.coser');
    if (row) downloadCoser(row.getAttribute('data-name'));
    return;
  }
  var coser = t.closest ? t.closest('.coser') : null;
  if (coser) { toggleCoser(coser.getAttribute('data-ci')); return; }
  var work = t.closest ? t.closest('.work') : null;
  if (work) { toggleWork(work.getAttribute('data-ci'), work.getAttribute('data-wi')); return; }
  var role = t.closest ? t.closest('.role') : null;
  if (role) { openDir(role); return; }
});
let gCoserNames = [], coserNamesLoaded = false;
async function loadCoserNames(){
  if (coserNamesLoaded) return;
  coserNamesLoaded = true;
  try{
    const t = await (await fetch('/api/tree')).json();
    gCoserNames = t.map(function(c){ return c.name; });

  }catch(e){ coserNamesLoaded = false; }
}
async function smartStart(){
  const v = (document.getElementById('coserInput').value || '').trim();
  if (v) {
    // 填了名字 -> 只下这位
    await startCoser();
  } else {
    // 没填 -> 批量（跳过已下载）
    await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:240})});
    poll();
  }
}
async function startCoser(){
  const v = document.getElementById('coserInput').value.trim();
  if (!v) { alert('先填一位 coser 名，或者点左侧树上那个 ↓'); return; }
  await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:240,coser:v})});
  switchTab('dl');
  poll();
}
async function downloadCoser(name){
  if (!name) return;
  await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({minutes:240,coser:name})});
  switchTab('dl');
  poll();
}
async function pickFolder(){
  try{
    const r = await fetch('/api/pick-folder',{method:'POST'});
    const d = await r.json();
    if (!d.ok) { alert('启动选择框失败：' + (d.msg||'')); return; }
    if (d.started === false) { alert(d.msg || '上一次的选择框还开着，先关掉它'); return; }
    let waited = 0;
    const timer = setInterval(async function(){
      waited += 1.5;
      try{
        const rr = await fetch('/api/pick-result');
        const sd = await rr.json();
        if (!sd.running) {
          clearInterval(timer);
          if (sd.path) { document.getElementById('libRoot').value = sd.path; libRootDirty = true; }
          else if (waited > 4) { alert('没选到目录。可以在下面手动输入路径。'); }
        }
      }catch(e){}
      if (waited > 240) clearInterval(timer);
    }, 1500);
  }catch(e){ alert('请求失败：' + e + '（看看页面是不是断线了）'); }
}
function closeMoveBox(){
  if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
  document.getElementById('moveBox').style.display = 'none';
}
let xMedia = [];
let xOwner = '';
function renderXMedia(){
  let html = '';
  xMedia.forEach(function(m, i){
    html += '<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">'
      + '<span style="width:64px;color:var(--fg3);font-size:12px">' + m.kind + '</span>'
      + '<span style="flex:1;color:var(--fg2);font-size:12px">' + (m.w ? (m.w + '×' + m.h) : '') + (m.dur ? (' ｜ ' + Math.round(m.dur) + 's') : '') + '</span>'
      + '<button class="ghost" onclick="xDownload(' + i + ')">下载</button></div>';
  });
  const allBtn = xMedia.length ? ('<div style="margin:10px 0"><button class="ghost" onclick="xDownloadAll()">全部下载（' + xMedia.length + ' 个）</button></div>') : '';
  document.getElementById('xList').innerHTML = allBtn + (html || '<div class="empty">没有媒体</div>');
}
function isCookieOk(ck){
  return /auth_token=[^;\s]+/.test(ck) && /ct0=[^;\s]+/.test(ck);
}
let ckTimer = null;
function bindCookieAuto(){
  const el = document.getElementById('xAt');
  const el2 = document.getElementById('xCt0');
  if (!el || el.dataset.bound) return;
  el.dataset.bound = '1';
  el.addEventListener('input', function(){
    const log = document.getElementById('xLog');
    if (ckTimer) clearTimeout(ckTimer);
    const val = getCookieStr();
    if (!val) {
      const at = (document.getElementById('xAt').value || '').trim();
      const c0 = (document.getElementById('xCt0').value || '').trim();
      if (at || c0) log.textContent = '还差一个：' + (!at ? 'auth_token' : '') + (!c0 ? (at ? ' ct0' : 'ct0') : '');
      return;
    }
    log.textContent = '两段都齐了，1 秒后自动保存并拉取媒体…';
    ckTimer = setTimeout(async function(){
      try{
        await fetch('/api/x-set-cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:val})});
        const user = document.getElementById('xUser').value.trim();
        if (user) { await xUserFetch(); }
        else { document.getElementById('xLog').textContent = 'Cookie 已保存。填个用户名再点「拉该用户媒体」。'; }
      }catch(e){ document.getElementById('xLog').textContent = '自动保存失败：' + e; }
    }, 1000);
  });
  if (el2) el2.addEventListener('input', function(){ el.dispatchEvent(new Event('input')); });
}
function getCookieStr(){
  const at = (document.getElementById('xAt').value || '').trim();
  const c0 = (document.getElementById('xCt0').value || '').trim();
  if (!at || !c0) return '';
  return 'auth_token=' + at + '; ct0=' + c0;
}
async function xVerify(){
  const log = document.getElementById('xLog');
  const ck = getCookieStr();
  if (!ck) { log.textContent = '两个框都填好才能验证'; return; }
  log.textContent = '正在验证 cookie 能不能连上 X…';
  try{
    const r = await fetch('/api/x-verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:ck})});
    const d = await r.json();
    log.textContent = d.ok ? ('验证通过 ✓ 登录账号：@' + d.screen_name) : (d.msg || '验证失败');
  }catch(e){ log.textContent = '请求失败：' + e; }
}
async function xAutoCookie(){
  const log = document.getElementById('xLog');
  log.textContent = '正在从 Edge 读取 cookie…';
  try{
    const r = await fetch('/api/x-cookie',{method:'POST'});
    const d = await r.json();
    if (d.ok) {
      const ma = String(d.cookie).match(/auth_token=([^;]+)/);
      const mc = String(d.cookie).match(/ct0=([^;]+)/);
      if (ma) document.getElementById('xAt').value = ma[1].trim();
      if (mc) document.getElementById('xCt0').value = mc[1].trim();
      log.textContent = '已自动填入 cookie（' + (d.names || []).length + ' 个可用项）';
    } else {
      log.textContent = d.msg || '获取失败';
    }
  }catch(e){ log.textContent = '请求失败：' + e; }
}
async function xUserFetch(){
  const user = document.getElementById('xUser').value.trim();
  const cookie = getCookieStr();
  const log = document.getElementById('xLog');
  if (!user) { alert('先填用户名（@ 后面那段）'); return; }
  log.textContent = '查询中…（拉媒体会慢一点）';
  document.getElementById('xList').innerHTML = '';
  try{
    const r = await fetch('/api/x-user',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:user, cookie:cookie})});
    const d = await r.json();
    if (!d.ok) { log.textContent = d.msg || '失败'; return; }
    xMedia = d.media || [];
    xOwner = d.name || d.user || '';
    const links = d.tweetUrls || [];
    if (links.length) {
      document.getElementById('xUrl').value = links.join(String.fromCharCode(10));
      log.textContent = d.name + ' @' + d.user + ' ｜ 提取到 ' + links.length + ' 条推文链接（首屏上限），正在逐条解析…';
      await xFetch();
      return;
    }
    log.textContent = d.name + ' @' + d.user + ' ｜ 主页媒体 ' + d.mediaCount + ' 个 ｜ 关注 ' + d.followers + ' ｜ 本次列出 ' + xMedia.length + ' ｜ ' + (d.note || '');
    if (xMedia.length) log.textContent += ' ｜ 点下面「全部下载」一次拉完';
    renderXMedia();
  }catch(e){ log.textContent = '失败：' + e; }
}
async function xCurl(){
  const log = document.getElementById('xLog');
  const curl = document.getElementById('xCurlBox').value.trim();
  if (!curl) { log.textContent = '先粘一条 cURL 进来'; return; }
  log.textContent = '正在用这条 cURL 请求并解析…';
  document.getElementById('xList').innerHTML = '';
  try{
    const r = await fetch('/api/x-curl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({curl:curl})});
    const d = await r.json();
    if (!d.ok) { log.textContent = d.msg || '失败'; return; }
    xMedia = d.media || [];
    log.textContent = d.note + ' ｜ 共 ' + xMedia.length + ' 个';
    renderXMedia();
  }catch(e){ log.textContent = '请求失败：' + e; }
}
async function xSaveCookie(){
  try{
    const inp = document.getElementById('xAt');
    const v = (inp && inp.value || '').trim();
    if (!v) { alert('先粘 auth_token'); return; }
    const r = await fetch('/api/x-set-cookie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({at:v})});
    const d = await r.json();
    const st = document.getElementById('xCookieState');
    if (d.ok) { if (st) st.textContent = '已保存 ✓'; if (inp) inp.value = ''; }
    else { alert('保存失败：' + (d.msg||'')); }
  }catch(e){ alert('保存失败：' + e); }
}
async function xLoadCookie(){
  try{
    const r = await fetch('/api/x-get-cookie');
    const d = await r.json();
    const st = document.getElementById('xCookieState');
    if (st) st.textContent = d.has ? ('已设置（' + (d.preview||'') + '）') : '未设置';
  }catch(e){}
}
// 关闭窗口/刷新时自动停止下载
window.addEventListener('beforeunload', function(){
  try { navigator.sendBeacon('/api/stop', ''); } catch(e) {
    try { fetch('/api/stop', {method:'POST', keepalive:true}); } catch(e2){}
  }
});
window.addEventListener('pagehide', function(){
  try { navigator.sendBeacon('/api/stop', ''); } catch(e){}
});
setTimeout(xLoadCookie, 800);
async function dlFetch(){
  const raw = document.getElementById('xUrl').value.trim();
  const log = document.getElementById('xLog');
  if (!raw) { alert('先贴链接（一行一条）'); return; }
  const links = raw.split(String.fromCharCode(10)).map(function(x){ return String(x).trim(); }).filter(function(x){ return x; });
  const lines = [];
  dlFilesCache = [];
  let okCount = 0, badCount = 0;
  for (let i = 0; i < links.length; i++){
    log.textContent = '下载 ' + (i + 1) + ' / ' + links.length + ' …（每条可能几十秒）';
    try{
      const r = await fetch('/api/dl',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:links[i]})});
      const d = await r.json();
      if (d.ok) { okCount++; (d.files||[]).forEach(function(ff){ dlFilesCache.push(ff); }); lines.push('OK  ' + (d.count||0) + ' 个文件 / ' + ((d.bytes||0)/1048576).toFixed(1) + ' MB'); }
      else { badCount++; lines.push('FAIL  ' + links[i].slice(0,50) + ' ｜ ' + (d.msg||'?')); }
    }catch(e){ badCount++; lines.push('ERR  ' + e); }
  }
  log.textContent = '完成 ｜ 成功 ' + okCount + ' ｜ 失败 ' + badCount + String.fromCharCode(10) + String.fromCharCode(10) + lines.join(String.fromCharCode(10));
  renderDlFiles();
}
let dlFilesCache = [];
function renderDlFiles(){
  const box = document.getElementById('xList');
  if (!box) return;
  if (!dlFilesCache.length) { box.innerHTML = ''; return; }
  let html = '';
  dlFilesCache.forEach(function(f, i){
    const ext = (f.ext||'').toLowerCase();
    const isImg = ['jpg','jpeg','png','webp','gif'].indexOf(ext) >= 0;
    const isVid = ['mp4','webm','mkv','mov','m4v'].indexOf(ext) >= 0;
    const url = '/file?p=' + encodeURIComponent(f.path);
    html += '<div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-top:10px;background:var(--glass)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">';
    html += '<div style="font-size:12px;word-break:break-all">' + esc(f.name) + ' <span style="color:var(--fg3);font-size:10.5px">' + (f.size/1048576).toFixed(1) + ' MB</span></div>';
    html += '<button class="ghost" onclick="revealFile(' + i + ')">打开位置</button>';
    html += '</div>';
    if (isImg) html += '<img src="' + url + '" style="max-width:240px;max-height:180px;border-radius:8px;margin-top:8px;display:block"/>';
    else if (isVid) html += '<video src="' + url + '" controls style="max-width:340px;max-height:220px;border-radius:8px;margin-top:8px;display:block"></video>';
    html += '</div>';
  });
  box.innerHTML = html;
}
function revealFile(i){
  const f = dlFilesCache[i];
  if (!f) return;
  fetch('/api/reveal?p=' + encodeURIComponent(f.path)).then(function(r){ return r.json(); }).then(function(d){
    if (!d.ok) alert('打不开：' + (d.msg||''));
  }).catch(function(e){ alert('打不开：' + e); });
}

async function xDownload(i, quiet){
  const m = xMedia[i];
  const log = document.getElementById('xLog');
  if (!m) return null;
  if (!quiet) log.textContent = '下载中…';
  const name = 'x_' + Date.now() + '_' + i;
  try{
    const r = await fetch('/api/x-download',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:m.url, kind:m.kind, name:name, owner:xOwner})});
    const d = await r.json();
    if (!quiet) log.textContent = d.ok ? ('已保存到 ' + (d.rel || d.file) + ' ｜ ' + d.sizeMB + ' MB' + (d.note ? (' ｜ ' + d.note) : '')) : (d.msg || '下载失败');
    return d;
  }catch(e){ if (!quiet) log.textContent = '失败：' + e; return null; }
}
async function xDownloadAll(){
  const log = document.getElementById('xLog');
  if (!xMedia.length) { log.textContent = '先解析一条推文'; return; }
  let ok = 0, fail = 0;
  const lines = [];
  for (let i = 0; i < xMedia.length; i++){
    log.textContent = '批量下载 ' + (i + 1) + ' / ' + xMedia.length + ' …';
    const d = await xDownload(i, true);
    if (d && d.ok) { ok++; lines.push((d.rel || '') + ' ' + d.sizeMB + 'MB'); }
    else { fail++; lines.push('失败:' + ((d && d.msg) || '未知')); }
  }
  log.textContent = '批量完成 ｜ 成功 ' + ok + ' ｜ 失败 ' + fail + ' ｜ ' + lines.join(' ; ');
}
function pickDrive(v){
  if (!v) return;
  document.getElementById('libRoot').value = v;
  libRootDirty = true;
}
let moveTimer = null;
async function moveLibrary(){
  const t = document.getElementById('libRoot').value.trim();
  if (!t) { alert('先在输入框里填一个目录，或点「选择…」挑一个'); return; }
  let filesTxt = '', gbTxt = '';
  try {
    const st = await (await fetch('/api/status')).json();
    filesTxt = (st.libImages || 0).toLocaleString();
    gbTxt = String(st.libGB || 0);
  } catch (e) {}
  if (!confirm('准备搬运 ' + filesTxt + ' 个文件 / ' + gbTxt + ' GB，目标：' + t + ' 。确认开始？')) return;
  const r = await fetch('/api/move-library',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:t})});
  const d = await r.json();
  if (!d.ok) { alert('没开始：' + (d.msg||'')); return; }
  const box = document.getElementById('moveBox');
  box.style.display = 'block';
  document.getElementById('moveTitle').textContent = '搬运中：' + d.from + ' → ' + d.to;
  document.getElementById('moveFill').style.width = '0%';
  document.getElementById('movePct').textContent = '0%';
  document.getElementById('moveLog').textContent = '启动 robocopy…';
  if (moveTimer) clearInterval(moveTimer);
  const NL = String.fromCharCode(10);
  moveTimer = setInterval(async function(){
    try{
      const p = await (await fetch('/api/move-progress')).json();
      const pct = Math.min(100, Number(p.pct) || 0);
      document.getElementById('moveFill').style.width = pct + '%';
      document.getElementById('movePct').textContent = pct.toFixed(1) + '%';
      document.getElementById('moveLog').textContent = (p.log || []).slice(-16).join(NL) || '（等输出…）';
      if (!p.running) {
        clearInterval(moveTimer);
        moveTimer = null;
        document.getElementById('moveTitle').textContent = p.ok ? ('搬运完成 → ' + p.to) : ('搬运结束，退出码 ' + p.code);
        if (p.ok) { libRootDirty = false; poll(); }
      }
    }catch(e){}
  }, 1200);
}
document.addEventListener('keydown', function(ev){
  var on = document.getElementById('modal').className.indexOf('on') >= 0;
  if (ev.key === 'Escape') { closeModal(); return; }
  if (!on) return;
  if (ev.key === 'ArrowLeft') prevImg();
  if (ev.key === 'ArrowRight') nextImg();
});
let gDir = '', gPage = 1, gTotal = 0, gSize = 60, gFiles = [], gIndex = -1, libRootDirty = false;
const ELEM_ICONS = {
  cryo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M12 2v20M4 6l16 12M20 6L4 18"/><path d="M12 6l-3 3M12 6l3 3M12 18l-3-3M12 18l3-3"/></svg>',
  electro: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M13 2L5 13h6l-1 9 9-12h-6z"/></svg>',
  pyro: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M12 2c3 4 6 6 6 10a6 6 0 11-12 0c0-2 1-3 2-4 0 2 1 3 2 3 0-4 1-7 2-9z"/></svg>',
  dendro: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M12 21V9M12 9c0-4 3-7 7-7 0 5-3 8-7 8zM12 13c0-3-2-5-5-5 0 3 2 5 5 5z"/></svg>',
  hydro: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M12 2c4 5 6 8 6 12a6 6 0 11-12 0c0-4 2-7 6-12z"/></svg>',
  anemo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M3 8h11a3 3 0 10-3-3M3 12h15a3 3 0 11-3 3M3 16h7"/></svg>',
  geo: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><path d="M12 3l8 5v8l-8 5-8-5V8z"/></svg>',
  other: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><circle cx="12" cy="12" r="8"/></svg>'
};
const LEAF_MARK = '<svg viewBox="0 0 64 64" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.2"><path d="M32 8c10 6 16 14 16 24 0 12-8 22-16 24-8-2-16-12-16-24 0-10 6-18 16-24z"/><path d="M32 12v40M32 24l8 6M32 24l-8 6M32 36l8 6M32 36l-8 6"/></svg>';

const THEME_META = [
  { id:'ganyu',    en:'Ganyu',    cn:'甘雨 · 降雪',   el:'cryo',    tag:'冰',  c1:'#35577F', c2:'#16273D' },
  { id:'yae',      en:'Yae Miko', cn:'八重神子 · 神樱', el:'electro', tag:'雷',  c1:'#5B3A6B', c2:'#2A1533' },
  { id:'yoimiya',  en:'Yoimiya',  cn:'宵宫 · 烟火',   el:'pyro',    tag:'火',  c1:'#7A4A22', c2:'#3A2010' },
  { id:'nahida',   en:'Nahida',   cn:'纳西妲 · 新芽', el:'dendro',  tag:'草',  c1:'#2F5C46', c2:'#13301F' },
  { id:'furina',   en:'Furina',   cn:'芙宁娜 · 水幕', el:'hydro',   tag:'水',  c1:'#33547F', c2:'#152238' },
  { id:'faruzan',  en:'Faruzan',  cn:'法露珊 · 风带', el:'anemo',   tag:'风',  c1:'#2E5F5C', c2:'#0E2828' },
  { id:'zhongli',  en:'Zhongli',  cn:'钟离 · 岩心',   el:'geo',     tag:'岩',  c1:'#6B5220', c2:'#33240C' },
  { id:'elaina',   en:'Elaina',   cn:'伊蕾娜 · 魔女', el:'other',   tag:'旅',  c1:'#4A3E63', c2:'#1D1828' },
  { id:'paper',    en:'Paper',    cn:'纸感 · 出版物', el:'other',   tag:'纸',  c1:'#9A958C', c2:'#4A4740' },
  { id:'darkroom', en:'Darkroom', cn:'暗房 · 纯黑',   el:'other',   tag:'黑',  c1:'#4A4A4A', c2:'#101010' },
  { id:'agency',   en:'Agency',   cn:'品牌粉',        el:'other',   tag:'粉',  c1:'#B5407A', c2:'#5A1F3C' },
  { id:'saas',     en:'SaaS',     cn:'工具蓝',        el:'other',   tag:'蓝',  c1:'#2F63B5', c2:'#17305A' },
  { id:'social',   en:'Social',   cn:'社交红',        el:'other',   tag:'红',  c1:'#A53048', c2:'#4A1520' },
  { id:'silicon',  en:'Silicon',  cn:'硅基紫',        el:'other',   tag:'紫',  c1:'#6B4A9E', c2:'#2A1B3F' },
  { id:'wallet',   en:'Wallet',   cn:'金融蓝',        el:'other',   tag:'金',  c1:'#3F4A9E', c2:'#1A192E' }
];
let T_FILTER = 'all';
function renderFilters(){
  const box = document.getElementById('tFilters');
  if (!box) return;
  const items = [['all','全部'],['cryo','冰'],['hydro','水'],['electro','雷'],['pyro','火'],['dendro','草'],['anemo','风'],['geo','岩'],['other','其他']];
  box.innerHTML = items.map(function(it){
    return '<button class="tf' + (T_FILTER === it[0] ? ' act' : '') + '" data-f="' + it[0] + '">' + it[1] + '</button>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('.tf'), function(b){
    b.addEventListener('click', function(){
      T_FILTER = b.getAttribute('data-f');
      renderFilters(); renderThemeGrid();
    });
  });
}
function renderThemeGrid(){
  const g = document.getElementById('themeGrid');
  if (!g) return;
  const cur = document.body.getAttribute('data-theme') || 'elaina';
  let list = THEME_META;
  if (T_FILTER !== 'all') list = THEME_META.filter(function(t){ return t.el === T_FILTER; });
  if (!list.length) { g.innerHTML = '<div class="empty">这个元素还没有主题</div>'; return; }
  g.innerHTML = list.map(function(t){
    const act = (t.id === cur) ? ' act' : '';
    return '<div class="tcard' + act + '" data-th="' + t.id + '" style="background:linear-gradient(150deg,' + t.c1 + '1a,' + t.c2 + '3d)">'
      + '<div class="tcTop"><div class="tcIcon">' + (ELEM_ICONS[t.el] || ELEM_ICONS.other) + '</div><div class="tcMark">' + LEAF_MARK + '</div></div>'
      + '<div class="tcBottom"><div class="tcEn">' + t.en + '</div><div class="tcCn">' + t.cn + '</div></div>'
      + '<div class="tcTag">' + t.tag + '</div>'
      + '</div>';
  }).join('');
  Array.prototype.forEach.call(g.querySelectorAll('.tcard'), function(el){
    el.addEventListener('click', function(){
      setTheme(el.getAttribute('data-th'));
      renderThemeGrid();
    });
  });
}
function shellAction(act){
  try{
    if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
      window.chrome.webview.postMessage({ type: 'shellAction', action: act });
    } else {
      alert('这个功能需要桌面窗口（WebView2）环境');
    }
  }catch(e){}
}
function playElainaIntro(){
  try{
    const el = document.getElementById('gg-elaina-intro');
    if (!el) return;
    const vid = document.getElementById('ei-video');

    const close = function(){
      try { el.classList.add('out'); } catch(e){}
      setTimeout(function(){
        try { el.classList.remove('on','out'); } catch(e){}
        try { if (vid) { vid.pause(); vid.currentTime = 0; } } catch(e){}
      }, 900);
    };

    // 星尘（无视频时的兜底背景）
    const stars = document.getElementById('eiStars');
    if (stars && !stars.childElementCount) {
      let html = '';
      for (let i = 0; i < 46; i++) {
        const x = Math.random() * 100, y = Math.random() * 100, d = (Math.random() * 2.6).toFixed(2), sc = (0.6 + Math.random() * 1.1).toFixed(2);
        html += '<i style="left:' + x + '%;top:' + y + '%;animation-delay:' + d + 's;transform:scale(' + sc + ')"></i>';
      }
      stars.innerHTML = html;
    }

    el.classList.remove('out');
    el.classList.add('on');
    el.onclick = close;

    // 优先播放开场视频
    fetch('/wallpaper?theme=elaina&type=intro-video', { method: 'GET', headers: { 'Range': 'bytes=0-1' } })
      .then(function(r){
        if ((r.status === 200 || r.status === 206) && vid) {
          el.classList.add('has-video');
          vid.muted = false;
          vid.volume = 1;
          const p = vid.play();
          if (p && p.catch) {
            p.catch(function(){
              // 浏览器拦截带声播放 -> 静音重试
              vid.muted = true;
              vid.play().catch(function(){});
            });
          }
          vid.onended = close;
          // 兜底：视频时长 + 1 秒后强制关
          setTimeout(close, Math.max(9000, (vid.duration || 8.4) * 1000 + 800));
        } else {
          el.classList.remove('has-video');
          setTimeout(close, 3400);
        }
      })
      .catch(function(){
        el.classList.remove('has-video');
        setTimeout(close, 3400);
      });
  }catch(e){}
}
function initSideNav(){
  const items = document.querySelectorAll('.snavItem');
  if (!items.length) return;
  Array.prototype.forEach.call(items, function(it){
    it.addEventListener('click', function(){
      const t = it.getAttribute('data-tab');
      switchTab(t);
      syncSideNav(t);
    });
  });
  syncSideNav('dl');
}
function syncSideNav(t){
  Array.prototype.forEach.call(document.querySelectorAll('.snavItem'), function(x){
    x.className = 'snavItem' + (x.getAttribute('data-tab') === t ? ' act' : '');
  });
}
function initSideNavOnce(){ if (!window.__snavInit) { window.__snavInit = true; initSideNav(); } }
setTimeout(initSideNavOnce, 200);
function switchTab(t){
  const dl = document.getElementById('pageDl');
  const gal = document.getElementById('pageGal');
  document.getElementById('tabDl').className = 'tab' + (t==='dl'?' act':'');
  document.getElementById('tabGal').className = 'tab' + (t==='gal'?' act':'');
  const xp = document.getElementById('pageX');
  if (dl) dl.style.display = (t==='dl') ? 'block' : 'none';
  if (gal) gal.style.display = (t==='gal') ? 'block' : 'none';
  if (xp) xp.style.display = (t==='x') ? 'block' : 'none';
  const fp = document.getElementById('pageFish');
  if (fp) fp.style.display = (t==='fish') ? 'block' : 'none';
  if (t === 'fish') initFishDrag();
  const tp2 = document.getElementById('pageThemes');
  if (tp2) tp2.style.display = (t==='themes') ? 'block' : 'none';
  if (t === 'themes') { renderFilters(); renderThemeGrid(); }
  syncSideNav(t);
  try { const sf = document.getElementById('sfTheme'); if (sf) { const nm = {ganyu:'甘雨',yae:'八重神子',yoimiya:'宵宫',nahida:'纳西妲',furina:'芙宁娜',faruzan:'法露珊',zhongli:'钟离',elaina:'伊蕾娜',paper:'纸感',darkroom:'暗房',agency:'品牌粉',saas:'工具蓝',social:'社交红',silicon:'硅基紫',wallet:'金融蓝'}; sf.textContent = nm[t] || ''; } } catch(e) {}
  if (t==='gal' && !document.getElementById('tree').dataset.loaded) loadTree();
}
async function loadTree(){
  const box = document.getElementById('tree');
  box.dataset.loaded = '1';
  try{
    const r = await fetch('/api/tree');
    const tree = await r.json();
    if (!tree.length){ box.innerHTML = '<div class="empty">cosplay 目录还是空的</div>'; return; }
    let html = '';
    tree.forEach(function(c, ci){
      html += '<div class="coser" data-ci="' + ci + '" data-name="' + esc(c.name) + '"><span>' + esc(c.name) + '</span><span class="cmeta">' + c.works.length + '<b class="dl" title="只下这位">↓</b></span></div>';
      html += '<div id="cw' + ci + '" style="display:none">';
      c.works.forEach(function(w, wi){
        html += '<div class="work" data-ci="' + ci + '" data-wi="' + wi + '">' + esc(w.name) + ' <span style="color:#b3b0a8">(' + w.roles.length + ')</span></div>';
        html += '<div id="cr' + ci + '_' + wi + '" style="display:none">';
        w.roles.forEach(function(ro){
          const rel = c.name + '/' + w.name + '/' + ro.name;
          html += '<div class="role" data-dir="' + esc(rel) + '">' + esc(ro.name) + ' <span style="color:#b3b0a8">' + ro.count + '</span></div>';
        });
        html += '</div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }catch(e){ box.innerHTML = '<div class="empty">读取失败</div>'; }
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function toggleCoser(i){ const el = document.getElementById('cw'+i); el.style.display = el.style.display==='none'?'block':'none'; }
function toggleWork(i,w){ const el = document.getElementById('cr'+i+'_'+w); el.style.display = el.style.display==='none'?'block':'none'; }
async function openDir(el){
  document.querySelectorAll('.role.sel').forEach(function(x){ x.className='role'; });
  if (el) el.className = 'role sel';
  gDir = el ? el.getAttribute('data-dir') : '';
  gPage = 1;
  document.getElementById('crumb').textContent = gDir;
  loadPhotos();
}
async function loadPhotos(){
  const grid = document.getElementById('grid');
  grid.innerHTML = '<div class="empty">加载中…</div>';
  try{
    const r = await fetch('/api/photos?dir=' + encodeURIComponent(gDir) + '&page=' + gPage + '&size=' + gSize);
    const d = await r.json();
    gTotal = d.total || 0;
    gFiles = d.files || [];
    gIndex = -1;
    if (!d.files || !d.files.length){ grid.innerHTML = '<div class="empty">这个目录里没有图片</div>'; document.getElementById('pinfo').textContent = '0 张'; return; }
    let html = '';
    d.files.forEach(function(f){
      html += '<div class="cell" data-u="' + f.u + '"><img loading="lazy" src="' + f.u + '" alt=""/></div>';
    });
    grid.innerHTML = html;
    const pages = Math.max(1, Math.ceil(gTotal / gSize));
    document.getElementById('pinfo').textContent = '第 ' + gPage + ' / ' + pages + ' 页 · 共 ' + gTotal + ' 张';
  }catch(e){ grid.innerHTML = '<div class="empty">读取失败</div>'; }
}
function pageNav(d){
  if (!gDir) return;
  const pages = Math.max(1, Math.ceil(gTotal / gSize));
  const next = gPage + d;
  if (next < 1 || next > pages) return;
  gPage = next;
  loadPhotos();
}
poll();
setInterval(poll, 1500);
</script>
</main>
</div>
</body></html>`;

  const server = http.createServer((req, res) => {
    refreshDest();
    const u = new URL(req.url, 'http://127.0.0.1');
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, 'text/html; charset=utf-8', HTML);
    if (req.method === 'GET' && u.pathname === '/api/status') return send(200, 'application/json; charset=utf-8', JSON.stringify(status()));

    if (req.method === 'POST' && u.pathname === '/api/start') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const cfg = loadJson(CFG, { quotaGB: 20, minutes: 10 });
        const minutes = Math.max(1, parseFloat(body.minutes || cfg.minutes || 240));
        const quota = Math.max(1, parseFloat(body.quota || cfg.quotaGB || 20));
        const coser = String(body.coser || '').trim();
        if (worker) { send(200, 'application/json', JSON.stringify({ ok: false, msg: '已经在跑了' })); return; }
        try {
          const args = ['--worker', '--minutes', String(minutes), '--quota', String(quota)];
          if (coser) args.push('--coser', coser);
          const enginePath = fs.existsSync(path.join(ROOT, 'gallery-engine.exe'))
            ? path.join(ROOT, 'gallery-engine.exe')
            : process.execPath;
          let errFd = 'ignore';
          try { errFd = fs.openSync(path.join(ROOT, 'worker_err.log'), 'a'); } catch (e) { errFd = 'ignore'; }
          try { fs.appendFileSync(path.join(ROOT, 'worker_err.log'), new Date().toISOString() + '  spawn ' + enginePath + ' args=' + JSON.stringify(args) + '\n'); } catch (e) {}
          worker = cp.spawn(enginePath, args,
            { cwd: EXEDIR, stdio: ['ignore', 'ignore', errFd], windowsHide: true });
          worker.on('exit', () => { worker = null; });
          saveJson(STATUS, Object.assign(loadJson(STATUS, {}), { running: true, startedAt: new Date().toISOString(), pid: worker.pid, minutes, quotaGB: quota }));
          send(200, 'application/json', JSON.stringify({ ok: true, pid: worker.pid }));
        } catch (e) {
          send(500, 'application/json', JSON.stringify({ ok: false, msg: String(e).slice(0, 200) }));
        }
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/stop') {
      try {
        const st = loadJson(STATUS, {});
        if (worker) { try { cp.spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} worker = null; }
        if (st.pid && pidAlive(st.pid)) { try { cp.spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(st.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {} }
        saveJson(STATUS, Object.assign(loadJson(STATUS, {}), { running: false, finishedAt: new Date().toISOString() }));
        send(200, 'application/json', JSON.stringify({ ok: true }));
      } catch (e) { send(500, 'application/json', JSON.stringify({ ok: false })); }
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/config') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const cfg = loadJson(CFG, { quotaGB: 20, minutes: 10 });
        if (body.quotaGB > 0) cfg.quotaGB = Math.max(1, parseFloat(body.quotaGB));
        if (body.minutes > 0) cfg.minutes = Math.max(1, parseFloat(body.minutes));
        if (typeof body.libraryRoot === 'string') cfg.libraryRoot = body.libraryRoot.trim();
        saveJson(CFG, cfg);
        refreshDest();
        send(200, 'application/json', JSON.stringify({ ok: true, cfg }));
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/tree') return send(200, 'application/json; charset=utf-8', JSON.stringify(galleryTree()));

    if (req.method === 'GET' && u.pathname === '/api/photos') {
      const rel = u.searchParams.get('dir') || '';
      const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10));
      const size = Math.min(200, Math.max(20, parseInt(u.searchParams.get('size') || '60', 10)));
      const full = safeJoin(rel);
      let files = [];
      if (full && fs.existsSync(full)) {
        try { files = fs.readdirSync(full).filter((f) => /\.(webp|jpg|jpeg|png|gif)$/i.test(f)).sort(); } catch (e) {}
      }
      const total = files.length;
      const slice = files.slice((page - 1) * size, page * size);
      return send(200, 'application/json; charset=utf-8', JSON.stringify({
        total: total, page: page, size: size,
        files: slice.map((f) => ({ n: f, rel: rel + '/' + f, u: '/img?p=' + encodeURIComponent(rel + '/' + f) }))
      }));
    }

    if (req.method === 'GET' && u.pathname === '/img') {
      const rel = u.searchParams.get('p') || '';
      const full = safeJoin(rel);
      if (!full || !fs.existsSync(full)) { res.writeHead(404); res.end('no'); return; }
      try { if (!fs.statSync(full).isFile()) { res.writeHead(404); res.end('no'); return; } } catch (e) { res.writeHead(404); res.end('no'); return; }
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/webp';
      try {
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=86400' });
        const rs = fs.createReadStream(full);
        rs.on('error', function () { try { res.destroy(); } catch (e) {} });
        res.on('error', function () { try { rs.destroy(); } catch (e) {} });
        rs.pipe(res);
      } catch (e) { try { res.destroy(); } catch (e2) {} }
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/pick-folder') {
      const PF = PICKSTATE;
      const OUTP = PICKRESULT;
      try {
        const st = loadJson(PF, {});
        if (st.running && Date.now() - new Date(st.startedAt || 0).getTime() < 30000) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, started: false, msg: '上一次的选择框还开着，先把那个框关掉再点' }));
          return;
        }
        try { fs.writeFileSync(OUTP, ''); } catch (e) {}
        saveJson(PF, { running: true, startedAt: new Date().toISOString(), path: '', code: null });
        const picker = path.join(EXEDIR, 'PickFolder.exe');
        if (!fs.existsSync(picker)) {
          saveJson(PF, { running: false, path: '', code: -1 });
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'PickFolder.exe 不见了，请手动填路径' }));
          return;
        }
        const ps = cp.spawn(picker, [OUTP], { windowsHide: true, cwd: EXEDIR });
        ps.on('close', function (code) {
          let picked = '';
          try { picked = fs.readFileSync(OUTP, 'utf8').trim(); } catch (e) {}
          saveJson(PF, { running: false, path: picked, code: code });
          try { fs.appendFileSync(PICKLOG, new Date().toISOString() + '  code=' + code + ' path=' + picked + '\n'); } catch (e) {}
        });
        ps.on('error', function (e) {
          saveJson(PF, { running: false, path: '', error: String(e).slice(0, 150) });
          try { fs.appendFileSync(PICKLOG, new Date().toISOString() + '  spawn error ' + String(e).slice(0, 200) + '\n'); } catch (x) {}
        });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, started: true }));
      } catch (e) {
        send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: String(e).slice(0, 150) }));
      }
      return;
    }


    if (req.method === 'GET' && u.pathname === '/api/pick-result') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(loadJson(PICKSTATE, { running: false, path: '' })));
    }

    if (req.method === 'POST' && u.pathname === '/api/move-library') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const target = String(body.target || '').trim();
        if (!target) { send(400, 'application/json', JSON.stringify({ ok: false, msg: '没填目录' })); return; }
        const src = DEST;
        if (path.resolve(src).toLowerCase() === path.resolve(target).toLowerCase()) {
          send(200, 'application/json', JSON.stringify({ ok: false, msg: '源和目标一样' })); return;
        }
        if (/^[A-Za-z]:[\\/]?$/.test(target)) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '盘符根目录写不进去（Windows 保护），请在后面加个文件夹名，比如 D:/图库' }));
          return;
        }
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
        try {
          fs.accessSync(target, fs.constants.W_OK);
        } catch (e) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '这个目录写不进去（权限不足）：' + target }));
          return;
        }
        const PF = MOVEPROG;
        const startedAt = new Date().toISOString();
        saveJson(PF, { running: true, pct: 0, from: src, to: target, startedAt: startedAt, files: 0, total: 0, bytes: 0, log: ['开始扫描源目录…'] });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, started: true, from: src, to: target }));
        (async function () {
          const files = [];
          async function walk(d) {
            let ents = [];
            try { ents = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
            for (const e of ents) {
              const p2 = path.join(d, e.name);
              if (e.isDirectory()) await walk(p2);
              else files.push(p2);
            }
          }
          try {
            await walk(src);
            const total = files.length;
            let done = 0, bytes = 0, lastSave = 0, errCount = 0;
            const errLog = [];
            saveJson(PF, { running: true, pct: 0, from: src, to: target, startedAt: startedAt, files: 0, total: total, bytes: 0, log: ['共 ' + total + ' 个文件，开始搬运…'] });
            for (const f of files) {
              const rel = path.relative(src, f);
              const t2 = path.join(target, rel);
              let sz = 0;
              try { sz = (await fs.promises.stat(f)).size; } catch (e) {}
              try {
                await fs.promises.mkdir(path.dirname(t2), { recursive: true });
                try { await fs.promises.rename(f, t2); }
                catch (e1) {
                  try { await fs.promises.copyFile(f, t2); await fs.promises.unlink(f); }
                  catch (e2) { throw new Error('rename:' + (e1.code || e1.message) + ' copy:' + (e2.code || e2.message)); }
                }
                done++;
                bytes += sz;
              } catch (e) {
                errCount++;
                if (errCount <= 5) errLog.push(String(e.message || e).slice(0, 140) + ' @ ' + rel);
              }
              if (Date.now() - lastSave > 700) {
                lastSave = Date.now();
                const pct = total ? (done / total * 100) : 100;
                saveJson(PF, { running: true, pct: pct, from: src, to: target, startedAt: startedAt, files: done, total: total, bytes: bytes, log: ['已搬 ' + done + ' / ' + total + ' 个文件', '累计 ' + (bytes / 1073741824).toFixed(2) + ' GB', '当前：' + rel] });
              }
              if (done % 300 === 0) await new Promise(function (r) { setImmediate(r); });
            }
            const okFinal = (total === 0) || (done > 0);
            if (okFinal) {
              const cfg = loadJson(CFG, {});
              cfg.libraryRoot = target;
              saveJson(CFG, cfg);
              refreshDest();
            }
            const finalLog = ['完成：' + done + ' / ' + total + ' 个文件', '共 ' + (bytes / 1073741824).toFixed(2) + ' GB', '失败 ' + errCount + ' 个'];
            if (errLog.length) finalLog.push('错误样例：' + errLog[0]);
            for (let k = 1; k < errLog.length && k < 3; k++) finalLog.push('  ' + errLog[k]);
            if (!okFinal) finalLog.push('一个都没搬成，配置保持原样');
            saveJson(PF, { running: false, pct: total ? (done / total * 100) : 100, ok: okFinal, from: src, to: target, files: done, total: total, bytes: bytes, log: finalLog });
            try { fs.appendFileSync(MOVELOG, new Date().toISOString() + ' moved ' + src + ' -> ' + target + ' files=' + done + ' err=' + errCount + '\n'); } catch (e) {}
          } catch (e) {
            saveJson(PF, { running: false, pct: 0, ok: false, from: src, to: target, startedAt: startedAt, log: ['出错：' + String(e).slice(0, 200)] });
          }
        })();
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/running') {
      const stR = loadJson(STATUS, { running: false });
      const isRun = !!(stR.running && (worker || pidAlive(stR.pid)));
      return send(200, 'text/plain; charset=utf-8', isRun ? '1' : '0');
    }

    if (req.method === 'GET' && u.pathname === '/api/move-progress') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(loadJson(MOVEPROG, { running: false, pct: 0, log: [] })));
    }

    if (req.method === 'POST' && u.pathname === '/api/x-info') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const link = String(body.url || '').trim();
        const m = link.match(/(?:twitter\.com|x\.com)\/([^\/]+)\/status(?:es)?\/(\d+)/i);
        if (!m) { send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '链接里没找到推文 ID，形如 https://x.com/用户名/status/数字' })); return; }
        const user = m[1], id = m[2];
        const api = 'https://api.fxtwitter.com/status/' + id;
        let txt = '';
        try {
          const r1 = runCurl(['-s', '-L', '--max-time', '15', '-x', 'http://127.0.0.1:7890', api]);
          txt = (r1 && r1.stdout) ? String(r1.stdout) : '';
        } catch (e) { txt = ''; }
        if (!txt || txt.trim().charAt(0) !== '{') {
          try {
            const r2 = runCurl(['-s', '-L', '--max-time', '15', api]);
            txt = (r2 && r2.stdout) ? String(r2.stdout) : '';
          } catch (e) { txt = ''; }
        }
        let j = null;
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        if (!j || !j.tweet) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '解析失败（可能需要代理或推文已删）' }));
          return;
        }
        const tw = j.tweet;
        const media = [];
        const md = tw.media || {};
        (md.videos || []).forEach(function (v) {
          media.push({ kind: 'video', url: v.url, thumb: v.thumbnail_url, w: v.width, h: v.height, dur: v.duration });
        });
        (md.photos || []).forEach(function (ph) {
          media.push({ kind: 'photo', url: ph.url, thumb: ph.url });
        });
        (md.gifs || []).forEach(function (g) {
          media.push({ kind: 'gif', url: g.url, thumb: g.thumbnail_url, w: g.width, h: g.height });
        });
        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true, user: (tw.author && tw.author.screen_name) || user, id: id,
          text: String(tw.text || '').slice(0, 300), media: media
        }));
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/x-cookie') {
      try {
        const pyExe = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
        const script = path.join(EXEDIR, 'x_cookie.py');
        if (!fs.existsSync(script)) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'x_cookie.py 不在 app 目录里' }));
          return;
        }
        let killed = false;
        let r = cp.spawnSync(pyExe, [script], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
        let out = (r && r.stdout) ? String(r.stdout).trim() : '';
        let j = null;
        try { j = JSON.parse(out); } catch (e) { j = null; }
        // 第一次读不到（多半 Edge 占着），自动结束 Edge 再试一次
        const blocked = !j || !j.ok || (j.profiles || []).every(function (pf) { return (pf.cookies || []).length === 0; });
        if (blocked) {
          try {
            cp.spawnSync('C:\Windows\System32	askkill.exe', ['/IM', 'msedge.exe', '/F'], { windowsHide: true, timeout: 20000 });
            killed = true;
            const wait = cp.spawnSync('C:\Windows\System32\cmd.exe', ['/c', 'ping', '-n', '3', '127.0.0.1'], { windowsHide: true, timeout: 8000 });
            r = cp.spawnSync(pyExe, [script], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
            out = (r && r.stdout) ? String(r.stdout).trim() : '';
            try { j = JSON.parse(out); } catch (e) { j = null; }
          } catch (e) {}
        }
        if (!j || !j.ok) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '读不到 Edge 数据：' + ((j && j.error) || (r && r.stderr ? String(r.stderr).slice(0, 150) : '脚本失败')) }));
          return;
        }
        const key = Buffer.from(j.key_hex, 'hex');
        const found = {};
        let dbErr = '';
        (j.profiles || []).forEach(function (prof) {
          if (prof.error) dbErr = prof.error;
          (prof.cookies || []).forEach(function (c) {
            if (found[c.name]) return;
            try {
              const buf = Buffer.from(c.enc_hex, 'hex');
              if (buf.length < 34) return;
              const prefix = buf.slice(0, 3).toString('latin1');
              if (prefix !== 'v10' && prefix !== 'v11') return;
              const nonce = buf.slice(3, 15);
              const tag = buf.slice(buf.length - 16);
              const ct = buf.slice(15, buf.length - 16);
              const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
              d.setAuthTag(tag);
              const val = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
              found[c.name] = val;
            } catch (e) {}
          });
        });
        const names = Object.keys(found);
        const at = found['auth_token'], ct0 = found['ct0'];
        if (!at || !ct0) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({
            ok: false,
            msg: '自动读取失败（Edge 新版 cookie 用 v20 加密，普通方式解不开）。请手动复制：Edge 里按 F12 → Application → Cookies → https://x.com，把 auth_token 和 ct0 拼成 auth_token=...; ct0=... 粘进上面那个框。（' + (dbErr ? dbErr.slice(0, 60) + '；' : '') + '本次能解出的 cookie 名：' + (names.join(',') || '无') + '）。把 Edge 完全退出（任务管理器结束所有 msedge.exe）后再点一次。'
          }));
          return;
        }
        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true, cookie: 'auth_token=' + at + '; ct0=' + ct0, names: names, killedEdge: killed
        }));
      } catch (e) {
        send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: String(e).slice(0, 150) }));
      }
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/x-verify') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 200000) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        let ck = String(body.cookie || '').trim();
        if (!ck) { try { const sv = loadJson(path.join(DATA, 'x_cookie.json'), null); if (sv && sv.cookie) ck = String(sv.cookie); } catch (e) {} }
        if (!ck) { send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '还没有 cookie' })); return; }
        const bearer = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
        const csrf = (ck.match(/ct0=([^;]+)/) || [])[1] || '';
        const api = 'https://x.com/i/api/2/timeline/media/1405841808601481224.json?count=1';
        let txt = '', code = 0;
        try {
          const r = runCurl(['-s', '-L', '--max-time', '20', '-w', String.fromCharCode(10) + 'HTTP:%{http_code}', '-x', 'http://127.0.0.1:7890',
            '-H', 'authorization: Bearer ' + bearer,
            '-H', 'x-csrf-token: ' + csrf,
            '-H', 'cookie: ' + ck,
            '-H', 'x-twitter-active-user: yes',
            '-H', 'x-twitter-auth-type: OAuth2Session',
            '-A', UA, api]);
          const full = (r && r.stdout) ? String(r.stdout) : '';
          const mm = full.match(/HTTP:(\d+)\s*$/);
          if (mm) { code = parseInt(mm[1], 10); txt = full.replace(/HTTP:\d+\s*$/, '').trim(); }
          else { txt = full.trim(); }
        } catch (e) { code = -1; }
        let j = null;
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        if (code === 200 || (j && j.screen_name)) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({
            ok: true, screen_name: (j && j.screen_name) || '(已通过鉴权)', name: (j && j.screen_name) || '(已通过鉴权)',
            note: 'Cookie 有效，能过 X 鉴权'
          }));
        } else {
          const reason = code === 401 ? (txt.indexOf('32') >= 0 ? 'cookie 未被认可（code 32：auth_token 或 ct0 不对/不完整）' : 'cookie 无效或已过期（401）')
            : code === 403 ? '被 X 拦了（403），可能地区或风控'
            : code === 0 ? '没连上（代理不通或超时）'
            : ('接口返回 HTTP ' + code + '：' + txt.slice(0, 120));
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '验证失败：' + reason }));
        }
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/x-get-cookie') {
      let saved = null;
      try { saved = loadJson(path.join(DATA, 'x_cookie.json'), null); } catch (e) {}
      if (!saved || !saved.cookie) { return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false })); }
      const ck = String(saved.cookie);
      const at = (ck.match(/auth_token=([^;]+)/) || [])[1] || '';
      const c0 = (ck.match(/ct0=([^;]+)/) || [])[1] || '';
      return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, auth_token: at.trim(), ct0: c0.trim(), savedAt: saved.savedAt || '' }));
    }

    if (req.method === 'POST' && u.pathname === '/api/x-curl') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 4e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const curl = String(body.curl || '');
        if (curl.indexOf('curl') < 0) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '这不是一条 cURL 命令' }));
          return;
        }
        // 取 URL：curl 后第一个引号包裹或裸链接
        const um = curl.match(/curl[^'\"]*'([^']+)'/) || curl.match(/curl[^'\"]*\"([^\"]+)\"/) || curl.match(/curl\s+(\S+)/);
        if (!um) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'cURL 里找不到 URL' }));
          return;
        }
        const target = um[1];
        // 取所有 -H 头
        const headers = [];
        const hr = /-H\s+(['\"])((?:(?!\1).)*)\1/g;
        let hm;
        while ((hm = hr.exec(curl)) !== null) headers.push(hm[2]);
        const args = ['-s', '-L', '--max-time', '40', '-x', 'http://127.0.0.1:7890', '-A', UA];
        headers.forEach(function (h) { if (h.indexOf('content-length') < 0 && h.indexOf('Content-Length') < 0) args.push('-H', h); });
        args.push(target);
        let out = '';
        try {
          const r = runCurl(args);
          out = (r && r.stdout) ? String(r.stdout) : '';
        } catch (e) { out = ''; }
        if (!out) {
          try {
            const r2 = runCurl(args.filter(function (x, i) { return !(x === '-x' || (i > 0 && args[i - 1] === '-x')); }));
            out = (r2 && r2.stdout) ? String(r2.stdout) : '';
          } catch (e) { out = ''; }
        }
        if (!out) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '请求没返回内容（代理或 cookie 问题）' }));
          return;
        }
        // 解析媒体：JSON 或 HTML 都能处理
        const un = out.split('\\u002F').join('/').split('\\/').join('/');
        const photoSet = new Set();
        const pr = /https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)\.(jpg|png|webp)/g;
        let pm;
        while ((pm = pr.exec(un)) !== null) photoSet.add('https://pbs.twimg.com/media/' + pm[1] + '.' + pm[2] + '?name=orig');
        const vidBest = {};
        const vr = /https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\/(?:vid\/avc1\/)?(\d+)x(\d+)\/[A-Za-z0-9_\-]+\.mp4[A-Za-z0-9_\-.\/?=&%]*/g;
        let vm;
        while ((vm = vr.exec(un)) !== null) {
          const vid = vm[1];
          const area = parseInt(vm[2], 10) * parseInt(vm[3], 10);
          if (!vidBest[vid] || area > vidBest[vid].area) vidBest[vid] = { url: vm[0], area: area, w: parseInt(vm[2], 10), h: parseInt(vm[3], 10) };
        }
        // 推特媒体键（JSON 里的 media_keys / ext_media_availability）也兜一下
        const media = [];
        photoSet.forEach(function (u2) { media.push({ kind: 'photo', url: u2 }); });
        Object.keys(vidBest).forEach(function (k) { media.push({ kind: 'video', url: vidBest[k].url, w: vidBest[k].w, h: vidBest[k].h }); });
        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true, media: media, count: media.length,
          note: media.length ? ('从这条 cURL 的响应里解析到 ' + media.length + ' 个媒体') : '响应里没有媒体（可能是空 timeline，换个用户的请求试试）'
        }));
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/x-download-list') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 8e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const items = Array.isArray(body.items) ? body.items : [];
        const ownerRaw = String(body.owner || '').trim();
        const owner = ownerRaw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
        if (!items.length) { send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '没有要下载的地址' })); return; }
        const PF = path.join(DATA, 'x_dl_progress.json');
        saveJson(PF, { running: true, done: 0, total: items.length, ok: 0, fail: 0, current: '', startedAt: new Date().toISOString(), results: [] });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, started: true, total: items.length }));
        // 后台逐个下载，避免阻塞事件循环
        (async function () {
          let okCount = 0, failCount = 0;
          const results = [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i] || {};
            const u2 = String(it.url || '').trim();
            const kind = String(it.kind || 'photo').toLowerCase();
            saveJson(PF, { running: true, done: i, total: items.length, ok: okCount, fail: failCount, current: u2.slice(-60), startedAt: '', results: results.slice(-30) });
            // 跳过 HLS 分片（音频轨 / 0/0 分段），这些不是完整文件
            if (/\/aud\/mp4a\//i.test(u2) || /\/\d+\/0\/0\//.test(u2) || /\/seg-\d+/i.test(u2)) {
              results.push({ ok: false, url: u2.slice(-40), msg: 'skip hls segment' });
              continue;
            }
            if (!/^https?:\/\//i.test(u2)) { failCount++; results.push({ ok: false, msg: 'bad url' }); continue; }
            const isGif = kind === 'gif';
            const isPhoto = kind === 'photo' || kind === 'image';
            const typeName = isPhoto ? 'Picture' : (isGif ? 'GIF' : 'Video');
            const dir = owner ? path.join(XROOT, owner, typeName) : path.join(XROOT, typeName);
            try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
            const isM3u8 = /\.m3u8/i.test(u2);
            const ext = isPhoto ? '.jpg' : (isGif ? '.gif' : '.mp4');
            // 用媒体/视频 ID 命名，天然去重（重复下载会命中已有文件）
            let mediaId = '';
            let mm1 = u2.match(/amplify_video\/(\d+)/);
            if (mm1) mediaId = 'v_' + mm1[1];
            if (!mediaId) { mm1 = u2.match(/ext_tw_video\/(\d+)/); if (mm1) mediaId = 'v_' + mm1[1]; }
            if (!mediaId) { mm1 = u2.match(/\/media\/([A-Za-z0-9_-]+)/); if (mm1) mediaId = 'p_' + mm1[1]; }
            const base = mediaId || ('x_' + Date.now() + '_' + i);
            let outFile = path.join(dir, base + ext);
            const tmpFile = path.join(dir, base + '.download');
            if (fs.existsSync(outFile)) {
              try {
                if (fs.statSync(outFile).size > 3000) {
                  results.push({ ok: true, rel: path.relative(ROOT, outFile), skipped: true, msg: '已存在，跳过' });
                  continue;
                }
              } catch (e) {}
            }
            let got = false;
            if (isM3u8) {
              const ff = path.join(EXEDIR, 'ffmpeg.exe');
              if (fs.existsSync(ff)) {
                try {
                  cp.spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error',
                    '-http_proxy', 'http://127.0.0.1:7890',
                    '-i', u2, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile],
                    { windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
                  got = fs.existsSync(outFile) && fs.statSync(outFile).size > 3000;
                } catch (e) { got = false; }
              }
              if (got) {
                let size3 = 0;
                try { size3 = fs.statSync(outFile).size; } catch (e) {}
                okCount++;
                results.push({ ok: true, rel: path.relative(ROOT, outFile), sizeMB: +(size3 / 1048576).toFixed(2), note: 'm3u8→mp4' });
                await new Promise(function (r3) { setImmediate(r3); });
                continue;
              }
              failCount++;
              results.push({ ok: false, url: u2.slice(-50), msg: 'm3u8 转码失败' });
              continue;
            }
            try {
              runCurl(['-s', '-L', '--max-time', '90', '-A', UA, '-e', 'https://x.com/', '-x', 'http://127.0.0.1:7890', '-o', tmpFile, u2]);
              got = fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 3000;
            } catch (e) { got = false; }
            if (!got) {
              try {
                runCurl(['-s', '-L', '--max-time', '90', '-A', UA, '-e', 'https://x.com/', '-o', tmpFile, u2]);
                got = fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 3000;
              } catch (e) { got = false; }
            }
            if (!got) {
              try { fs.unlinkSync(tmpFile); } catch (e) {}
              failCount++;
              results.push({ ok: false, url: u2.slice(-50), msg: '下载失败' });
              continue;
            }
            if (isGif) {
              const ff = path.join(EXEDIR, 'ffmpeg.exe');
              let converted = false;
              if (fs.existsSync(ff)) {
                try {
                  cp.spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpFile,
                    '-vf', 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
                    '-loop', '0', outFile], { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
                  converted = fs.existsSync(outFile) && fs.statSync(outFile).size > 3000;
                } catch (e) { converted = false; }
              }
              if (converted) { try { fs.unlinkSync(tmpFile); } catch (e) {} }
              else { try { fs.renameSync(tmpFile, path.join(dir, base + '.mp4')); outFile = path.join(dir, base + '.mp4'); } catch (e) {} }
            } else {
              try { fs.renameSync(tmpFile, outFile); } catch (e) {}
            }
            let size = 0;
            try { size = fs.statSync(outFile).size; } catch (e) {}
            okCount++;
            results.push({ ok: true, rel: path.relative(ROOT, outFile), sizeMB: +(size / 1048576).toFixed(2) });
            await new Promise(function (r2) { setImmediate(r2); });
          }
          saveJson(PF, { running: false, done: items.length, total: items.length, ok: okCount, fail: failCount, finishedAt: new Date().toISOString(), results: results.slice(-50) });
        })();
      });
      return;
    }

    if (req.method === 'GET' && u.pathname === '/api/x-dl-progress') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify(loadJson(path.join(DATA, 'x_dl_progress.json'), { running: false, done: 0, total: 0 })));
    }


    if (req.method === 'GET' && u.pathname === '/icon.png') {
      const ip3 = path.join(EXEDIR, 'icon.png');
      if (fs.existsSync(ip3)) {
        try { send(200, 'image/png', fs.readFileSync(ip3)); } catch (e) { send(500, 'text/plain', 'fail'); }
        return;
      }
      send(404, 'text/plain', 'no icon');
      return;
    }
    if (req.method === 'GET' && u.pathname === '/wallpaper') {
      const th = String(u.searchParams.get('theme') || 'ganyu').replace(/[^a-z0-9_-]/gi, '');
      const dir = path.join(EXEDIR, 'bg');
      const wantVideo = u.searchParams.get('type') === 'video';
      if (u.searchParams.get('type') === 'intro-video') {
        const iv = path.join(dir, th + '-intro.mp4');
        if (fs.existsSync(iv)) {
          try {
            const st2 = fs.statSync(iv);
            const rg = req.headers.range;
            if (rg) {
              const mm2 = /bytes=(\d+)-(\d*)/.exec(rg);
              const s2 = mm2 ? parseInt(mm2[1], 10) : 0;
              const e2 = (mm2 && mm2[2]) ? parseInt(mm2[2], 10) : st2.size - 1;
              res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes ' + s2 + '-' + e2 + '/' + st2.size, 'Accept-Ranges': 'bytes', 'Content-Length': e2 - s2 + 1, 'Cache-Control': 'no-store' });
              fs.createReadStream(iv, { start: s2, end: e2 }).pipe(res);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st2.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
            fs.createReadStream(iv).pipe(res);
            return;
          } catch (e) { send(500, 'text/plain', 'intro video fail'); return; }
        }
        send(404, 'text/plain', 'no intro video');
        return;
      }
      if (u.searchParams.get('type') === 'line') {
        const lp = path.join(dir, th + '-line.png');
        if (fs.existsSync(lp)) { try { send(200, 'image/png', fs.readFileSync(lp)); } catch (e) { send(500, 'text/plain', 'fail'); } return; }
        send(404, 'text/plain', 'no line art');
        return;
      }
      if (u.searchParams.get('type') === 'intro-open') {
        const ip2 = path.join(dir, th + '-intro-open.png');
        if (fs.existsSync(ip2)) { try { send(200, 'image/png', fs.readFileSync(ip2)); } catch (e) { send(500, 'text/plain', 'fail'); } return; }
        send(404, 'text/plain', 'no intro open');
        return;
      }
      if (u.searchParams.get('type') === 'intro') {
        const ip = path.join(dir, th + '-intro.png');
        if (fs.existsSync(ip)) {
          try { send(200, 'image/png', fs.readFileSync(ip)); } catch (e) { send(500, 'text/plain', 'fail'); }
          return;
        }
        send(404, 'text/plain', 'no intro');
        return;
      }
      if (wantVideo) {
        const vf = path.join(dir, th + '.mp4');
        if (fs.existsSync(vf)) {
          try {
            const st = fs.statSync(vf);
            const range = req.headers.range;
            if (range) {
              const m = /bytes=(\d+)-(\d*)/.exec(range);
              const start = m ? parseInt(m[1], 10) : 0;
              const end = (m && m[2]) ? parseInt(m[2], 10) : st.size - 1;
              res.writeHead(206, {
                'Content-Type': 'video/mp4',
                'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Cache-Control': 'no-store'
              });
              fs.createReadStream(vf, { start: start, end: end }).pipe(res);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
            fs.createReadStream(vf).pipe(res);
            return;
          } catch (e) { send(500, 'text/plain; charset=utf-8', 'video read fail'); return; }
        }
        send(404, 'text/plain; charset=utf-8', 'no video');
        return;
      }
      let found = null;
      for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
        const f = path.join(dir, th + ext);
        if (fs.existsSync(f)) { found = f; break; }
      }
      if (!found) {
        for (const ext of ['.jpg', '.jpeg', '.png', '.webp']) {
          const f = path.join(dir, 'default' + ext);
          if (fs.existsSync(f)) { found = f; break; }
        }
      }
      if (!found) { send(404, 'text/plain; charset=utf-8', 'no wallpaper'); return; }
      const mime = found.toLowerCase().endsWith('.png') ? 'image/png' : (found.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      try {
        const buf = fs.readFileSync(found);
        send(200, mime, buf);
      } catch (e) { send(500, 'text/plain; charset=utf-8', 'read fail'); }
      return;
    }
    if (req.method === 'GET' && u.pathname === '/api/fish-status') {
      const jb = global.__fishJob || { running: false, elapsed: 0, result: null, error: null };
      send(200, 'application/json; charset=utf-8', JSON.stringify({
        running: !!jb.running,
        elapsed: jb.startedAt ? Math.round((Date.now() - jb.startedAt) / 1000) : 0,
        result: jb.result,
        error: jb.error
      }));
      return;
    }
    if (req.method === 'POST' && u.pathname === '/api/fish') {
      if (global.__fishJob && global.__fishJob.running) {
        const el = Math.round((Date.now() - (global.__fishJob.startedAt || Date.now())) / 1000);
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '上一张还在查（已 ' + el + ' 秒），等它出来' }));
        return;
      }
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 30e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const rel = String(body.path || '').trim();
        if (!rel && !body.data) { send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '没传图片路径' })); return; }
        let full = '';
        if (body.data) {
          try {
            const upDir = path.join(DATA, '_upload');
            fs.mkdirSync(upDir, { recursive: true });
            const safeName = String(body.name || 'upload.jpg').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
            full = path.join(upDir, Date.now() + '_' + safeName);
            fs.writeFileSync(full, Buffer.from(String(body.data), 'base64'));
          } catch (e) { full = ''; }
        } else if (/^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
          full = rel;
        } else {
          full = safeJoin(rel);
        }
        if (!full || !fs.existsSync(full)) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '图片不存在：' + rel }));
          return;
        }
        const fishDir = path.join(EXEDIR, 'fish');
        const entry = path.join(fishDir, 'bin', 'fish.mjs');
        if (!fs.existsSync(entry)) { send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'fish 插件没装（app\\fish 不存在）' })); return; }
        let nodeExe = path.join(EXEDIR, 'node.exe');
        if (!fs.existsSync(nodeExe)) nodeExe = 'C:\\Program Files\\nodejs\\node.exe';
        if (!fs.existsSync(nodeExe)) { send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '找不到 node.exe（需要 Node.js 运行时）' })); return; }

        global.__fishJob = { running: true, startedAt: Date.now(), result: null, error: null };
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, started: true }));

        setImmediate(function () {
          let out = '', errOut = '';
          try {
            const r = cp.spawnSync(nodeExe, [entry, full, '--json'], { cwd: fishDir, encoding: 'utf8', timeout: 200000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
            out = (r && r.stdout) ? String(r.stdout) : '';
            errOut = (r && r.stderr) ? String(r.stderr) : '';
          } catch (e) { errOut = String(e); }
          let j = null;
          try { j = JSON.parse(out.trim().replace(/^[^{]*/, '')); } catch (e) { j = null; }
          global.__fishJob = {
            running: false,
            startedAt: global.__fishJob ? global.__fishJob.startedAt : Date.now(),
            result: j || null,
            error: j ? null : ('插件没返回 JSON：' + (errOut || out).slice(0, 200))
          };
        });
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/x-set-cookie') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 200000) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const ck = String(body.cookie || '').trim();
        if (!ck) { send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'cookie 为空' })); return; }
        saveJson(path.join(DATA, 'x_cookie.json'), { cookie: ck, savedAt: new Date().toISOString() });
        send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, len: ck.length }));
      });
      return;
    }

    if (req.method === 'POST' && u.pathname === '/api/x-user') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 2e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const user = String(body.user || '').trim().replace(/^@/, '');
        let cookie = String(body.cookie || '').trim();
        if (!cookie) { try { const sv = loadJson(path.join(DATA, 'x_cookie.json'), null); if (sv && sv.cookie) cookie = String(sv.cookie); } catch (e) {} }
        if (!/^[A-Za-z0-9_]{1,30}$/.test(user)) {
          send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '用户名不合法' }));
          return;
        }
        let info = null;
        try {
          const r = runCurl(['-s', '-L', '--max-time', '15', '-x', 'http://127.0.0.1:7890', 'https://api.fxtwitter.com/' + user]);
          const t = (r && r.stdout) ? String(r.stdout) : '';
          const j = JSON.parse(t);
          if (j && j.user) info = j.user;
        } catch (e) { info = null; }
        if (!info) {
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '查不到这个用户（可能要代理，或用户名拼错）' }));
          return;
        }
        // 抓主页 HTML，解析内嵌媒体（不需要额外接口）
        let html = '';
        try {
          const args = ['-s', '-L', '--max-time', '25', '-x', 'http://127.0.0.1:7890', '-A', UA, 'https://x.com/' + user];
          // 匿名抓更可能拿到 SSR 内嵌数据；带 cookie 时 X 返回客户端渲染的空壳
          const r2 = runCurl(args);
          html = (r2 && r2.stdout) ? String(r2.stdout) : '';
        } catch (e) { html = ''; }
        if (!html) {
          try {
            const r3 = runCurl(['-s', '-L', '--max-time', '25', '-A', UA, 'https://x.com/' + user]);
            html = (r3 && r3.stdout) ? String(r3.stdout) : '';
          } catch (e) { html = ''; }
        }
        const un = String(html).split('\\u002F').join('/').split('\\/').join('/');
        const photoSet = new Set();
        const photoRe = /https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)\.(jpg|png|webp)/g;
        let mm;
        while ((mm = photoRe.exec(un)) !== null) photoSet.add('https://pbs.twimg.com/media/' + mm[1] + '.' + mm[2] + '?name=orig');
        const vidBest = {};
        const vidRe = /https:\/\/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\/(?:vid\/avc1\/)?(\d+)x(\d+)\/[A-Za-z0-9_\-]+\.mp4[A-Za-z0-9_\-.\/?=&%]*/g;
        while ((mm = vidRe.exec(un)) !== null) {
          const vid = mm[1];
          const area = parseInt(mm[2], 10) * parseInt(mm[3], 10);
          if (!vidBest[vid] || area > vidBest[vid].area) vidBest[vid] = { url: mm[0], area: area, w: parseInt(mm[2], 10), h: parseInt(mm[3], 10) };
        }
        const media = [];
        photoSet.forEach(function (u) { media.push({ kind: 'photo', url: u }); });
        Object.keys(vidBest).forEach(function (k) {
          const v = vidBest[k];
          media.push({ kind: 'video', url: v.url, w: v.w, h: v.h });
        });
        // 从页面里提取推文链接，供逐条解析
        const tidSet = new Set();
        const tidRe = /\/status\/(\d{15,20})/g;
        let tid;
        while ((tid = tidRe.exec(un)) !== null) tidSet.add(tid[1]);
        const tweetUrls = [];
        tidSet.forEach(function (id) { tweetUrls.push('https://x.com/' + info.screen_name + '/status/' + id); });
        const note = media.length
          ? ('页面解析到 ' + media.length + ' 个媒体，另提取 ' + tweetUrls.length + ' 条推文链接')
          : ('页面里没有媒体，但提取到 ' + tweetUrls.length + ' 条推文链接');
        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true, user: info.screen_name, name: info.name,
          mediaCount: info.media_count, followers: info.followers, tweets: info.tweets,
          desc: String(info.description || '').slice(0, 120),
          media: media, tweetUrls: tweetUrls, note: note
        }));
      });
      return;
    }


    if (req.method === 'POST' && u.pathname === '/api/x-download') {
      let raw = '';
      req.on('data', function (c) { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', function () {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (e) {}
        const mediaUrl = String(body.url || '').trim();
        const kind = String(body.kind || 'video').toLowerCase();
        const name = String(body.name || ('x_' + Date.now())).replace(/[\\\/:*?"<>|]/g, '_').slice(0, 120);
        if (!/^https?:\/\//i.test(mediaUrl)) { send(400, 'application/json', JSON.stringify({ ok: false, msg: '媒体地址不合法' })); return; }
        const isGif = kind === 'gif';
        const isPhoto = kind === 'photo' || kind === 'image';
        const typeName = isPhoto ? 'Picture' : (isGif ? 'GIF' : 'Video');
        const ownerRaw = String(body.owner || '').trim();
        const owner = ownerRaw.replace(/[\\\/:*?"<>|]/g, '_').slice(0, 40);
        const outDir = owner ? path.join(XROOT, owner, typeName) : path.join(XROOT, typeName);
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
        const ext = isPhoto ? '.jpg' : (isGif ? '.gif' : '.mp4');
        const outFile = path.join(outDir, name + ext);
        const tmpFile = path.join(outDir, name + '.download');
        const args = ['-s', '-L', '--max-time', '180', '-A', UA, '-e', 'https://x.com/', '-o', tmpFile];
        let ok = false;
        try {
          runCurl(args.concat(['-x', 'http://127.0.0.1:7890', mediaUrl]));
          ok = fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 2000;
        } catch (e) { ok = false; }
        if (!ok) {
          try {
            runCurl(args.concat([mediaUrl]));
            ok = fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 2000;
          } catch (e) { ok = false; }
        }
        if (!ok) {
          try { fs.unlinkSync(tmpFile); } catch (e) {}
          send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '下载失败（可能要开代理，或这条媒体需要登录）' }));
          return;
        }
        let finalFile = outFile;
        let note = '';
        if (isGif) {
          const ff = path.join(EXEDIR, 'ffmpeg.exe');
          let converted = false;
          if (fs.existsSync(ff)) {
            try {
              const rr = cp.spawnSync(ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpFile,
                '-vf', 'fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
                '-loop', '0', outFile], { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
              converted = fs.existsSync(outFile) && fs.statSync(outFile).size > 2000;
            } catch (e) { converted = false; }
          }
          if (converted) {
            try { fs.unlinkSync(tmpFile); } catch (e) {}
            note = '已转成 GIF';
          } else {
            // 转码失败：保留原 mp4 放进 GIF 目录，别丢文件
            const fallback = path.join(outDir, name + '.mp4');
            try { fs.renameSync(tmpFile, fallback); finalFile = fallback; } catch (e) {}
            note = 'ffmpeg 缺失或转码失败，已保留 mp4 原文件';
          }
        } else {
          try { fs.renameSync(tmpFile, finalFile); } catch (e) {}
        }
        let size = 0;
        try { size = fs.statSync(finalFile).size; } catch (e) {}
        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true, file: finalFile, rel: path.relative(ROOT, finalFile),
          sizeMB: +(size / 1048576).toFixed(2), note: note
        }));
      });
      return;
    }

    send(404, 'text/plain; charset=utf-8', 'not found');
  });

  server.listen(PORT, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + PORT + '/';
    if (process.env.GALLERY_SERVE === '1' || process.argv.includes('--serve')) return;
    try { cp.spawn('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', url], { windowsHide: true, detached: true }).unref(); } catch (e) {}
  });
  let bindRetry = 0;
  server.on('error', (err) => {
    // 端口被 TIME_WAIT / 其他进程占用时重试，而不是直接退出
    if (bindRetry < 20) {
      bindRetry++;
      setTimeout(() => {
        try { server.close(); } catch (e) {}
        try { server.listen(PORT, '127.0.0.1'); } catch (e) {}
      }, 1500);
      return;
    }
    if (process.env.GALLERY_SERVE === '1' || process.argv.includes('--serve')) { setTimeout(() => process.exit(0), 800); return; }
    try { cp.spawn('C:\\Windows\\System32\\cmd.exe', ['/c', 'start', '', 'http://127.0.0.1:' + PORT + '/'], { windowsHide: true, detached: true }).unref(); } catch (e) {}
    setTimeout(() => process.exit(0), 800);
  });
}

if (IS_WORKER) runWorker(); else runGui();
