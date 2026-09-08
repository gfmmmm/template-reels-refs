// analyze.js — 2단계: 레퍼런스 릴스 AI 분석 (content-agent 의 analyze-discoveries 로직을 그대로 이식)
//   ① 영상 임시 다운로드 (수집 때 저장한 videoUrl → 만료됐으면 ScrapeCreators 상세 호출로 재획득, 1크레딧)
//   ② Gemini 가 영상을 보고 시각 분석 (초반3초훅·컷편집·자막·연출·인물)
//   ③ Gemini 가 대본+캡션+시각분석을 종합 → "왜 터졌나 + 차용 포인트" (내 채널 정체성 기준)
//   ④ refs.json 에 저장 → status='analyzed'. 관련성 '낮음'이면 hidden=true (삭제 아님)
//   ⑤ 영상 파일 즉시 삭제
// 실행: node analyze.js            → 미분석 릴스를 조회수 높은 순으로 최대 config.analyzeMax 개
//       node analyze.js --code XXX → 그 릴스 하나만 (이미 분석됐어도 다시)
// 외부 패키지 없음. Node.js 18 이상. 모델 gemini-3.6-flash (GEMINI_MODEL 환경변수로 교체 가능)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const FILES = { config: path.join(DATA, 'config.json'), refs: path.join(DATA, 'refs.json') };
const G = 'https://generativelanguage.googleapis.com';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const TMP = path.join(os.tmpdir(), 'reels-refs-analyze');
const ONLY_CODE = (() => { const i = process.argv.indexOf('--code'); return i >= 0 ? process.argv[i + 1] : null; })();

// ───────────────────────── 유틸 ─────────────────────────
function log(msg) { process.stdout.write(`[${new Date().toLocaleTimeString('ko-KR', { hour12: false })}] ${msg}\n`); }
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
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(file, obj) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, file); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const extractJson = (text) => {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return { raw: String(text || '').slice(0, 500) }; }
};

// 상업성 판정 (캡션 규칙) — 화면의 규칙과 같아야 한다
const COMMERCE_AD_RE = /#\s?(광고|협찬)|#AD\b|유료\s*광고|제작\s*지원|협찬\s*받|제공\s*받|paid\s*partnership/i;
const COMMERCE_SELL_RE = /공구|공동\s*구매|스마트\s*스토어|구매\s*링크|판매\s*링크|와디즈|펀딩|마감\s*임박/;
const commerceHintOf = (cap) => (COMMERCE_AD_RE.test(cap || '') ? '광고' : COMMERCE_SELL_RE.test(cap || '') ? '공구' : null);

// ───────────────────────── 프롬프트 (원본 그대로) ─────────────────────────
// 영상의 시각 요소 분석 — 객관적 시각 관찰
const VISUAL_PROMPT = `이 릴스 영상의 시각적 요소를 구체적으로 분석해줘. 반드시 아래 JSON만 출력(코드블록·설명 금지):
{
 "초반3초훅": "첫 3초에 시선을 잡는 시각 장치(장면·자막·움직임)를 구체적으로",
 "컷편집": "컷 전환 빈도·속도감·리듬",
 "자막스타일": "색상·크기·위치·폰트·강조효과",
 "영상연출": "클로즈업·B롤·화면구성·비포애프터 등 눈에 띄는 연출",
 "인물": "표정·제스처·에너지 (있으면, 없으면 해당없음)"
}`;

