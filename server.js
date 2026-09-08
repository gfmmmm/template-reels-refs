// server.js — 로컬 서버. 화면(index.html)을 띄우고 계정·경쟁사·설정·수집 요청을 받는다.
// 서버가 켜져 있는 동안 하루 한 번 경쟁사 팔로워 스냅샷을 자동으로 찍는다 (config.autoSnapshot).
// 외부 패키지 없음. Node.js 18 이상. 127.0.0.1:3456 에만 붙는다.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const THUMBS = path.join(DATA, 'thumbs');
const FILES = {
  config: path.join(DATA, 'config.json'),
  accounts: path.join(DATA, 'accounts.json'),
  refs: path.join(DATA, 'refs.json'),
  competitors: path.join(DATA, 'competitors.json'),
};
const HOST = '127.0.0.1';
const PORT = 3456;
const URL_BASE = `http://${HOST}:${PORT}`;
const DEFAULT_CONFIG = { minViews: 300000, initialPages: 3, maxPages: 3, nextRefNo: 1, myHandle: '', autoSnapshot: true, lastSnapshotDate: null, lastRunAt: null, lastSummary: null,
  channel: { brief: '', pillars: [] }, autoAnalyze: true, analyzeMax: 20, analyzeFails: {}, lastAnalyzeAt: null, lastAnalyzeSummary: null, myTranscripts: true, myTranscriptTop: 10 };

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Node.js 18 이상이 필요해요. 지금 버전: ${process.versions.node}\nhttps://nodejs.org 에서 LTS 버전을 설치해 주세요.`);
  process.exit(1);
}

// ───────────────────────── 파일 유틸 ─────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function ensureDataFiles() {
  fs.mkdirSync(THUMBS, { recursive: true });
  if (!fs.existsSync(FILES.config)) writeJsonAtomic(FILES.config, DEFAULT_CONFIG);
  if (!fs.existsSync(FILES.accounts)) writeJsonAtomic(FILES.accounts, []);
  if (!fs.existsSync(FILES.refs)) writeJsonAtomic(FILES.refs, []);
  if (!fs.existsSync(FILES.competitors)) writeJsonAtomic(FILES.competitors, { handles: [], snapshots: {}, reels: {}, profiles: {} });
}
const readConfig = () => Object.assign({}, DEFAULT_CONFIG, readJson(FILES.config, {}));
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 아이디 정리: @, 공백, instagram.com/ 접두, 끝 슬래시 제거 + 소문자
function normalizeHandle(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
  return s;
}
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;
const readList = (file) => readJson(file, []).map((a) => (typeof a === 'string' ? a : a && a.handle)).filter(Boolean);

// ───────────────────────── 수집 상태 ─────────────────────────
const status = {
  running: false,
  kind: null,          // 'collect' | 'snapshot' | 'analyze'
  log: [],
  summary: null,
  startedAt: null,
  finishedAt: null,
  lastRunAt: null,
  lastSnapshotDate: null,
  autoSnapshot: true,
};
{
  const cfg = readConfig();
  status.lastRunAt = cfg.lastRunAt || null;
  status.summary = cfg.lastSummary || null;
  status.finishedAt = cfg.lastRunAt || null;
  status.lastSnapshotDate = cfg.lastSnapshotDate || null;
  status.autoSnapshot = cfg.autoSnapshot !== false;
  status.analyzeSummary = cfg.lastAnalyzeSummary || null;
  status.lastAnalyzeAt = cfg.lastAnalyzeAt || null;
}
const hasGeminiKey = () => { if (process.env.GEMINI_API_KEY) return true; try { return /^GEMINI_API_KEY=\s*\S+/m.test(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); } catch { return false; } };

function pushLog(line) {
  status.log.push(line);
  if (status.log.length > 2000) status.log.splice(0, status.log.length - 2000);
}

