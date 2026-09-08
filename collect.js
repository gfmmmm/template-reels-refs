// collect.js — ScrapeCreators API로
//   1) 레퍼런스 계정(accounts.json)의 릴스를 훑어 기준 조회수(config.minViews) 이상만 data/refs.json 에 모은다 (캡션·대본·썸네일)
//   2) 경쟁사 계정(competitors.json) + 내 계정(config.myHandle)의 팔로워 스냅샷과 릴스 통계를 data/competitors.json 에 쌓는다
// 영상은 화면에서 인스타 임베드로 본다. 외부 패키지 없음. Node.js 18 이상.
// 실행: node collect.js            → 전체 수집
//       node collect.js --snapshot-only → 팔로워 스냅샷만 (하루 한 번 자동용, 계정당 1크레딧)
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const THUMBS = path.join(DATA, 'thumbs');
const FILES = {
  config: path.join(DATA, 'config.json'),
  accounts: path.join(DATA, 'accounts.json'),
  refs: path.join(DATA, 'refs.json'),
  seen: path.join(DATA, 'seen.json'),
  competitors: path.join(DATA, 'competitors.json'),
};
const API = 'https://api.scrapecreators.com';
const CALL_GAP_MS = 300;
const SNAPSHOT_ONLY = process.argv.includes('--snapshot-only');