// 종합 — 왜 터졌고 뭘 차용할지. 공구/광고 릴스면 소구점 분석 추가. 4레이어 메커니즘·인용 강제·내 계정 맞춤
function buildSynthPrompt(r, videoAnalysis, ctx) {
  const commerce = r.commerceOverride && r.commerceOverride !== '일반' ? r.commerceOverride : (r.commerceOverride === '일반' ? null : commerceHintOf(r.caption));
  const saleField = commerce
    ? `, "소구점": { "무엇을_팔며":"제품·서비스가 무엇인지", "찌르는_욕구":"어떤 욕구·불안·귀찮음을 찌르나", "판매장치":"실제 쓰인 장치만(전후비교·사회적증거·한정성·가격앵커·권위 등)", "우리가_배울_것":"우리 판매 콘텐츠에 옮길 구체 팁 1~2개" }`
    : '';
  const saleNote = commerce ? `\n이 릴스는 ${commerce} 콘텐츠다 — 어떻게 제품을 사고 싶게 만드는지(소구점)도 분석하라. 영상·대본에 실제로 있는 장치만 적고 지어내지 마라.` : '';
  return `너는 릴스 기획 관점의 숏폼 레퍼런스 분석가다. 남의 계정에서 터진 릴스를 해부해 "왜 터졌고, 내 계정이 뭘 훔쳐올지"를 정리한다.${saleNote}

## 내 계정 (차용포인트는 반드시 이 계정 기준으로 맞춤하라)
- 채널 정체성: ${ctx.brief || '(미설정)'}
- 콘텐츠 기둥: ${ctx.pillars.join(' / ') || '(미설정)'}

## 분석 프레임워크 (터진 이유를 이 4개 축에서 찾아라 — 기획이 90%)
1. 초반 3초 후킹 — 어떤 장치로 스크롤을 멈췄나 (결과 먼저 / 질문 / 상식 깨기 / 권위 / 공감 등)
2. 주제/모수 — 왜 많은 사람이 관심 가질 주제인가, 어떤 이득·문제·흥미를 건드리나
3. 본질/욕망 — 시청자의 어떤 욕망("나도 저렇게 하고 싶다")을 자극했나
4. 대본/구조 — 전개·반전·CTA 에서 뭐가 특별한가

## 내 채널 관련성 판정 (기둥 기준 — 주제가 내 분야가 아니어도 기둥에 붙으면 관련 있음)
- 높음: 릴스의 주제가 위 콘텐츠 기둥 중 하나와 겹친다
- 중간: 주제는 다르지만 후킹·구조·연출 문법을 우리 기둥에 옮겨 쓸 수 있다
- 낮음: 주제가 어느 기둥에도 안 붙고, 특별히 배울 문법도 없다
애매하면 낮음이 아니라 중간으로 판정하라 — 낮음은 확실할 때만.

## 작성 규칙
- 표면적 이유 금지 ("영상미가 좋다" ✕) — 메커니즘으로 설명하라 ("완성 장면을 1초 먼저 보여줘 결과 궁금증을 만든 뒤...")
- 각 항목은 영상 속 실제 장면·멘트를 「」 안에 인용하며 시작한다. 시각분석·대본·캡션에 실제 있는 것만 — 지어내기 금지
- 차용포인트는 내 계정의 정체성·기둥에 맞게 번역해서, 다음 영상에서 그대로 실행할 수 있는 수준으로 쓴다
  (예: "「반찬통 열어달라는 남편」식 가족 상황극 도입을 우리 계정의 서사로 — 아이가 준 미션으로 시작하는 30초 구조")
- 영어 단어 금지
- 말투는 정중한 존댓말로 통일 — "~했습니다", "~끌어냈습니다". 반말("~했어", "~이야", "~만들었어") 절대 금지
- 분석 용어 대신 쉬운 표현으로 — "터진 문법"(✕)→"○○만 뷰가 나온 방식처럼"(○), "모수"(✕)→"관심 가질 사람이 많은 주제"(○). 같은 문형을 연달아 반복하지 않기

반드시 JSON만 출력(코드블록 금지):
{ "주제":"핵심 주제 한 줄",
  "후킹":"「인용」 — 스크롤을 멈춘 메커니즘 한두 문장",
  "좋은점": ["「인용」으로 시작 — 왜 터졌는지 메커니즘, 최대 3개"],
  "차용포인트": ["내 계정 맞춤 + 그대로 실행 가능한 팁, 최대 3개"],
  "내채널_관련성": { "등급": "높음|중간|낮음", "이유": "판정 근거 한 줄" }${saleField} }

조회수: ${r.views}
캡션: ${(r.caption || '').slice(0, 300)}
대본: ${(r.transcript || '대본 없음').slice(0, 1500)}
영상 시각분석: ${JSON.stringify(videoAnalysis)}`;
}