function startCollect(kind = 'collect', extra = {}) {
  if (status.running) return false;
  status.running = true;
  status.kind = kind;
  status.log = [];
  if (kind === 'collect') status.summary = null;
  if (kind === 'analyze') status.analyzeSummary = null;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;

  const args = kind === 'analyze' ? [path.join(ROOT, 'analyze.js')] : [path.join(ROOT, 'collect.js')];
  if (kind === 'snapshot') args.push('--snapshot-only');
  if (kind === 'analyze' && extra.code) args.push('--code', extra.code);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
  let buf = '';
  let summary = null;
  const handleLine = (line) => {
    if (line.startsWith('SUMMARY ')) {
      try { summary = JSON.parse(line.slice(8)); } catch { pushLog('(요약을 읽지 못했어요)'); }
      return;
    }
    if (line.trim()) pushLog(line);
  };
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      handleLine(line);
    }
  });
  child.stderr.on('data', (c) => { for (const l of c.toString('utf8').split(/\r?\n/)) if (l.trim()) pushLog('⚠ ' + l); });
  child.on('error', (e) => { pushLog('✖ 수집 프로그램을 시작하지 못했어요: ' + e.message); });
  child.on('close', (code) => {
    if (buf.trim()) handleLine(buf);
    buf = '';
    status.running = false;
    status.finishedAt = new Date().toISOString();
    if (code !== 0 && !(summary && summary.error)) pushLog(`✖ 수집이 비정상 종료됐어요 (코드 ${code})`);
    // collect.js 가 config.json 에 요약을 저장했으므로 다시 읽어 상태를 맞춘다
    const cfg = readConfig();
    status.lastRunAt = cfg.lastRunAt || status.lastRunAt;
    status.lastSnapshotDate = cfg.lastSnapshotDate || status.lastSnapshotDate;
    if (kind === 'collect') status.summary = summary || cfg.lastSummary || null;
    else if (kind === 'analyze') { status.analyzeSummary = summary || cfg.lastAnalyzeSummary || null; status.lastAnalyzeAt = cfg.lastAnalyzeAt || status.lastAnalyzeAt; }
    else if (summary && !summary.error && status.summary) status.summary = Object.assign({}, status.summary, { creditsRemaining: summary.creditsRemaining });
    if (summary && summary.error && kind === 'collect') status.summary = summary;
    if (kind === 'analyze' && summary && typeof summary.creditsRemaining === 'number' && status.summary) status.summary = Object.assign({}, status.summary, { creditsRemaining: summary.creditsRemaining });
    status.kind = null;
    // 수집이 끝나면 자동 분석 (설정에서 끌 수 있음. Gemini 키 없으면 조용히 건너뜀)
    if (kind === 'collect' && summary && !summary.error && cfg.autoAnalyze !== false && hasGeminiKey()) {
      const refs = readJson(FILES.refs, []);
      if (refs.some((r) => r.status !== 'analyzed' && !r.hidden)) { const keep = status.log.slice(); setTimeout(() => { startCollect('analyze'); status.log = keep.concat(['', '━━ 수집이 끝나 AI 분석을 이어서 시작합니다 ━━']); }, 500); }
    }
  });
  return true;
}

// 하루 한 번 자동 스냅샷: 서버가 켜져 있는 동안 1시간마다 확인, 오늘 것이 없으면 실행
function autoSnapshotTick() {
  const cfg = readConfig();
  status.autoSnapshot = cfg.autoSnapshot !== false;
  if (!status.autoSnapshot || status.running) return;
  if (cfg.lastSnapshotDate === todayKey()) return;
  const comp = readJson(FILES.competitors, { handles: [] });
  const targets = [normalizeHandle(cfg.myHandle), ...(comp.handles || [])].filter(Boolean);
  if (!targets.length) return;
  console.log(`[자동] 오늘 팔로워 스냅샷이 없어 ${targets.length}개 계정을 찍습니다 (계정당 1크레딧)`);
  startCollect('snapshot');
}