// ───────────────────────── 유틸 ─────────────────────────
function log(msg) {
  process.stdout.write(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}\n`);
}
function loadEnv() {
  // .env 파일 + 환경변수(클라우드에서는 GitHub Actions 시크릿이 환경변수로 들어온다). 환경변수가 우선
  const out = {};
  const p = path.join(ROOT, '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  for (const k of ['SCRAPECREATORS_API_KEY', 'GEMINI_API_KEY', 'GEMINI_MODEL']) if (process.env[k]) out[k] = process.env[k];
  return out;
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR'));
const nowIso = () => new Date().toISOString();
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const refLabel = (n) => 'R-' + String(n).padStart(3, '0');
const normHandle = (h) => String(h || '').trim().replace(/^@+/, '').toLowerCase();

class FatalError extends Error {}

// API가 주는 영어 오류를 한국어로
function friendlyApiError(raw) {
  const s = String(raw);
  if (/no profile id|doesn't exist|does not exist|not found|user not found/i.test(s)) return '계정을 찾을 수 없어요. 아이디 철자를 확인해 주세요';
  if (/private/i.test(s)) return '비공개 계정이라 릴스를 볼 수 없어요';
  if (/rate limit|too many/i.test(s)) return '요청이 너무 잦아 잠시 막혔어요. 몇 분 뒤 다시 실행해 주세요';
  if (/timeout|timed out/i.test(s)) return '인스타그램 응답이 늦어 시간이 초과됐어요';
  if (/invalid url|malformed/i.test(s)) return '요청 주소 형식이 잘못됐어요';
  return '알 수 없는 오류: ' + s;
}
const isAccountProblem = (raw) => /no profile id|doesn't exist|does not exist|not found|private/i.test(String(raw));

// ───────────────────────── API 호출 ─────────────────────────
let creditsUsed = 0;
let creditsRemaining = null;

async function apiGet(pathname, params, apiKey) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
      if (res.status === 401 || res.status === 403) {
        throw new FatalError('API 키가 잘못됐거나 권한이 없어요. .env 파일의 키를 확인해 주세요 (HTTP ' + res.status + ')');
      }
      if (res.status === 402) {
        throw new FatalError('크레딧이 모두 소진됐어요. scrapecreators.com 에서 충전해 주세요');
      }
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { throw new Error('서버 응답을 읽을 수 없어요 (HTTP ' + res.status + ')'); }
      if (typeof json.credits_charged === 'number') creditsUsed += json.credits_charged;
      if (typeof json.credits_remaining === 'number') creditsRemaining = json.credits_remaining;
      if (!res.ok || json.success === false) {
        const raw = json.message || json.error || ('HTTP ' + res.status);
        const err = new Error(friendlyApiError(raw));
        err.raw = raw;
        if (isAccountProblem(raw)) err.noRetry = true; // 계정 문제는 재시도해도 소용없다
        throw err;
      }
      return json;
    } catch (e) {
      if (e instanceof FatalError || e.noRetry) throw e;
      lastErr = e;
      if (attempt < 3) { log(`  ↻ 재시도 ${attempt}/2 (${e.message})`); await sleep(1500 * attempt); }
    }
  }
  throw lastErr;
}

async function fetchReelsPage(handle, maxId, apiKey) {
  const j = await apiGet('/v1/instagram/user/reels', { handle, max_id: maxId }, apiKey);
  await sleep(CALL_GAP_MS);
  return j;
}
async function fetchPostDetail(url, apiKey) {
  const j = await apiGet('/v1/instagram/post', { url, cache_max_age: '7d' }, apiKey);
  await sleep(CALL_GAP_MS);
  const m = j?.data?.xdt_shortcode_media || {};
  return {
    caption: m?.edge_media_to_caption?.edges?.[0]?.node?.text ?? '',
    thumb: m?.thumbnail_src ?? null,
  };
}
async function fetchTranscript(url, apiKey) {
  const j = await apiGet('/v2/instagram/media/transcript', { url, cache_max_age: '30d' }, apiKey);
  await sleep(CALL_GAP_MS);
  const t = Array.isArray(j?.transcripts) ? j.transcripts[0]?.text : null;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}
// 프로필 — 팔로워 수 (실제 응답 2026-09-06 확인: data.user.edge_followed_by.count)
async function fetchProfile(handle, apiKey) {
  const j = await apiGet('/v1/instagram/profile', { handle }, apiKey);
  await sleep(CALL_GAP_MS);
  const u = j?.data?.user || {};
  const cnt = (x) => (x && typeof x === 'object' ? x.count : x);
  return {
    followers: typeof cnt(u.edge_followed_by) === 'number' ? cnt(u.edge_followed_by) : null,
    following: typeof cnt(u.edge_follow) === 'number' ? cnt(u.edge_follow) : null,
    posts: typeof cnt(u.edge_owner_to_timeline_media) === 'number' ? cnt(u.edge_owner_to_timeline_media) : null,
    fullName: u.full_name || null,
    bio: typeof u.biography === 'string' ? u.biography : '',
    externalUrl: u.external_url || (Array.isArray(u.bio_links) && u.bio_links[0] && u.bio_links[0].url) || null,
    avatarUrl: u.profile_pic_url_hd || u.profile_pic_url || null,
    verified: u.is_verified === true,
  };
}
// 프로필 사진도 로컬에 저장 (CDN 주소 만료 대비). 7일 지나면 다시 받는다. 파일명의 '.'은 '-'로 (인스타 아이디엔 '-'가 없어 충돌 없음)
async function downloadAvatar(url, handle) {
  if (!url) return null;
  const name = 'avatar_' + handle.replace(/\./g, '-') + '.jpg';
  const file = path.join(THUMBS, name);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 7 * 86400000 && fs.statSync(file).size > 100) return 'data/thumbs/' + name;
  try { fs.unlinkSync(file); } catch {}
  return downloadFile(url, file, 'data/thumbs/' + name, '프로필 사진', 100);
}
// 썸네일을 로컬에 저장. 인스타 CDN 주소는 며칠 뒤 만료되므로 받아 둔다.
async function downloadFile(url, file, rel, label, minBytes) {
  if (!url) return null;
  if (fs.existsSync(file) && fs.statSync(file).size > minBytes) return rel;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length <= minBytes) throw new Error('파일이 비어 있음');
      const tmp = file + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return rel;
    } catch (e) {
      if (attempt === 3) { log(`    ⚠ ${label} 저장 실패 (${e.message})`); return null; }
      await sleep(800);
    }
  }
  return null;
}
const downloadThumb = (url, code) => downloadFile(url, path.join(THUMBS, code + '.jpg'), 'data/thumbs/' + code + '.jpg', '썸네일', 100);

// ───────────────────────── 릴스 파싱 (실제 응답 구조, 2026-09-05 확인) ─────────────────────────
function parseMedia(item, handle) {
  const m = item?.media || item || {};
  const code = m.code;
  if (!code) return null;
  const views = m.play_count ?? m.ig_play_count ?? null;
  return {
    code,
    url: m.url || `https://www.instagram.com/reel/${code}/`,
    account: (m.user && m.user.username) || handle,
    fullName: m.user?.full_name || null,
    verified: m.user?.is_verified === true,
    views: typeof views === 'number' ? views : null,
    likes: typeof m.like_count === 'number' ? m.like_count : null,
    comments: typeof m.comment_count === 'number' ? m.comment_count : null,
    caption: (m.caption && typeof m.caption.text === 'string') ? m.caption.text : '',
    thumbUrl: m.image_versions2?.candidates?.[0]?.url || m.display_uri || null,
    videoUrl: Array.isArray(m.video_versions) && m.video_versions.length ? m.video_versions[m.video_versions.length - 1].url : null, // 분석용. 며칠 뒤 만료되면 analyze.js 가 다시 받는다
    duration: typeof m.video_duration === 'number' ? m.video_duration : null,
    hasAudio: m.has_audio !== false,
    postedAt: m.taken_at ? new Date(m.taken_at * 1000).toISOString() : (m.created_at ? new Date(m.created_at * 1000).toISOString() : null),
  };
}