// 코드 가드 — 개수 절단 + 인용 없는 좋은점 제거 (전부 탈락하면 원본 유지) + 관련성 정규화
function guardRef(an) {
  if (!an || typeof an !== 'object') return an;
  for (const [k, max] of [['좋은점', 3], ['차용포인트', 3]]) {
    if (Array.isArray(an[k])) an[k] = an[k].slice(0, max);
  }
  if (Array.isArray(an.좋은점)) {
    const quoted = an.좋은점.filter((x) => String(x).includes('「'));
    if (quoted.length) an.좋은점 = quoted;
  }
  if (!an.내채널_관련성 || !['높음', '중간', '낮음'].includes(an.내채널_관련성.등급)) {
    an.내채널_관련성 = { 등급: '중간', 이유: an.내채널_관련성?.이유 || '(판정 누락 — 보수적 유지)' };
  }
  return an;
}

// ───────────────────────── 영상·Gemini ─────────────────────────
async function downloadVideo(url, dest) {
  if (!url) return false;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return false;
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    return fs.statSync(dest).size > 1000;
  } catch { return false; } finally { clearTimeout(to); }
}
// 만료된 영상 주소를 ScrapeCreators 상세 호출로 다시 받는다 (1크레딧)
async function scVideoUrl(reelUrl, key) {
  const res = await fetch(`https://api.scrapecreators.com/v1/instagram/post?url=${encodeURIComponent(reelUrl)}&cache_max_age=1d`, { headers: { 'x-api-key': key } });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw new Error('ScrapeCreators 키가 잘못됐어요');
  if (res.status === 402) throw new Error('ScrapeCreators 크레딧이 소진됐어요');
  const m = j.data?.xdt_shortcode_media || {};
  return { url: m.video_url || m.video_versions?.[0]?.url || null, creditsRemaining: j.credits_remaining, charged: j.credits_charged || 0 };
}
function geminiErr(res, j, what) {
  const msg = (j.error?.message || '').slice(0, 120);
  if (res.status === 400 && /API key/i.test(msg)) return new Error('Gemini API 키가 잘못됐어요. .env 의 GEMINI_API_KEY 를 확인해 주세요');
  if (res.status === 429) return new Error('Gemini 무료 한도에 걸렸어요. 1분 뒤 다시 시도하거나 내일 이어서 분석해 주세요');
  return new Error(`Gemini ${what} 실패 (HTTP ${res.status}${msg ? ': ' + msg : ''})`);
}
// 영상 파일 → Gemini 시각분석
async function geminiAnalyze(videoPath, gkey) {
  const bytes = fs.readFileSync(videoPath);
  const up = await fetch(`${G}/upload/v1beta/files?key=${gkey}`, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-Content-Type': 'video/mp4', 'Content-Type': 'video/mp4' },
    body: bytes,
  });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok) throw geminiErr(up, uj, '영상 업로드');
  const file = uj.file;
  if (!file?.uri) throw new Error('Gemini 업로드 실패: ' + JSON.stringify(uj).slice(0, 140));
  try {
    let state = file.state;
    for (let i = 0; i < 30 && state !== 'ACTIVE'; i++) {
      await sleep(2000);
      const s = await (await fetch(`${G}/v1beta/${file.name}?key=${gkey}`)).json();
      state = s.state;
      if (state === 'FAILED') throw new Error('Gemini 영상 처리 실패');
    }
    if (state !== 'ACTIVE') throw new Error(`Gemini 영상 처리 타임아웃 (state=${state}, 60초 초과)`);
    const gen = await fetch(`${G}/v1beta/models/${MODEL}:generateContent?key=${gkey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ fileData: { mimeType: 'video/mp4', fileUri: file.uri } }, { text: VISUAL_PROMPT }] }] }),
    });
    const gj = await gen.json().catch(() => ({}));
    if (!gen.ok) throw geminiErr(gen, gj, '시각분석'); // HTTP 오류를 빈 응답으로 삼키면 쓰레기 분석이 저장된다
    return extractJson(gj.candidates?.[0]?.content?.parts?.[0]?.text || '');
  } finally {
    try { await fetch(`${G}/v1beta/${file.name}?key=${gkey}`, { method: 'DELETE' }); } catch { /* 무시 */ }
  }
}
// 텍스트 프롬프트 → Gemini 종합 (2회 재시도)
async function geminiText(prompt, gkey) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 90000);
    try {
      const r = await fetch(`${G}/v1beta/models/${MODEL}:generateContent?key=${gkey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw geminiErr(r, j, '종합');
      const txt = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!txt.trim()) throw new Error('빈 응답');
      return extractJson(txt);
    } catch (e) { lastErr = e; if (/키가 잘못/.test(e.message)) throw e; await sleep(attempt * 2000); } finally { clearTimeout(to); }
  }
  throw lastErr;
}