// ───────────────────────── 채널 정체성 자동 분석 (content-agent api/channel-brief 이식) ─────────────────────────
// 내 게시물·프로필을 종합해 Gemini 가 "채널 정체성" 문서를 써서 돌려준다. 결과는 설정의 입력칸을 채우고, 사람이 검토 후 저장.
const BRIEF_SYSTEM = `너는 인스타그램 채널 브랜딩 전문가다. 주어진 계정 데이터(게시물·조회수·대본·영상분석)를 종합해 이 채널의 "정체성"을 한국어로 정리한다.
이 문서는 계정의 AI 에이전트들이 매번 참고하는 기준이 되므로, 실제 데이터에 근거해 구체적으로 써라.

반드시 아래 5가지를 포함하되, JSON·코드블록 없이 자연스러운 소제목+문단 형태로 작성:
1. 어떤 채널인가 (한마디로 정의)
2. 무엇을 주제로 하는가
3. 주로 어떤 경향이 있는가 (잘 되는 콘텐츠 vs 저조한 콘텐츠의 패턴)
4. 다른 계정과의 차별점
5. 강점과 포지셔닝

규칙: 추상적 미사여구·과장 금지. 조회수 편차·영상분석 코칭에서 드러난 실제 패턴을 근거로. 400~700자 분량.`;
function readEnvKey(name) {
  if (process.env[name]) return process.env[name];
  try { const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp('^' + name + '=\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; } catch { return ''; }
}
async function channelBrief() {
  const KEY = readEnvKey('GEMINI_API_KEY');
  if (!KEY) throw Object.assign(new Error('.env 에 GEMINI_API_KEY 가 없어요. aistudio.google.com 에서 무료로 발급해 넣고 서버를 다시 켜 주세요'), { status: 400 });
  const cfg = readConfig();
  const me = normalizeHandle(cfg.myHandle);
  if (!me) throw Object.assign(new Error('경쟁사 탭 오른쪽 위에서 내 계정을 먼저 넣어 주세요'), { status: 400 });
  const comp = readJson(FILES.competitors, { snapshots: {}, reels: {}, profiles: {} });
  const posts = Object.entries(comp.reels?.[me] || {}).map(([code, r]) => ({ code, ...r })).filter((r) => typeof r.views === 'number');
  if (!posts.length) throw Object.assign(new Error('내 릴스 데이터가 없어요. 설정에서 수집을 먼저 돌려 주세요'), { status: 400 });
  if (!posts.some((r) => r.caption)) throw Object.assign(new Error('내 릴스에 캡션이 아직 없어요. 수집을 한 번 더 돌리면 채워져요'), { status: 400 });
  const prof = comp.profiles?.[me] || {};
  const snaps = comp.snapshots?.[me] || [];
  const followers = snaps.length ? snaps[snaps.length - 1].followers : prof.followers;
  const avg = Math.round(posts.reduce((s, r) => s + r.views, 0) / posts.length);
  const byViews = posts.slice().sort((a, b) => b.views - a.views);
  const line = (p) => `- ${Math.round(p.views / 10000)}만회 · ${(p.caption || '(캡션 없음)').slice(0, 80)}`;
  const material = `## 계정 기본
핸들: @${me}
팔로워: ${followers ?? '?'}
소개(bio): ${prof.bio || '(없음)'}
평균 조회수: ${avg}
게시물 수: ${posts.length}

## 잘 된 게시물 (조회수 상위 12)
${byViews.slice(0, 12).map(line).join('\n')}

## 저조한 게시물 (조회수 하위 6)
${byViews.slice(-6).map(line).join('\n')}`;
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 90000);
  try {
    const gr = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ systemInstruction: { parts: [{ text: BRIEF_SYSTEM }] }, contents: [{ parts: [{ text: material }] }] }),
    });
    const gj = await gr.json().catch(() => ({}));
    if (!gr.ok) {
      const msg = (gj.error?.message || '').slice(0, 120);
      if (gr.status === 429) throw Object.assign(new Error('Gemini 무료 한도에 걸렸어요. 1분 뒤 다시 눌러 주세요'), { status: 502 });
      if (gr.status === 400 && /API key/i.test(msg)) throw Object.assign(new Error('Gemini API 키가 잘못됐어요. .env 를 확인해 주세요'), { status: 502 });
      throw Object.assign(new Error('Gemini 오류: ' + (msg || 'HTTP ' + gr.status)), { status: 502 });
    }
    const brief = (gj.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!brief) throw Object.assign(new Error('분석 결과가 비었어요. 다시 시도해 주세요'), { status: 502 });
    return { brief, posts: posts.length, followers };
  } finally { clearTimeout(to); }
}

