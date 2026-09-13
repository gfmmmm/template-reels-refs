// 클라우드(Vercel) 화면에서 설정을 바꾸는 서버리스 함수.
// 화면은 정적(보기 전용)이지만, 이 함수가 GitHub 저장소의 data/ 파일을 한 커밋으로 고치고(→ Vercel 자동 재배포)
// 원하면 daily.yml 을 바로 실행(→ 수집·분석 → 봇 커밋 → 재배포)한다. 로컬 server.js 에서는 쓰이지 않는다.
//
// Vercel 환경변수 2개: GITHUB_TOKEN(저장소 쓰기 권한) · GH_REPO("owner/reels-refs")
// 요청: POST /api/settings  본문 { accounts:[], competitors:[], minViews, myHandle, channel:{brief,pillars}, collectNow }
// 응답: { ok, commit, dispatched }   GET 은 { editable: true } 만 (화면이 수정 UI 를 켤지 판단)

const GH = 'https://api.github.com';
const HANDLE = /^[a-z0-9._]{1,30}$/i;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // 수정 비밀번호 없음 (2026-09-13 회장님 결정: 유료 결제 미연동, 주소 아는 사람만 씀). EDIT_KEY 환경변수가 있어도 무시한다.
  const token = process.env.GITHUB_TOKEN, repo = process.env.GH_REPO;
  if (req.method === 'GET') return res.status(200).json({ editable: Boolean(token && repo) });
  if (req.method !== 'POST') return res.status(405).json({ error: '허용되지 않는 요청' });
  if (!token || !repo) return res.status(503).json({ error: '수정 기능이 아직 설정되지 않았어요 (환경변수)' });

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const norm = (arr) => [...new Set((Array.isArray(arr) ? arr : String(arr || '').split(/[,\n]/)).map((h) => String(h || '').trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  const accounts = norm(body.accounts), competitors = norm(body.competitors);
  const bad = [...accounts, ...competitors].filter((h) => !HANDLE.test(h));
  if (bad.length) return res.status(400).json({ error: '아이디 형식이 이상해요: ' + bad.join(', ') });
  if (accounts.length > 15 || competitors.length > 15) return res.status(400).json({ error: '계정은 각각 15개까지만' });
  const myHandle = body.myHandle != null ? norm([body.myHandle])[0] || '' : undefined;
  if (myHandle && !HANDLE.test(myHandle)) return res.status(400).json({ error: '내 계정 아이디 형식이 이상해요' });
  const minViews = body.minViews != null ? Math.max(1000, Math.round(Number(body.minViews) || 0)) : undefined;
  const brief = body.channel && body.channel.brief != null ? String(body.channel.brief).slice(0, 4000) : undefined;
  const pillars = body.channel && body.channel.pillars != null ? norm(body.channel.pillars).slice(0, 8) : undefined;

  const gh = async (path, init = {}) => {
    const r = await fetch(GH + path, { ...init, headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'reels-refs', ...(init.headers || {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${path} ${r.status}: ${(j.message || '').slice(0, 120)}`);
    return j;
  };
  const readFile = async (p) => { const j = await gh(`/repos/${repo}/contents/${p}?ref=main`); return JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); };

  try {
    // 1) 현재 파일 읽어서 고칠 부분만 바꾼다 (스냅샷·수집 결과는 건드리지 않음)
    const [config, comp] = await Promise.all([readFile('data/config.json'), readFile('data/competitors.json')]);
    const nextAccounts = accounts;
    comp.handles = competitors;
    if (myHandle !== undefined) config.myHandle = myHandle;
    if (minViews !== undefined) config.minViews = minViews;
    config.channel = Object.assign({ brief: '', pillars: [] }, config.channel || {});
    if (brief !== undefined) config.channel.brief = brief;
    if (pillars !== undefined) config.channel.pillars = pillars;
    config.analyzeFails = {}; // 설정을 바꿨으니 실패 기록도 새로

    // 2) 세 파일을 한 커밋으로 (Git Data API)
    const ref = await gh(`/repos/${repo}/git/ref/heads/main`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh(`/repos/${repo}/git/commits/${baseSha}`);
    const files = { 'data/accounts.json': nextAccounts, 'data/competitors.json': comp, 'data/config.json': config };
    const tree = [];
    for (const [path, data] of Object.entries(files)) {
      const blob = await gh(`/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: JSON.stringify(data, null, 2) + '\n', encoding: 'utf-8' }) });
      tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) });
    const [owner] = repo.split('/');
    const ownerInfo = await gh(`/users/${owner}`);
    const author = { name: owner, email: `${ownerInfo.id}+${owner}@users.noreply.github.com` }; // Vercel 이 배포를 막지 않는 작성자
    const commit = await gh(`/repos/${repo}/git/commits`, { method: 'POST', body: JSON.stringify({ message: `화면에서 설정 변경: 레퍼런스 ${nextAccounts.length}·경쟁사 ${competitors.length}`, tree: newTree.sha, parents: [baseSha], author, committer: author }) });
    await gh(`/repos/${repo}/git/refs/heads/main`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });

    // 3) 원하면 지금 수집
    let dispatched = false;
    if (body.collectNow) {
      const r = await fetch(`${GH}/repos/${repo}/actions/workflows/daily.yml/dispatches`, { method: 'POST', headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'reels-refs' }, body: JSON.stringify({ ref: 'main' }) });
      dispatched = r.status === 204;
    }
    return res.status(200).json({ ok: true, commit: commit.sha.slice(0, 7), dispatched, accounts: nextAccounts, competitors });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