// ───────────────────────── 메인 ─────────────────────────
async function main() {
  const env = loadEnv();
  const GKEY = env.GEMINI_API_KEY;
  const SCKEY = env.SCRAPECREATORS_API_KEY;
  if (!GKEY || /여기에/.test(GKEY)) throw new Error('.env 에 GEMINI_API_KEY 가 없어요. aistudio.google.com 에서 무료로 발급해 넣어 주세요');
  fs.mkdirSync(TMP, { recursive: true });

  const config = Object.assign({ analyzeMax: 20, analyzeFails: {}, channel: { brief: '', pillars: [] } }, readJson(FILES.config, {}));
  const ctx = { brief: String(config.channel?.brief || ''), pillars: Array.isArray(config.channel?.pillars) ? config.channel.pillars.filter(Boolean) : [] };
  const fails = config.analyzeFails && typeof config.analyzeFails === 'object' ? config.analyzeFails : {};
  const refs = readJson(FILES.refs, []);
  const MAX = Math.max(1, Number(config.analyzeMax) || 20);

  let work;
  if (ONLY_CODE) {
    work = refs.filter((r) => r.code === ONLY_CODE);
    if (!work.length) throw new Error(`릴스 ${ONLY_CODE} 를 찾을 수 없어요`);
  } else {
    const pending = refs.filter((r) => r.status !== 'analyzed' && !r.hidden).sort((a, b) => (b.views || 0) - (a.views || 0));
    const skipped = pending.filter((r) => (fails[r.code] || 0) >= 3);
    work = pending.filter((r) => (fails[r.code] || 0) < 3).slice(0, MAX);
    if (skipped.length) log(`⏭ 3회 실패로 제외 ${skipped.length}건 (되살리려면 설정의 '실패 기록 초기화')`);
    if (!work.length) { log('분석할 릴스가 없어요 (전부 분석됐거나 실패 3회 초과).'); return finish(refs, config, fails, 0, 0, 0); }
  }
  if (!ctx.brief && !ctx.pillars.length) log('⚠ 설정에 채널 정체성·콘텐츠 기둥이 비어 있어요. 차용포인트가 일반론이 됩니다. 설정 탭에서 채우면 다음 분석부터 반영돼요.');
  log(`🎬 AI 분석 ${work.length}건 (조회수 높은 순 · 분석 후 영상 삭제) · 모델 ${MODEL}`);

  let done = 0, credits = 0, creditsRemaining = null;
  for (const r of work) {
    const vid = path.join(TMP, `${r.code}.mp4`);
    const label = `${r.id || ''} ${r.code} (${Math.round((r.views || 0) / 10000)}만)`;
    try {
      log(`\n▶ ${label}`);
      let ok = await downloadVideo(r.videoUrl, vid);
      if (!ok) {
        if (!SCKEY) throw new Error('영상 주소가 만료됐고 ScrapeCreators 키가 없어 다시 받을 수 없어요');
        const v = await scVideoUrl(r.url, SCKEY);
        credits += v.charged; if (typeof v.creditsRemaining === 'number') creditsRemaining = v.creditsRemaining;
        if (!v.url) throw new Error('영상 주소를 받지 못했어요');
        r.videoUrl = v.url;
        ok = await downloadVideo(v.url, vid);
        log(`  영상 주소 재획득 (1크레딧)`);
      }
      if (!ok) throw new Error('영상 다운로드 실패');
      log(`  영상 ${(fs.statSync(vid).size / 1048576).toFixed(1)}MB → Gemini 시각분석 중…`);
      const va = await geminiAnalyze(vid, GKEY);
      if (va.raw) throw new Error('시각분석 응답이 JSON 이 아니에요');
      log(`  시각분석 완료 → 종합 중…`);
      const an = guardRef(await geminiText(buildSynthPrompt(r, va, ctx), GKEY));
      if (an.raw || !an.주제) throw new Error('종합 응답이 JSON 이 아니에요');
      // 일반 릴스인데 AI 가 소구점을 덧붙였으면 버린다 (요청하지 않은 항목)
      const isCommerce = r.commerceOverride ? r.commerceOverride !== '일반' : !!commerceHintOf(r.caption);
      if (!isCommerce && an.소구점) delete an.소구점;
      const lowRel = an.내채널_관련성?.등급 === '낮음';
      r.videoAnalysis = va;
      r.analysis = an;
      r.status = 'analyzed';
      r.analyzedAt = nowIso();
      if (r.commerce === undefined) r.commerce = commerceHintOf(r.caption);
      if (lowRel && !ONLY_CODE) r.hidden = true; // 관련성 낮음 자동 숨김 (삭제 아님, 화면에서 복구 가능)
      delete fails[r.code];
      writeJsonAtomic(FILES.refs, refs); // 한 건 끝날 때마다 저장
      done++;
      log(`  ${lowRel ? '🙈' : '✅'} ${an.주제}${lowRel ? ' [관련성 낮음 → 숨김]' : ''} · 관련성 ${an.내채널_관련성.등급}`);
    } catch (e) {
      fails[r.code] = (fails[r.code] || 0) + 1;
      log(`  ❌ ${e.message} (누적 ${fails[r.code]}회)`);
      if (/키가 잘못|크레딧이 소진|무료 한도/.test(e.message)) { log('✖ 여기서 멈춥니다: ' + e.message); break; }
    } finally { try { fs.unlinkSync(vid); } catch { /* 없음 */ } }
  }
  finish(refs, config, fails, work.length, done, credits, creditsRemaining);
}