// ───────────────────────── HTTP 도우미 ─────────────────────────
function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
const ok = (res, body) => send(res, 200, body);
const fail = (res, code, message) => send(res, code, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) { reject(new Error('요청이 너무 커요')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON 형식이 아니에요')); } });
    req.on('error', reject);
  });
}

// 정적 파일 (썸네일). 파일 이름은 코드+확장자만 허용해 경로 탈출을 막는다.
function serveFile(req, res, dir, name, re, type) {
  if (!re.test(name)) return fail(res, 400, '잘못된 파일 이름');
  const file = path.join(dir, name);
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return fail(res, 404, '없음');
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'public, max-age=86400' });
  return fs.createReadStream(file).pipe(res);
}

function accountsWithCounts() {
  const list = readList(FILES.accounts);
  const refs = readJson(FILES.refs, []);
  const counts = {};
  for (const r of refs) counts[r.account] = (counts[r.account] || 0) + 1;
  return list.map((h) => ({ handle: h, count: counts[h] || 0 }));
}
function competitorsPublic() {
  const comp = readJson(FILES.competitors, { handles: [], snapshots: {}, reels: {}, profiles: {} });
  const cfg = readConfig();
  return { myHandle: normalizeHandle(cfg.myHandle), handles: comp.handles || [], snapshots: comp.snapshots || {}, reels: comp.reels || {}, profiles: comp.profiles || {} };
}
function publicConfig(cfg) {
  return { minViews: Number(cfg.minViews) || 300000, initialPages: cfg.initialPages || 3, maxPages: cfg.maxPages || 3, myHandle: normalizeHandle(cfg.myHandle), autoSnapshot: cfg.autoSnapshot !== false, lastRunAt: cfg.lastRunAt || null, lastSnapshotDate: cfg.lastSnapshotDate || null,
    channel: { brief: String(cfg.channel?.brief || ''), pillars: Array.isArray(cfg.channel?.pillars) ? cfg.channel.pillars : [] }, autoAnalyze: cfg.autoAnalyze !== false, analyzeMax: Number(cfg.analyzeMax) || 20,
    geminiKey: hasGeminiKey(), lastAnalyzeAt: cfg.lastAnalyzeAt || null, myTranscripts: cfg.myTranscripts !== false, myTranscriptTop: Number(cfg.myTranscriptTop) || 10, failedCodes: Object.entries(cfg.analyzeFails || {}).filter(([, n]) => n >= 3).map(([c]) => c) };
}
function validateHandle(raw) {
  const handle = normalizeHandle(raw);
  if (!handle) return { error: '아이디를 입력해 주세요' };
  if (!HANDLE_RE.test(handle)) return { error: '아이디는 영문 소문자·숫자·점·밑줄만 쓸 수 있어요 (30자 이내)' };
  return { handle };
}