async function refreshExisting(ex, r, now) {
  if (r.views != null) ex.views = r.views;
  if (r.likes != null) ex.likes = r.likes;
  if (r.comments != null) ex.comments = r.comments;
  if (ex.fullName == null && r.fullName) ex.fullName = r.fullName;
  if (ex.verified == null) ex.verified = r.verified;
  if (!ex.thumb && r.thumbUrl) ex.thumb = await downloadThumb(r.thumbUrl, r.code);
  if (r.videoUrl) ex.videoUrl = r.videoUrl; // 새 주소로 갱신 (만료 대비)
  if (ex.status === undefined) ex.status = 'collected';
  if (ex.commerce === undefined) ex.commerce = commerceHintOf(ex.caption);
  ex.updatedAt = now;
}

function makeRecord(id, r, extra, now) {
  return {
    id,
    code: r.code,
    url: r.url,
    account: r.account,
    fullName: r.fullName,
    verified: r.verified,
    views: r.views,
    likes: r.likes,
    comments: r.comments,
    caption: extra.caption ?? r.caption ?? '',
    transcript: extra.transcript ?? null,
    transcriptNote: extra.transcriptNote ?? null,
    thumb: extra.thumb ?? null,
    videoUrl: r.videoUrl || null,
    duration: r.duration != null ? Math.round(r.duration) : null,
    postedAt: r.postedAt,
    commerce: commerceHintOf(extra.caption ?? r.caption ?? ''), // 캡션 규칙 판정: '광고' | '공구' | null(일반)
    status: 'collected', // AI 분석 전. analyze.js 가 'analyzed' 로 바꾼다
    collectedAt: now,
    updatedAt: now,
  };
}
// 상업성 판정 (캡션 규칙) — analyze.js·화면과 같은 규칙
const COMMERCE_AD_RE = /#\s?(광고|협찬)|#AD\b|유료\s*광고|제작\s*지원|협찬\s*받|제공\s*받|paid\s*partnership/i;
const COMMERCE_SELL_RE = /공구|공동\s*구매|스마트\s*스토어|구매\s*링크|판매\s*링크|와디즈|펀딩|마감\s*임박/;
const commerceHintOf = (cap) => (COMMERCE_AD_RE.test(cap || '') ? '광고' : COMMERCE_SELL_RE.test(cap || '') ? '공구' : null);

// 한 번 실행 안에서 같은 계정의 릴스 목록을 두 번 부르지 않도록 캐시 (레퍼런스와 경쟁사에 같은 계정이 있을 때)
const pageCache = new Map(); // handle → 파싱된 릴스 배열

