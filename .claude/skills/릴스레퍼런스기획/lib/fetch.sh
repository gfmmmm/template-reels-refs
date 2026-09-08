#!/usr/bin/env bash
# 릴스레퍼런스기획 데이터 조회 — "릴스 레퍼런스 수집기" 폴더의 data/*.json 만 읽는다. python3 만 필요.
# 사용법:
#   bash lib/fetch.sh mode                   수집기 폴더를 찾았는지 한 줄
#   bash lib/fetch.sh ctx                    내 계정·채널 정체성·콘텐츠 기둥·평균 조회·카드 범위·경쟁사
#   bash lib/fetch.sh card R-007             레퍼런스 카드 1건 (캡션·대본·시각분석·종합분석)
#   bash lib/fetch.sh card M-003             내 릴스 1건 (조회순 M-001 부터. 캡션·대본)
#   bash lib/fetch.sh my_top [N|기준조회수]   내 릴스 조회 상위 N건(기본 20) 또는 조회 N 이상 (대본 포함)
#   bash lib/fetch.sh refs "키워드"           주제·캡션·대본에 키워드가 든 카드 — 조회 상위 15건을 키워드 밀도로 재정렬해 최대 7건
#   bash lib/fetch.sh refs ""                키워드 없이 조회 상위 30건 (첫 3초·후킹 붙여서 — 계정세팅 훅 재료)
#   bash lib/fetch.sh list                   카드 전체 한 줄씩
# 폴더 찾기: 작업 폴더에서 위로 올라가며 data/refs.json 이 있는 첫 폴더. 환경변수 REELS_REFS_DIR 이 있으면 그것.
set -euo pipefail

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

find_root() {
  if [ -n "${REELS_REFS_DIR:-}" ] && [ -f "${REELS_REFS_DIR%/}/data/refs.json" ]; then echo "${REELS_REFS_DIR%/}"; return 0; fi
  local d; d="$(pwd -P)"
  while [ "$d" != "/" ]; do
    if [ -f "$d/data/refs.json" ]; then echo "$d"; return 0; fi
    d="$(dirname "$d")"
  done
  # 스킬 파일 위치 기준(수집기 폴더 안에 설치된 경우)
  d="$(cd -P "$(dirname "$0")" && cd ../../../.. && pwd)"
  if [ -f "$d/data/refs.json" ]; then echo "$d"; return 0; fi
  return 1
}

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "❌ python3 가 필요합니다 (맥은 기본 설치, 윈도우는 python.org 에서 설치)"; exit 1; }

CMD="${1:-}"
[ -n "$CMD" ] || { usage; exit 1; }

ROOT="$(find_root || true)"
if [ -z "$ROOT" ]; then
  if [ "$CMD" = "mode" ]; then echo "❌ 수집기 폴더를 찾지 못했습니다 — data/refs.json 이 있는 '릴스 레퍼런스 수집기' 폴더에서 열어주세요"; exit 0; fi
  echo "❌ 수집기 폴더를 찾지 못했습니다 — data/refs.json 이 있는 '릴스 레퍼런스 수집기' 폴더에서 열어주세요"; exit 1
fi
DDIR="$ROOT/data"

# 공용 파이썬 머리 — 파일 로드 + 내 릴스 목록(M 번호는 조회순)
PYHEAD='
import json,os,sys,re
ddir=sys.argv[1]
def load(name, fb):
    p=os.path.join(ddir,name)
    if not os.path.exists(p): return fb
    with open(p,encoding="utf-8") as f: return json.load(f)
refs=load("refs.json",[])
comp=load("competitors.json",{"handles":[],"snapshots":{},"reels":{},"profiles":{}})
cfg=load("config.json",{})
me=(cfg.get("myHandle") or "").strip().lower()
snaps=sorted(comp.get("snapshots",{}).get(me,[]), key=lambda s:s.get("date",""))
followers=snaps[-1]["followers"] if snaps else (comp.get("profiles",{}).get(me,{}) or {}).get("followers")
myreels=[dict(code=c,**v) for c,v in (comp.get("reels",{}).get(me,{}) or {}).items() if isinstance(v.get("views"),(int,float))]
myreels.sort(key=lambda r:-(r.get("views") or 0))
for i,r in enumerate(myreels): r["cardNo"]="M-%03d"%(i+1)
def fmt(n):
    try: return "{:,}".format(int(n))
    except Exception: return "-"
def block(title,v):
    print("## "+title); print()
    if isinstance(v,dict):
        n=0
        for k,x in v.items():
            n+=1
            if isinstance(x,list):
                print("- **%s**"%k)
                for y in x: print("  - %s"%y)
            elif isinstance(x,dict):
                print("- **%s**: %s"%(k, "; ".join("%s: %s"%(a,b) for a,b in x.items())))
            else: print("- **%s**: %s"%(k,x))
        if not n: print("(없음)")
    else: print((v or "(없음)").strip() if isinstance(v,str) else v)
    print()
'

