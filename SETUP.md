# 세팅 가이드 — Claude Code 가 읽고 사용자를 이끄는 대본

이 문서는 사람이 읽는 설명서이면서, 이 폴더에서 실행된 Claude Code 가 그대로 따라가는 실행 지시서다.
사용자가 "세팅 가이드대로 진행해줘", "세팅해줘", "시작하자"라고 하면 Claude Code 는 이 문서를 열고 0단계부터 한 단계씩 진행한다.

## Claude Code 가 지킬 원칙

1. 터미널은 Claude 가, 브라우저는 사용자가. 사용자에게 명령어를 치게 하거나 파일을 열어 고치게 하지 않는다. `data/*.json` 은 Claude 가 직접 고쳐도 된다(서버가 켜져 있어도 다음 요청부터 반영).
2. 한 메시지에 행동 하나. 단계 끝은 "다 되셨으면 '됐어요'라고 답해주세요" 한 문장으로 끝낸다.
3. 단계마다 아래 "검증"을 기계로 확인하기 전에는 다음 단계로 가지 않는다.
4. 왜 하는지는 한 줄. 전문 용어는 괄호로 풀어 쓴다. 존댓말. 호칭은 쓰지 않는다.
5. `.env` 의 값과 비밀번호는 채팅에 다시 출력하지 않는다(5-4 의 비밀번호를 처음 알려줄 때 한 번만 예외). `.env` 는 절대 커밋하지 않는다.
6. "만들었다"와 "돌아간다"는 다르다. 실제 실행 결과(카드 수, 커밋, 배포 상태 코드)를 본 것만 완료라고 말한다.

## 전체 그림 (사용자에게 처음 한 번 보여준다)

| 단계 | 하는 일 | 걸리는 시간 | 크레딧 |
|---|---|---|---|
| 0 | 자리 확인 | 1분 | 0 |
| 1 | API 키 넣기 | 5분 | 0 |
| 2 | 화면 켜고 계정 등록 | 5분 | 0 |
| 3 | 첫 수집 + AI 분석 | 10분 | 계정당 3~10 + 내 대본 10 |
| 4 | 기획 스킬 (내 말투 문서) | 15분 | 0 |
| 5 | 클라우드 자동화 (선택) | 20분 | 실행마다 5~10 |

---

## 0단계 · 자리 확인

- 검증: 이 폴더에 `server.js`, `collect.js`, `analyze.js`, `index.html`, `data/config.json`, `.env.example` 이 있다. `node --version` 이 18 이상.
- Node 가 없으면: "https://nodejs.org 에서 LTS 를 설치해 주세요. 설치 뒤 '됐어요'." 로 멈춘다. 그 밖의 설치(npm install 등)는 필요 없다.
- `.git` 폴더와 `origin` 리모트가 있으면(GitHub 의 "Use this template" 로 받은 경우) 기억해 둔다 — 5단계에서 저장소를 새로 만들지 않는다.

## 1단계 · API 키

1. 사용자에게: "https://scrapecreators.com 에서 가입하고 API 키를 복사해 주세요. 무료 크레딧으로 시작할 수 있어요. 복사하셨으면 채팅에 붙여넣어 주세요." (키를 채팅으로 받는 건 이때 한 번뿐)
2. `.env.example` 을 복사해 `.env` 를 만들고 `SCRAPECREATORS_API_KEY=` 에 값을 넣는다. 사용자가 붙여넣은 메시지의 키를 다시 출력하지 않는다.
3. Gemini 키: "AI 분석(왜 터졌나·차용포인트)을 쓰려면 https://aistudio.google.com 에서 'Get API key' 로 무료 키를 만들어 붙여넣어 주세요. 지금은 건너뛰어도 돼요(나중에 '제미나이 키 넣어줘')." 받으면 `GEMINI_API_KEY=` 에 넣는다.
- 검증: `.env` 에 `SCRAPECREATORS_API_KEY=` 뒤에 값이 있다. `curl -s -H "x-api-key: $KEY" https://api.scrapecreators.com/v1/instagram/profile?handle=instagram` 이 JSON 을 돌려준다(크레딧 1). 401 이면 키가 틀린 것.

## 2단계 · 화면 켜고 계정 등록

1. 서버 켜기: 맥은 `open 시작.command`, 윈도우는 `시작.bat`. Claude 가 직접 `node server.js` 를 백그라운드로 돌려도 된다. 브라우저에 http://127.0.0.1:3456 이 열린다. 맥 보안 경고가 뜨면 README 1절의 방법(오른쪽 클릭 → 열기)을 안내한다.
2. 사용자에게 세 가지를 묻는다 — 한 메시지에 하나씩:
   - "레퍼런스로 삼을 인스타 계정을 알려주세요 (@ 없이, 여러 개면 쉼표). 내 분야에서 잘 되는 계정이면 돼요."
   - "내 인스타 아이디는요?"
   - "비교하고 싶은 경쟁사 계정은요? (없으면 '없어요')"
