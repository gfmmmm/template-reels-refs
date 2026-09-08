// Vercel Edge Middleware — 클라우드 화면 비밀번호 잠금 (무료 플랜에서도 됨)
// 비밀번호는 Vercel 환경변수 SITE_PASSWORD 에만 있다. 로컬(server.js)에서는 이 파일이 쓰이지 않는다.
export const config = { matcher: '/(.*)' };

export default function middleware(request) {
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return; // 비밀번호를 안 정했으면 그냥 통과 (설정 전 상태)
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    let pass = '';
    try { pass = atob(auth.slice(6)).split(':').slice(1).join(':'); } catch {}
    if (pass === expected) return; // 통과 → 정적 파일 그대로 서빙
  }
  return new Response('비밀번호가 필요해요', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="reels-refs", charset="UTF-8"', 'Cache-Control': 'no-store' },
  });
}