case "$CMD" in
mode)
  echo "reels-refs 모드 — 수집기 폴더: $ROOT"
  ;;

ctx)
  "$PY" -c "$PYHEAD"'
views=[r["views"] for r in myreels]
avg=int(sum(views)/len(views)) if views else 0
ch=cfg.get("channel") or {}
prof=comp.get("profiles",{}).get(me,{}) or {}
print("# 계정 정체성"); print()
print("- 핸들: @%s (%s)"%(me or "(설정 안 됨 — 경쟁사 탭 오른쪽 위에서 내 계정을 넣어주세요)", prof.get("fullName") or ""))
print("- 팔로워: %s"%fmt(followers))
print("- 평균 조회: %s (내 릴스 %d개 기준)"%(fmt(avg), len(myreels)))
print("- 대본이 있는 내 릴스: %d개 (수집기 설정 \"내 상위 릴스 대본도 수집\"을 켜고 수집하면 늘어남)"%sum(1 for r in myreels if r.get("transcript")))
print("- 경쟁사: %s"%(", ".join("@"+h for h in comp.get("handles",[])) or "(없음)"))
print(); print("## 브리프 (수집기 설정 > 내 채널 정체성)"); print()
print((ch.get("brief") or "(비어 있음 — 수집기 설정 탭에서 🪄 자동 분석으로 채운 뒤 저장)").strip())
print(); print("## 콘텐츠 기둥"); print()
for p in ch.get("pillars") or []: print("- %s"%p)
if not (ch.get("pillars")): print("(비어 있음)")
print(); print("## 카드 번호 범위"); print()
nums=[int(r["id"].split("-")[1]) for r in refs if isinstance(r.get("id"),str) and r["id"].startswith("R-")]
print("- 레퍼런스: R-001 ~ R-%03d (%d건, 분석됨 %d건, 숨김 %d건)"%(max(nums) if nums else 0, len(nums), sum(1 for r in refs if r.get("status")=="analyzed"), sum(1 for r in refs if r.get("hidden"))))
print("- 내 릴스: M-001 ~ M-%03d (%d건, 조회 높은 순 번호)"%(len(myreels), len(myreels)))
' "$DDIR"
  ;;

card)
  NUM="${2:-}"; [ -n "$NUM" ] || { echo "❌ 카드 번호가 필요합니다 (예: card R-007 / card M-003)"; exit 1; }
  "$PY" -c "$PYHEAD"'
num=sys.argv[2].upper().lstrip("#")
if num.startswith("R-"):
    r=next((x for x in refs if x.get("id")==num), None)
    if r is None: sys.stderr.write("❌ %s 카드가 없습니다 (fetch.sh list 로 확인)\n"%num); sys.exit(1)
    print("# %s · @%s · %s회"%(num, r.get("account",""), fmt(r.get("views")))); print()
    print("- 링크: %s"%(r.get("url") or ""))
    print("- 게시일: %s · 좋아요 %s · 댓글 %s · 길이 %s초"%((r.get("postedAt") or "")[:10], fmt(r.get("likes")), fmt(r.get("comments")), r.get("duration") or "-"))
    com=r.get("commerceOverride") or r.get("commerce") or "일반"
    print("- 상업성: %s%s"%(com, " · 숨김(관련성 낮음)" if r.get("hidden") else "")); print()
    if r.get("status")!="analyzed": print("> 분석 전 — 캡션·대본만 (수집기 팝업에서 \"지금 이 릴스 분석하기\")"); print()
    block("캡션", r.get("caption"))
    block("대본 (음성 전사 원문 — 오인식 가능, 캡션과 교차)", r.get("transcript") or "(무음 또는 미추출: %s)"%(r.get("transcriptNote") or ""))
    if r.get("status")=="analyzed":
        va=r.get("videoAnalysis") or {}
        order=["초반3초훅","인물","컷편집","영상연출","자막스타일"]
        ordered={k:va[k] for k in order if k in va}
        for k,x in va.items():
            if k not in ordered: ordered[k]=x
        block("시각 분석", ordered)
        an=r.get("analysis") or {}
        comp_={k:an[k] for k in ("주제","후킹","좋은점","차용포인트","내채널_관련성","소구점") if k in an}
        block("종합 분석", comp_)
elif num.startswith("M-"):
    r=next((x for x in myreels if x["cardNo"]==num), None)
    if r is None: sys.stderr.write("❌ %s 내 릴스가 없습니다 (내 릴스 %d건)\n"%(num,len(myreels))); sys.exit(1)
    print("# %s · @%s · %s회"%(num, me, fmt(r.get("views")))); print()
    print("- 링크: https://www.instagram.com/reel/%s/"%r["code"])
    print("- 게시일: %s · 좋아요 %s · 댓글 %s · 길이 %s초"%((r.get("postedAt") or "")[:10], fmt(r.get("likes")), fmt(r.get("comments")), r.get("duration") or "-")); print()
    block("캡션 (앞 200자)", r.get("caption"))
    if r.get("transcript") is None and "transcript" not in r:
        block("대본", "(수집 안 됨 — 수집기 설정에서 \"내 상위 릴스 대본도 수집\"을 켜고 수집을 한 번 돌리면 상위 릴스부터 채워집니다)")
    else:
        block("대본 (음성 전사 원문)", r.get("transcript") or "(무음 또는 미추출: %s)"%(r.get("transcriptNote") or ""))