// 페이지를 돌며 릴스를 하나씩 콜백에 넘긴다. 콜백이 true 를 돌려주면 "새 릴스"로 센다.
async function walkAccount(handle, { firstRun, pageLimit, apiKey, stat, onReel }) {
  let maxId = null;
  const seenReels = [];
  for (let page = 1; page <= pageLimit; page++) {
    const res = await fetchReelsPage(handle, maxId, apiKey);
    const items = Array.isArray(res.items) ? res.items : [];
    stat.pages++;
    if (!items.length) { log(`  ${page}페이지: 릴스 없음`); break; }
    let newOnPage = 0;
    for (const item of items) {
      const r = parseMedia(item, handle);
      if (!r) continue;
      stat.scanned++;
      seenReels.push(r);
      if (await onReel(r)) newOnPage++;
    }
    log(`  ${page}페이지: ${items.length}개 확인, 새 릴스 ${newOnPage}개`);
    const nextId = res.paging_info?.max_id || res.next_max_id || null;
    const more = res.paging_info?.more_available !== false && nextId;
    if (!more) break;
    if (!firstRun && newOnPage === 0) { log(`  새 릴스 없음 → 이 계정은 여기까지`); break; }
    maxId = nextId;
  }
  pageCache.set(handle, seenReels);
}