function finish(refs, config, fails, total, done, credits, creditsRemaining) {
  writeJsonAtomic(FILES.refs, refs);
  config.analyzeFails = fails;
  const summary = { kind: 'analyze', finishedAt: nowIso(), total, done, failed: total - done, creditsUsed: credits, creditsRemaining, analyzed: refs.filter((r) => r.status === 'analyzed').length, pending: refs.filter((r) => r.status !== 'analyzed' && !r.hidden).length };
  config.lastAnalyzeAt = summary.finishedAt;
  config.lastAnalyzeSummary = summary;
  writeJsonAtomic(FILES.config, config);
  log(`\n분석 완료 · ${done}/${total}건 성공 · 전체 분석됨 ${summary.analyzed}개 · 남은 미분석 ${summary.pending}개${credits ? ' · ScrapeCreators ' + credits + '크레딧' : ''}`);
  if (total > 0 && done === 0) log('❌ 전량 실패 — Gemini 키·한도·인터넷을 점검해 주세요');
  process.stdout.write('SUMMARY ' + JSON.stringify(summary) + '\n');
  if (total > 0 && done === 0) process.exit(1);
}

main().catch((e) => {
  log('✖ ' + e.message);
  process.stdout.write('SUMMARY ' + JSON.stringify({ kind: 'analyze', error: e.message, finishedAt: nowIso() }) + '\n');
  process.exit(1);
});