else:
    sys.stderr.write("❌ 카드 번호는 R-### 또는 M-### 형식입니다\n"); sys.exit(1)
' "$DDIR" "$NUM"
  ;;

my_top)
  ARG="${2:-20}"
  "$PY" -c "$PYHEAD"'
arg=sys.argv[2]
try: n=int(str(arg).replace(",",""))
except Exception: n=20
pool=[r for r in myreels if r.get("views",0)>=n] if n>=1000 else myreels[:n]
print("# 내 릴스 %s (%d건)"%("조회 %s 이상"%fmt(n) if n>=1000 else "조회 상위 %d"%n, len(pool))); print()
for r in pool:
    print("## %s · %s회 · %s"%(r["cardNo"], fmt(r.get("views")), (r.get("postedAt") or "")[:10]))
    print("- 링크: https://www.instagram.com/reel/%s/"%r["code"])
    print("- 캡션: %s"%((r.get("caption") or "").replace("\n"," ")))
    if "transcript" in r:
        print("- 대본: %s"%((r.get("transcript") or "(무음 또는 미추출: %s)"%(r.get("transcriptNote") or "")).strip()))
    else:
        print("- 대본: (수집 안 됨)")
    print()
' "$DDIR" "$ARG"
  ;;

refs)
  KW="${2-}"
  "$PY" -c "$PYHEAD"'
kw=sys.argv[2]
kws=[k.lower() for k in kw.split() if k.strip()]
items=[r for r in refs if not r.get("hidden")]
def cnt(s,k): return (s or "").lower().count(k)
def head_of(r):
    va=r.get("videoAnalysis") or {}; an=r.get("analysis") or {}
    return va.get("초반3초훅") or "", an.get("후킹") or "", an.get("주제") or ""
def trunc(s,n=70):
    s=(s or "").replace("\n"," ")
    return s[:n]+("…" if len(s)>n else "")
if not kws:
    pool=sorted(items, key=lambda r:-(r.get("views") or 0))[:30]
    print("# 레퍼런스 조회 상위 %d건"%len(pool)); print()
    for r in pool:
        h3,hook,topic=head_of(r)
        tr=(r.get("transcript") or "").strip().replace("\n"," ")
        first2=" ".join(re.split(r"(?<=[.!?。])\s+", tr)[:2]) if tr else ""
        print("- %s · @%s · %s회 · [주제] %s"%(r.get("id"), r.get("account"), fmt(r.get("views")), trunc(topic,60)))
        if first2: print("  [대본 첫 두 문장] %s"%trunc(first2,120))
        if h3: print("  [첫 3초] %s"%trunc(h3,110))
        if hook: print("  [후킹] %s"%trunc(hook,110))
    sys.exit(0)
def matches(r):
    h3,hook,topic=head_of(r)
    for k in kws:
        if k in (r.get("caption") or "").lower() or k in (r.get("transcript") or "").lower() or k in topic.lower(): return True
    return False
pool=[r for r in items if matches(r)]
pool.sort(key=lambda r:-(r.get("views") or 0)); pool=pool[:15]
def score(r):
    h3,hook,topic=head_of(r)
    head=sum(cnt(topic,k)+cnt(r.get("caption"),k) for k in kws); body=sum(cnt(r.get("transcript"),k) for k in kws)
    return head*3+body
pool.sort(key=lambda r:(-score(r), -(r.get("views") or 0))); pool=pool[:7]
if not pool: print("(일치하는 카드 없음 — 키워드를 바꿔 보세요)"); sys.exit(0)
print("# \"%s\" 관련 레퍼런스 %d건 (키워드 밀도순)"%(kw,len(pool))); print()
for r in pool:
    h3,hook,topic=head_of(r)
    print("- %s · @%s · %s회 · [점수 %d] · [주제] %s"%(r.get("id"), r.get("account"), fmt(r.get("views")), score(r), trunc(topic,60)))
    if h3: print("  [첫 3초] %s"%trunc(h3,110))
    if hook: print("  [후킹] %s"%trunc(hook,110))
' "$DDIR" "$KW"
  ;;

list)
  "$PY" -c "$PYHEAD"'
for r in sorted(refs, key=lambda r:-(r.get("views") or 0)):
    an=r.get("analysis") or {}
    print("%s · @%s · %s회 · %s%s · %s"%(r.get("id"), r.get("account"), fmt(r.get("views")), "분석됨" if r.get("status")=="analyzed" else "분석 전", " · 숨김" if r.get("hidden") else "", (an.get("주제") or (r.get("caption") or "").split("\n")[0])[:50]))
' "$DDIR"
  ;;

*)
  usage; exit 1 ;;
esac