3. Claude 가 `data/accounts.json`(문자열 배열), `data/config.json` 의 `myHandle`, `data/competitors.json` 의 `handles` 에 넣는다. 아이디 규칙: 영문 소문자·숫자·점·밑줄, 30자 이내. 사용자가 링크를 주면 아이디만 뽑는다.
4. 기준 조회수(기본 30만)를 설명한다: "이 조회수 이상인 릴스만 카드가 돼요. 분야가 작으면 5만~10만으로 낮추는 게 좋아요." 바꾸면 `config.minViews`.
- 검증: 화면 새로고침 뒤 설정 탭에 계정 목록이 보이고, 내 계정 & 경쟁사 탭에 내 아이디가 표시된다.

## 3단계 · 첫 수집 + AI 분석

1. "설정 탭의 '수집 시작'을 눌러주세요. 계정당 최근 3페이지를 훑어요. 2~5분 걸려요." (Claude 가 `node collect.js` 를 직접 돌려도 된다.)
2. 끝나면 요약 줄(새로 N개 · 크레딧)을 읽어 준다. "찾을 수 없었던 계정" 이 있으면 철자를 다시 묻는다.
3. Gemini 키가 있으면 수집 뒤 자동으로 분석이 돈다(설정 탭 "AI 분석" 상태). 다 끝날 때까지 기다린 뒤 보고한다. 키가 없으면 "지금은 카드만, 키 넣으면 분석까지" 라고 알린다.
4. 채널 정체성: 설정 탭 "🪄 자동 분석" 을 눌러 초안을 받고 사용자와 다듬어 저장하게 한다(내 릴스 캡션으로 만든다. 다음 분석부터 차용포인트가 내 채널 기준이 됨).
- 검증: `data/refs.json` 에 카드가 1개 이상. Gemini 키가 있으면 `status:"analyzed"` 카드가 1개 이상. 화면에서 카드 클릭 → 팝업에 인스타 영상이 재생된다.
- 카드가 0이면: 기준 조회수를 낮추거나 계정을 바꾼다. 크레딧 부족이면 대시보드 안내.

## 4단계 · 기획 스킬

`기획스킬_SETUP.md` 를 열고 그 0~3단계를 그대로 따른다(자리 확인 → 내 대본 확인 → `/계정세팅` → 첫 기획). 스킬은 이미 `.claude/skills/` 에 들어 있어 설치 단계는 없다. 사용자가 "기획은 나중에" 라고 하면 건너뛰고 5단계로 간다.

- 검증: `계정/<내 아이디>/` 에 문서 6개 + 대표대본, `기획/` 에 첫 기획 파일 1개.

## 5단계 · 클라우드 자동화 (선택 — "컴퓨터 꺼도 매일 아침 수집되게")

사용자에게 먼저 묻는다: "컴퓨터를 꺼 둬도 매일 아침 7시에 자동으로 수집·분석되게 할까요? GitHub 와 Vercel 무료 계정이 필요하고 20분쯤 걸려요. 안 해도 지금처럼 컴퓨터에서 쓸 수 있어요." '아니요' 면 마지막 보고로.

구조(한 줄로 설명): GitHub Actions 가 매일 수집·분석해 결과를 저장소에 커밋 → Vercel 이 화면만 보여줌(비밀번호 잠금) → 설정 변경은 이 폴더에서 Claude 에게 말하면 push.
코드는 이미 다 들어 있다(`.github/workflows/daily.yml`, `vercel.json`, `middleware.js`, `index.html` 정적 모드). 여기서는 계정 연결만 한다.

### 5-1. GitHub