// ───────────────────────── 라우팅 ─────────────────────────
async function route(req, res) {
  const url = new URL(req.url, URL_BASE);
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
  }
  if (m === 'GET' && p.startsWith('/data/thumbs/')) {
    return serveFile(req, res, THUMBS, decodeURIComponent(p.slice('/data/thumbs/'.length)), /^[A-Za-z0-9_-]+\.jpg$/, 'image/jpeg');
  }
  if (m === 'GET' && p === '/api/refs') return ok(res, readJson(FILES.refs, []));
  if (m === 'GET' && p === '/api/accounts') return ok(res, accountsWithCounts());

  // 레퍼런스 계정
  if (m === 'POST' && p === '/api/accounts') {
    const body = await readBody(req);
    const v = validateHandle(body.handle);
    if (v.error) return fail(res, 400, v.error);
    const list = readList(FILES.accounts);
    if (!list.includes(v.handle)) { list.push(v.handle); writeJsonAtomic(FILES.accounts, list); }
    return ok(res, { handle: v.handle, accounts: accountsWithCounts() });
  }
  if (m === 'DELETE' && p.startsWith('/api/accounts/')) {
    const handle = normalizeHandle(p.slice('/api/accounts/'.length));
    const list = readList(FILES.accounts);
    const next = list.filter((h) => h !== handle);
    writeJsonAtomic(FILES.accounts, next); // 수집된 릴스(refs.json)는 남긴다
    return ok(res, { removed: list.length !== next.length, accounts: accountsWithCounts() });
  }

  // 경쟁사 계정
  if (m === 'GET' && p === '/api/competitors') return ok(res, competitorsPublic());
  if (m === 'POST' && p === '/api/competitors') {
    const body = await readBody(req);
    const v = validateHandle(body.handle);
    if (v.error) return fail(res, 400, v.error);
    const cfg = readConfig();
    if (normalizeHandle(cfg.myHandle) === v.handle) return fail(res, 400, '내 계정은 자동으로 비교에 들어가요. 경쟁사로 따로 넣지 않아도 돼요');
    const comp = readJson(FILES.competitors, { handles: [], snapshots: {}, reels: {}, profiles: {} });
    comp.handles = comp.handles || [];
    if (!comp.handles.includes(v.handle)) { comp.handles.push(v.handle); writeJsonAtomic(FILES.competitors, comp); }
    return ok(res, { handle: v.handle, competitors: competitorsPublic() });
  }
  if (m === 'DELETE' && p.startsWith('/api/competitors/')) {
    const handle = normalizeHandle(p.slice('/api/competitors/'.length));
    const comp = readJson(FILES.competitors, { handles: [], snapshots: {}, reels: {}, profiles: {} });
    const before = (comp.handles || []).length;
    comp.handles = (comp.handles || []).filter((h) => h !== handle); // 쌓인 스냅샷은 남긴다 (다시 넣으면 이어짐)
    writeJsonAtomic(FILES.competitors, comp);
    return ok(res, { removed: before !== comp.handles.length, competitors: competitorsPublic() });
  }

  if (m === 'GET' && p === '/api/config') return ok(res, publicConfig(readConfig()));
  if (m === 'POST' && p === '/api/config') {
    const body = await readBody(req);
    const cfg = readConfig();
    if (body.minViews !== undefined) {
      const n = Number(String(body.minViews).replace(/[,\s]/g, ''));
      if (!Number.isFinite(n) || n < 0) return fail(res, 400, '기준 조회수는 0 이상의 숫자여야 해요');
      cfg.minViews = Math.round(n);
    }
    if (body.myHandle !== undefined) {
      const h = normalizeHandle(body.myHandle);
      if (h && !HANDLE_RE.test(h)) return fail(res, 400, '아이디는 영문 소문자·숫자·점·밑줄만 쓸 수 있어요 (30자 이내)');
      cfg.myHandle = h;
    }
    if (body.autoSnapshot !== undefined) cfg.autoSnapshot = !!body.autoSnapshot;
    if (body.autoAnalyze !== undefined) cfg.autoAnalyze = !!body.autoAnalyze;
    if (body.myTranscripts !== undefined) cfg.myTranscripts = !!body.myTranscripts;
    if (body.channel !== undefined) {
      const brief = String(body.channel.brief || '').trim().slice(0, 2000);
      const pillars = (Array.isArray(body.channel.pillars) ? body.channel.pillars : String(body.channel.pillars || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
      cfg.channel = { brief, pillars };
    }
    if (body.resetFails) cfg.analyzeFails = {};
    writeJsonAtomic(FILES.config, cfg);
    status.autoSnapshot = cfg.autoSnapshot !== false;
    return ok(res, publicConfig(cfg));
  }

  // AI 분석 (전체 또는 한 건). 상업성 수동 교정·숨김 토글
  if (m === 'POST' && p === '/api/analyze') {
    if (!hasGeminiKey()) return fail(res, 400, '.env 에 GEMINI_API_KEY 가 없어요. aistudio.google.com 에서 무료로 발급해 넣고 서버를 다시 켜 주세요');
    if (status.running) return fail(res, 409, status.kind === 'analyze' ? '이미 분석이 돌아가고 있어요' : '수집이 돌아가는 중이에요. 끝나면 다시 눌러 주세요');
    const body = await readBody(req);
    startCollect('analyze', { code: body.code ? String(body.code).replace(/[^A-Za-z0-9_-]/g, '') : null });
    return ok(res, { started: true, startedAt: status.startedAt });
  }
  if (m === 'POST' && p.startsWith('/api/refs/')) {
    const [, , , codeRaw, action] = p.split('/');
    const code = decodeURIComponent(codeRaw || '');
    const refs = readJson(FILES.refs, []);
    const r = refs.find((x) => x.code === code);
    if (!r) return fail(res, 404, '릴스를 찾을 수 없어요');
    const body = await readBody(req);
    if (action === 'commerce') {
      if (!['일반', '공구', '광고'].includes(body.value)) return fail(res, 400, '일반·공구·광고 중 하나여야 해요');
      r.commerceOverride = body.value; // 사람이 고친 건 규칙보다 우선
    } else if (action === 'hidden') {
      r.hidden = !!body.value;
    } else return fail(res, 404, '없는 동작이에요');
    r.updatedAt = new Date().toISOString();
    writeJsonAtomic(FILES.refs, refs);
    return ok(res, r);
  }
  if (m === 'POST' && p === '/api/channel-brief') {
    try { return ok(res, await channelBrief()); }
    catch (e) { return fail(res, e.status || 500, e.message); }
  }
  if (m === 'POST' && p === '/api/collect') {
    if (status.running) return fail(res, 409, status.kind === 'snapshot' ? '자동 스냅샷이 돌아가는 중이에요. 잠시 뒤 다시 눌러 주세요' : '이미 수집이 돌아가고 있어요');
    startCollect('collect');
    return ok(res, { started: true, startedAt: status.startedAt });
  }
  if (m === 'GET' && p === '/api/status') return ok(res, status);

  return fail(res, 404, '없는 주소예요');
}

// ───────────────────────── 브라우저 열기 ─────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (e) => { if (e) console.log(`브라우저를 자동으로 열지 못했어요. 직접 열어 주세요: ${url}`); });
}

// ───────────────────────── 시작 ─────────────────────────
ensureDataFiles();
const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('요청 처리 중 오류:', e);
    if (!res.headersSent) fail(res, 500, e.message || '서버 오류');
  });
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log(`이미 켜져 있어요. 브라우저만 엽니다 → ${URL_BASE}`);
    openBrowser(URL_BASE);
    setTimeout(() => process.exit(0), 500);
    return;
  }
  console.error('서버를 시작하지 못했어요:', e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`릴스 레퍼런스 수집기가 켜졌어요 → ${URL_BASE}`);
  console.log('이 창을 닫으면 서버가 꺼져요. 끄려면 Ctrl+C');
  if (!process.argv.includes('--no-open')) openBrowser(URL_BASE);
  if (!process.argv.includes('--no-auto')) {
    setTimeout(autoSnapshotTick, 15000);           // 켜고 15초 뒤 한 번
    setInterval(autoSnapshotTick, 60 * 60 * 1000); // 그 뒤 1시간마다 확인
  }
});