// ───────────────────────── 메인 ─────────────────────────
async function main() {
  const env = loadEnv();
  const apiKey = env.SCRAPECREATORS_API_KEY;
  if (!apiKey || /여기에/.test(apiKey)) throw new FatalError('.env 파일에 SCRAPECREATORS_API_KEY 가 없어요. .env.example 을 참고해 키를 넣어 주세요');

  fs.mkdirSync(THUMBS, { recursive: true });
  const config = Object.assign({ minViews: 300000, initialPages: 3, maxPages: 3, nextRefNo: 1, myHandle: '', myTranscripts: true, myTranscriptTop: 10 }, readJson(FILES.config, {}));
  const minViews = Number(config.minViews) || 300000;
  const initialPages = Math.max(1, Number(config.initialPages) || 3);
  const maxPages = Math.max(1, Number(config.maxPages) || 3);
  const myHandle = normHandle(config.myHandle);
  const accounts = readJson(FILES.accounts, [])
    .map((a) => (typeof a === 'string' ? a : a && a.handle)).map(normHandle).filter(Boolean);

  const refs = readJson(FILES.refs, []);
  const seen = Object.assign({ accounts: {}, reels: {} }, readJson(FILES.seen, {}));
  if (!seen.accounts || typeof seen.accounts !== 'object') seen.accounts = {};
  if (!seen.reels || typeof seen.reels !== 'object') seen.reels = {};
  const comp = Object.assign({ handles: [], snapshots: {}, reels: {}, profiles: {} }, readJson(FILES.competitors, {}));
  comp.handles = (comp.handles || []).map(normHandle).filter(Boolean);

  // 고유 라벨(R-001 …) 부여. 이미 있는 것은 유지, 없는 것은 수집 순서대로 채운다
  let nextNo = Math.max(Number(config.nextRefNo) || 1, ...refs.map((r) => (r.id && /^R-(\d+)$/.test(r.id) ? Number(r.id.slice(2)) + 1 : 1)));
  const noId = refs.filter((r) => !r.id).sort((a, b) => String(a.collectedAt || '').localeCompare(String(b.collectedAt || '')) || (b.views || 0) - (a.views || 0));
  for (const r of noId) r.id = refLabel(nextNo++);
  if (noId.length) log(`라벨 없는 릴스 ${noId.length}개에 번호를 붙였어요 (${noId[0].id} ~ ${noId[noId.length - 1].id})`);
  const takeId = () => { const id = refLabel(nextNo++); config.nextRefNo = nextNo; return id; };

  const refsByCode = new Map(refs.map((r) => [r.code, r]));
  const now = nowIso();
  const perAccount = [];
  const perCompetitor = [];
  const saveRefs = () => writeJsonAtomic(FILES.refs, refs);
  const saveComp = () => writeJsonAtomic(FILES.competitors, comp);

  // 경쟁사 대상 = 내 계정 + 경쟁사 목록 (중복 제거)
  const compTargets = [...new Set([myHandle, ...comp.handles].filter(Boolean))];

  if (SNAPSHOT_ONLY) {
    log(`팔로워 스냅샷만 · ${compTargets.length}개 계정`);
  } else {
    if (!accounts.length && !compTargets.length) {
      log('레퍼런스 계정도 경쟁사 계정도 없어요. 설정에서 먼저 추가해 주세요.');
      return finish(perAccount, perCompetitor, refs, seen, comp, config);
    }
    log(`수집 시작 · 레퍼런스 ${accounts.length}개 · 기준 ${fmt(minViews)}회 이상 · 경쟁사 ${compTargets.length}개${myHandle ? ' (내 계정 @' + myHandle + ' 포함)' : ''}`);
  }

  // ── 1) 레퍼런스 계정 ──
  if (!SNAPSHOT_ONLY) for (const handle of accounts) {
    const firstRun = !seen.accounts[handle];
    const pageLimit = firstRun ? initialPages : maxPages;
    const stat = { handle, scanned: 0, added: 0, updated: 0, skippedNull: 0, belowMin: 0, pages: 0, error: null, notFound: false };
    perAccount.push(stat);
    log(`\n▶ @${handle} ${firstRun ? '(처음 수집, 최대 ' + pageLimit + '페이지)' : '(새 릴스 확인, 최대 ' + pageLimit + '페이지)'}`);
    try {
      await walkAccount(handle, {
        firstRun, pageLimit, apiKey, stat,
        onReel: async (r) => {
          if (refsByCode.has(r.code)) { await refreshExisting(refsByCode.get(r.code), r, now); stat.updated++; saveRefs(); return false; }
          const isNew = !seen.reels[r.code];
          if (r.views == null) {
            stat.skippedNull++;
            log(`  · ${r.code} 조회수 비공개 → 건너뜀`);
            seen.reels[r.code] = { account: handle, views: null, postedAt: r.postedAt, at: now };
            return isNew;
          }
          if (r.views < minViews) {
            stat.belowMin++;
            seen.reels[r.code] = { account: handle, views: r.views, postedAt: r.postedAt, at: now }; // 다음 실행 때 다시 판단
            return isNew;
          }

          // ── 채택 ──
          const id = takeId();
          log(`  ★ ${id} ${r.code} ${fmt(r.views)}회 → 채택${seen.reels[r.code] ? ' (지난번 ' + fmt(seen.reels[r.code].views) + '회에서 올라옴)' : ''}`);
          let caption = r.caption;
          let thumbUrl = r.thumbUrl;
          if (!caption) {
            try {
              const d = await fetchPostDetail(r.url, apiKey);
              caption = d.caption || '';
              if (!thumbUrl) thumbUrl = d.thumb;
              log(`    캡션 상세 조회 ${caption ? '완료' : '(캡션 없음)'}`);
            } catch (e) { log(`    ⚠ 캡션 상세 조회 실패 (${e.message})`); }
          }
          let transcript = null;
          let transcriptNote = null;
          if (r.duration != null && r.duration > 120) {
            transcriptNote = '2분 초과';
            log(`    대본: 2분 초과라 건너뜀`);
          } else if (!r.hasAudio) {
            transcriptNote = '음성 없음';
            log(`    대본: 음성 없는 영상이라 건너뜀`);
          } else {
            try {
              transcript = await fetchTranscript(r.url, apiKey);
              if (!transcript) transcriptNote = '음성 없음';
              log(`    대본 ${transcript ? transcript.length + '자' : '없음 (음성 없음)'}`);
            } catch (e) { transcriptNote = '추출 실패'; log(`    ⚠ 대본 추출 실패 (${e.message})`); }
          }
          const thumb = await downloadThumb(thumbUrl, r.code);
          const rec = makeRecord(id, r, { caption, transcript, transcriptNote, thumb }, now);
          refs.push(rec); refsByCode.set(r.code, rec);
          delete seen.reels[r.code];
          stat.added++;
          saveRefs(); // 중간에 끊겨도 지금까지 채택분은 남긴다
          return isNew;
        },
      });
      seen.accounts[handle] = { lastRun: now };
    } catch (e) {
      if (e instanceof FatalError) throw e;
      stat.error = e.message;
      if (isAccountProblem(e.raw)) stat.notFound = true;
      log(`  ⚠ @${handle}: ${e.message} (다음 계정으로 넘어감)`);
    }
    log(`  ↳ 새로 채택 ${stat.added} · 갱신 ${stat.updated} · 기준 미달 ${stat.belowMin} · 훑은 릴스 ${stat.scanned}`);
  }

  // ── 2) 경쟁사 + 내 계정: 팔로워 스냅샷 (+ 릴스 통계) ──
  const today = todayKey();
  for (const handle of compTargets) {
    const isMe = handle === myHandle;
    const stat = { handle, isMe, followers: null, delta: null, reelsSeen: 0, snapshot: false, error: null, notFound: false };
    perCompetitor.push(stat);
    log(`\n▶ ${isMe ? '내 계정 ' : '경쟁사 '}@${handle}`);
    try {
      // 프로필 스냅샷: 하루 한 장 (같은 날이면 덮어씀)
      const p = await fetchProfile(handle, apiKey);
      if (p.followers == null) throw Object.assign(new Error('팔로워 수를 읽지 못했어요'), { raw: 'no followers' });
      const list = comp.snapshots[handle] || (comp.snapshots[handle] = []);
      const prev = list.length ? list[list.length - 1] : null;
      const snap = { date: today, at: now, followers: p.followers, following: p.following, posts: p.posts };
      if (prev && prev.date === today) list[list.length - 1] = snap; else list.push(snap);
      const avatar = await downloadAvatar(p.avatarUrl, handle);
      comp.profiles[handle] = { fullName: p.fullName, bio: p.bio, externalUrl: p.externalUrl, avatar, verified: p.verified, followers: p.followers, following: p.following, posts: p.posts, isMe, updatedAt: now };
      stat.followers = p.followers; stat.snapshot = true;
      const base = list.length >= 2 ? list[list.length - 2] : null;
      stat.delta = base ? p.followers - base.followers : null;
      log(`  팔로워 ${fmt(p.followers)}명${stat.delta != null ? ' (' + (stat.delta >= 0 ? '+' : '') + fmt(stat.delta) + ' · ' + base.date + ' 대비)' : ' (첫 스냅샷)'}`);
      saveComp();

      // 릴스 통계 (업로드 수·평균 조회수용). 스냅샷 전용 실행에서는 건너뜀
      if (!SNAPSHOT_ONLY) {
        const store = comp.reels[handle] || (comp.reels[handle] = {});
        let reels = pageCache.get(handle);
        const needThumbs = isMe && Object.values(store).some((v) => !v.thumb);
        if (reels && !needThumbs) log(`  릴스 목록은 레퍼런스 수집 때 받은 것을 재사용 (크레딧 0)`);
        else {
          const firstRun = Object.keys(store).length === 0 || needThumbs; // 내 릴스 썸네일이 비어 있으면 한 번 전체를 다시 훑는다
          if (needThumbs && Object.keys(store).length) log(`  내 릴스 썸네일이 없어 이번 한 번 ${initialPages}페이지를 다시 훑어요`);
          const s2 = { pages: 0, scanned: 0 };
          await walkAccount(handle, { firstRun, pageLimit: firstRun ? initialPages : maxPages, apiKey, stat: s2, onReel: async (r) => !store[r.code] });
          reels = pageCache.get(handle) || [];
        }
        for (const r of reels) {
          // 캡션 앞부분도 저장 — 내 채널 정체성 자동 분석의 재료 (크레딧 0). 내 릴스는 썸네일도 받는다 (내 계정 카드용)
          const prev = store[r.code] || {};
          const thumb = isMe ? (prev.thumb || await downloadThumb(r.thumbUrl, r.code)) : prev.thumb;
          store[r.code] = { ...prev, views: r.views, likes: r.likes, comments: r.comments, postedAt: r.postedAt, duration: r.duration != null ? Math.round(r.duration) : null, caption: String(r.caption || '').replace(/\s+/g, ' ').slice(0, isMe ? 1000 : 200), thumb: thumb || null, at: now };
        }
        stat.reelsSeen = reels.length;
        log(`  릴스 통계 ${reels.length}개 갱신 (누적 ${Object.keys(store).length}개)`);
        saveComp();
        // 내 상위 릴스 대본 — 기획 스킬(DNA·대표대본) 재료. 설정에서 켰을 때만, 상위 N개 중 아직 없는 것만 (1크레딧/건, 한 번만)
        if (isMe && config.myTranscripts) {
          const topN = Math.max(1, Number(config.myTranscriptTop) || 10);
          const audioOf = new Map(reels.map((r) => [r.code, { hasAudio: r.hasAudio, duration: r.duration }]));
          const targets = Object.entries(store).filter(([, v]) => typeof v.views === 'number').sort((a, b) => b[1].views - a[1].views).slice(0, topN).filter(([, v]) => v.transcript === undefined);
          if (targets.length) log(`  내 대본 수집: 상위 ${topN}개 중 ${targets.length}개 (건당 1크레딧)`);
          for (const [code, v] of targets) {
            const meta = audioOf.get(code) || {};
            if (meta.duration != null && meta.duration > 120) { v.transcript = null; v.transcriptNote = '2분 초과'; continue; }
            if (meta.hasAudio === false) { v.transcript = null; v.transcriptNote = '음성 없음'; continue; }
            try {
              v.transcript = await fetchTranscript(`https://www.instagram.com/reel/${code}/`, apiKey);
              v.transcriptNote = v.transcript ? null : '음성 없음';
              log(`    ${code} 대본 ${v.transcript ? v.transcript.length + '자' : '없음'}`);
              stat.transcripts = (stat.transcripts || 0) + 1;
            } catch (e) { v.transcript = null; v.transcriptNote = '추출 실패'; log(`    ⚠ ${code} 대본 실패 (${e.message})`); }
            saveComp();
          }
        }
      }
    } catch (e) {
      if (e instanceof FatalError) throw e;
      stat.error = e.message;
      if (isAccountProblem(e.raw)) stat.notFound = true;
      log(`  ⚠ @${handle}: ${e.message} (다음 계정으로 넘어감)`);
    }
  }

  finish(perAccount, perCompetitor, refs, seen, comp, config);
}

