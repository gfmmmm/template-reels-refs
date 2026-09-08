# 이 폴더는 "릴스 레퍼런스 수집기" 다

인스타 릴스 레퍼런스를 모으고(ScrapeCreators), AI 로 "왜 터졌나·차용포인트"를 분석하고(Gemini), 내 말투로 릴스를 기획하는(스킬) 도구. Node.js 만 있으면 돌고 npm 설치가 없다.

## 사용자가 이렇게 말하면

| 말 | 할 일 |
|---|---|
| "세팅 가이드대로 진행해줘", "세팅해줘", "시작하자" | `SETUP.md` 를 열고 0단계부터 그대로 따른다 |
| "서버 켜줘" | 맥 `open 시작.command` / 윈도우 `시작.bat`, 또는 `node server.js` 백그라운드. 주소 http://127.0.0.1:3456 |
| "지금 수집 돌려줘" | 클라우드(5단계)를 켰으면 `gh workflow run daily.yml` → `gh run watch` → `git pull`. 아니면 화면 설정 탭 "수집 시작" 또는 `node collect.js` |
| "분석 돌려줘" | `node analyze.js` (Gemini 키 필요) |
| "레퍼런스 계정에 OO 추가/삭제" | `data/accounts.json` 수정 (클라우드면 커밋·push 까지) |
| "경쟁사에 OO 추가/삭제" | `data/competitors.json` 의 `handles` 수정 (클라우드면 커밋·push) |
| "내 계정 바꿔줘" / "기준 조회수 바꿔줘" / "채널 정체성 고쳐줘" | `data/config.json` 의 `myHandle` / `minViews` / `channel` (클라우드면 커밋·push) |
| "최신 데이터 받아줘" | `git pull --rebase origin main` |
| "R-012로 기획해줘", "청소 주제로 릴스 써줘" | `/릴스레퍼런스기획` 스킬 |
| "계정 문서 만들어줘", "프로필 다시 만들어줘" | `/계정세팅` 스킬 (`기획스킬_SETUP.md` 참고) |
| "화면 비밀번호 바꿔줘" | `.env` 의 `SITE_PASSWORD` 와 `vercel env rm/add SITE_PASSWORD production` 둘 다 갱신 → `vercel --prod --yes` |
| "클라우드 실행 기록 보여줘" | `gh run list --workflow=daily.yml` |

## 절대 규칙

- 사용자는 비개발자다. 터미널은 Claude 가 친다. 한 메시지에 행동 하나, 단계 끝은 "다 되셨으면 '됐어요'". 전문 용어는 괄호로 풀어 쓴다.
- `.env` 의 값(API 키·비밀번호)은 채팅에 출력하지 않는다. `.env` 는 절대 커밋하지 않는다. 커밋 전 `git ls-files | grep -x .env` 가 비어 있어야 한다.
- 클라우드를 켠 뒤에는 로컬 화면의 "수집 시작"을 누르게 하지 않는다(클라우드 커밋과 충돌). 설정 변경은 `git pull` → JSON 수정 → 커밋 → push 순서.
- "만들었다"가 아니라 "돌아간다"를 보고한다. 카드 수·커밋·배포 상태 코드처럼 실제로 본 것만.

## 파일

`server.js`(로컬 서버·API) · `collect.js`(수집) · `analyze.js`(AI 분석) · `index.html`(화면, 서버 없으면 정적 모드) · `data/`(모든 데이터) · `.github/workflows/daily.yml`(매일 07:00 자동 실행) · `vercel.json`·`middleware.js`(클라우드 화면·비밀번호) · `.claude/skills/`(기획·계정세팅 스킬) · `계정/`(내 계정 문서, 커밋 안 함) · `기획/`(기획 결과, 커밋 안 함). 사람용 설명은 `README.md`, 절차는 `SETUP.md`.