- `gh --version`. 없으면 맥 `brew install gh`(brew 없으면 https://github.com/cli/cli/releases 의 .pkg 를 받아 `open`), 윈도우 `winget install GitHub.cli`.
- `gh auth status`. 이미 로그인돼 있어도 `Token scopes` 에 `workflow` 가 없으면 `gh auth refresh -h github.com -s workflow` (없으면 Actions 파일 push 가 거부된다). 로그인이 없으면 `gh auth login -w -h github.com -p https -s workflow --skip-ssh-key` 를 **백그라운드로 돌려 출력을 파일로** 받고, 거기 찍힌 일회용 코드를 읽어 "https://github.com/login/device 를 열고 이 코드를 입력해 주세요: XXXX-XXXX" 라고 준다. `gh auth status` 가 될 때까지 몇 초마다 확인.
- 이 폴더에만 git 작성자를 이 GitHub 계정으로: `gh api user` 로 id·login 을 받아 `git config --local user.name <login>`, `git config --local user.email <id>+<login>@users.noreply.github.com`. (다른 계정 이메일이면 Vercel 이 배포를 막는다.)
- 저장소:
  - `origin` 이 이미 있으면(템플릿으로 받음) 그대로 쓴다. `gh repo view --json isPrivate` 가 false 면 "저장소를 비공개로 바꿀게요" 하고 `gh repo edit --visibility private --accept-visibility-change-consequences`.
  - 없으면(ZIP) `git init -b main` → `git add -A` → **올라갈 목록을 사용자에게 보여주고 승인**: 올라가는 것(코드·data/·워크플로), 안 올라가는 것(.env·계정/·기획/). `git ls-files | grep -x .env` 가 비어 있어야 한다. 커밋 "수집기 시작" → `gh repo create <폴더명 또는 reels-refs> --private --source=. --remote=origin --push`.
- 시크릿: `.env` 값을 파이프로 `gh secret set SCRAPECREATORS_API_KEY`, 있으면 `GEMINI_API_KEY`. `gh secret list` 로 확인.
- 첫 실행: `gh workflow run daily.yml` → `gh run watch <id> --exit-status`. 성공하면 `git pull` → `git log --oneline -3` 에 "자동: 수집·분석" 커밋. 실패하면 `gh run view <id> --log-failed`.

### 5-2. Vercel

- `vercel --version`. 없으면 `npm i -g vercel`(권한 오류면 `npx vercel` 로 대체).
- `vercel whoami`. 안 되면: 계정이 없으면 https://vercel.com/signup 에서 "Continue with GitHub". `vercel login --non-interactive` 를 백그라운드로 돌려 출력의 "Visit https://vercel.com/oauth/device?user_code=…" 주소를 사용자에게 열어 준다. `vercel whoami` 가 될 때까지 대기.
- `vercel link --yes --project <저장소 이름>`. 비대화 모드라 `"reason":"missing_scope"` JSON 이 나오면 `choices[0].name` 을 읽어 `--scope <그 값>` 을 붙여 다시. 성공 메시지에 "Connecting GitHub repository … Connected" 가 있으면 자동 배포 연결까지 된 것. `vercel git connect` 로 한 번 더 확인("already connected" 면 됨). `.gitignore` 에 `.vercel` 이 중복으로 추가됐으면 `git checkout .gitignore`.
- GitHub 앱 미설치 메시지가 나오면 https://github.com/apps/vercel 을 열어 이 저장소에 권한을 주게 한 뒤 다시.

### 5-3. 비밀번호 잠금

- 비밀번호를 무작위로 만든다(예: `reels-hook-4821` 꼴). `.env` 의 `SITE_PASSWORD=` 에 적고, `printf '%s' "<값>" | vercel env add SITE_PASSWORD production`.
- 사용자에게 한 번만: "화면 주소를 열면 아이디·비밀번호를 묻는데, 아이디는 아무거나, 비밀번호는 <값> 이에요. 바꾸고 싶으면 '화면 비밀번호 바꿔줘'."

### 5-4. 배포와 검증

- `vercel --prod --yes` → 출력의 `Aliased: https://<프로젝트>.vercel.app` 이 화면 주소.
- curl 검증: 비밀번호 없이 `/` 와 `/data/refs.json` 이 401, `curl -u "x:<값>"` 로 `/` 가 200 이고 본문에 "레퍼런스", `/data/refs.json` 이 JSON.
- 자동 배포 검증: README 에 화면 주소 한 줄을 넣어 커밋·push → `gh api repos/<주인>/<저장소>/commits/$(git rev-parse HEAD)/status --jq .state` 가 pending 을 지나 `success`. `failure` 면 Vercel 대시보드에서 이유 확인 — "commit author doesn't have permission" 이면 5-1 의 git 작성자 설정을 다시.
- 봇 커밋 검증: `gh workflow run daily.yml` 을 한 번 더 → 끝나면 `git pull` → 봇 커밋 sha 의 status 도 `success`. (새 커밋이 없으면 "변경 없음"이라 생략 가능하다고 말한다.)
- 브라우저로 화면 주소를 열어 준다.

## 마지막 보고

- 화면 주소(있으면)와 비밀번호(한 번), 저장소 주소(비공개)
- 등록된 계정·경쟁사·내 계정, 카드 수, 분석 수, 남은 크레딧
- 앞으로 부르는 법: "최신 데이터 받아줘"(git pull) · "경쟁사에 OO 추가해줘"(JSON 수정 → 커밋·push) · "지금 수집 돌려줘"(클라우드면 `gh workflow run daily.yml`, 아니면 수집 버튼) · "R-012로 기획해줘" · "화면 비밀번호 바꿔줘"
- 하지 말 것: 클라우드를 켰으면 로컬 설정 탭의 "수집 시작"은 누르지 않는다(같은 파일을 둘이 고쳐 충돌). `.env` 는 절대 커밋하지 않는다. 저장소를 공개로 바꾸지 않는다.
- 충돌 규칙(Claude 가 지킨다): `git pull` 충돌 시 `refs.json`·`seen.json`·`competitors.json` 의 스냅샷·릴스는 클라우드 것을, `accounts.json`·`competitors.json` 의 `handles`·`config.json` 의 설정값(`myHandle`·`channel`·`minViews`·`autoAnalyze`·`myTranscripts`)은 내가 바꾼 값을 다시 얹는다.