function finish(perAccount, perCompetitor, refs, seen, comp, config) {
  refs.sort((a, b) => (b.views || 0) - (a.views || 0));
  writeJsonAtomic(FILES.refs, refs);
  writeJsonAtomic(FILES.seen, seen);
  writeJsonAtomic(FILES.competitors, comp);
  const finishedAt = nowIso();
  const summary = {
    kind: SNAPSHOT_ONLY ? 'snapshot' : 'collect',
    finishedAt,
    totalRefs: refs.length,
    added: perAccount.reduce((s, a) => s + a.added, 0),
    updated: perAccount.reduce((s, a) => s + a.updated, 0),
    snapshots: perCompetitor.filter((c) => c.snapshot).length,
    creditsUsed,
    creditsRemaining,
    accounts: perAccount,
    competitors: perCompetitor,
    notFound: [...perAccount, ...perCompetitor].filter((a) => a.notFound).map((a) => a.handle),
  };
  if (perCompetitor.some((c) => c.snapshot)) config.lastSnapshotDate = todayKey();
  if (SNAPSHOT_ONLY) {
    config.lastSnapshotSummary = summary;
  } else {
    config.lastRunAt = finishedAt;
    config.lastSummary = summary;
  }
  writeJsonAtomic(FILES.config, config);
  if (SNAPSHOT_ONLY) log(`\n스냅샷 완료 · ${summary.snapshots}개 계정 · 사용 크레딧 ${creditsUsed} · 남은 크레딧 ${creditsRemaining ?? '?'}`);
  else log(`\n완료 · 새로 ${summary.added}개 · 갱신 ${summary.updated}개 (전체 ${summary.totalRefs}개) · 경쟁사 스냅샷 ${summary.snapshots}개 · 사용 크레딧 ${creditsUsed} · 남은 크레딧 ${creditsRemaining ?? '?'}`);
  if (summary.notFound.length) log(`찾을 수 없었던 계정: ${[...new Set(summary.notFound)].map((h) => '@' + h).join(', ')}`);
  process.stdout.write('SUMMARY ' + JSON.stringify(summary) + '\n');
}

main().catch((e) => {
  log('✖ ' + (e instanceof FatalError ? e.message : '예상치 못한 오류: ' + (e.stack || e.message)));
  process.stdout.write('SUMMARY ' + JSON.stringify({ kind: SNAPSHOT_ONLY ? 'snapshot' : 'collect', error: e.message, finishedAt: nowIso(), creditsUsed, creditsRemaining }) + '\n');
  process.exit(1);
});
