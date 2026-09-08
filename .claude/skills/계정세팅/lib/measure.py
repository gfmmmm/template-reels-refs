#!/usr/bin/env python3
"""대표대본 폴더를 재서 DNA.md·프로필.md에 들어갈 숫자를 JSON으로 낸다.

사용: python3 measure.py <계정 폴더>/대표대본
- 파일마다 '## 대본' 절과 '## 캡션' 절을 읽는다 (제외_ 로 시작하는 파일은 건너뜀)
- 출력: 문장 수·평균 문장 길이·어미 상위 15·1인칭/호칭 빈도·금지어 빈도·어절 상위 40·
        캡션 통계(첫 줄 질문형·평균 길이·해시태그 위치·공구 표식)·대본 길이(공백 제외) 파일별
숫자는 이 스크립트가 낸 것만 문서에 쓴다. Claude가 어림하지 않는다.
"""
import json, re, sys, pathlib
from collections import Counter

FORBIDDEN = ["여러분", "알려드릴게요", "장담하는데", "저장", "팔로우", "솔직히", "댓글", "진짜", "정말", "완전", "충격"]
FIRST_PERSON = ["저는", "저도", "제가", "제 ", "저 ", "우리 집", "저희"]
CALLS = ["여러분", "맘님", "님들", "분들", "여보", "오빠", "자기야", "와이프", "남편", "아내", "애들", "아이들"]
COMMERCE_TAGS = ["#공구", "#공동구매", "#특가", "#마감", "#광고", "#협찬", "#내돈내산", "공구", "최저가", "할인"]

def section(text, name):
    m = re.search(r"^## " + re.escape(name) + r".*?$\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    return m.group(1).strip() if m else ""

def sentences(t):
    t = re.sub(r"\s+", " ", t)
    parts = re.split(r"(?<=[.!?。])\s+|(?<=요)\s+(?=[가-힣])", t)
    return [p.strip() for p in parts if len(p.strip()) >= 4]

def ending(s):
    s = re.sub(r"[\"'“”‘’.!?…,]+$", "", s.strip())
    w = s.split()[-1] if s.split() else s
    # 어미만: 마지막 어절의 뒤 3~4글자
    return w[-4:] if len(w) >= 4 else w

def main(folder):
    folder = pathlib.Path(folder)
    files = sorted(p for p in folder.glob("M-*.md") if not p.name.startswith("제외_"))
    per_file, all_sents, caps = [], [], []
    words = Counter()
    for p in files:
        t = p.read_text(encoding="utf-8")
        script = section(t, "대본")
        if script.startswith("대본 없음"): script = ""  # 표시 문구를 문장·어미로 세지 않는다
        cap = section(t, "캡션")
        ss = sentences(script)
        all_sents += ss
        words.update(re.findall(r"[가-힣]{2,}", script))
        per_file.append({
            "file": p.name,
            "chars_no_space": len(re.sub(r"\s", "", script)),
            "sentences": len(ss),
            "first_two": " ".join(ss[:2]),
            "last": ss[-1] if ss else "",
        })
        if cap:
            caps.append(cap)
    n = len(all_sents)
    avg_len = round(sum(len(s) for s in all_sents) / n, 1) if n else 0
    endings = Counter(ending(s) for s in all_sents)
    joined = "\n".join(all_sents)
    forbidden = {w: joined.count(w) for w in FORBIDDEN}
    first_person = {w.strip(): joined.count(w) for w in FIRST_PERSON}
    calls = {w: joined.count(w) for w in CALLS if joined.count(w)}
    cap_stats = {}
    if caps:
        first_lines = [c.splitlines()[0] for c in caps if c.splitlines()]
        cap_stats = {
            "count": len(caps),
            "first_line_question": sum(1 for l in first_lines if l.rstrip().endswith("?") or "?" in l[:40]),
            "avg_len": round(sum(len(c) for c in caps) / len(caps)),
            "hashtag_first": sum(1 for l in first_lines if l.lstrip().startswith("#")),
            "hashtag_last": sum(1 for c in caps if c.strip().splitlines()[-1].lstrip().startswith("#")),
            "commerce_marked": sum(1 for c in caps if any(k in c for k in COMMERCE_TAGS)),
            "sample_first_lines": first_lines[:6],
        }
    out = {
        "files": len(files),
        "sentences": n,
        "avg_sentence_len": avg_len,
        "endings_top15": endings.most_common(15),
        "first_person": first_person,
        "calls": calls,
        "forbidden": forbidden,
        "words_top40": [w for w in words.most_common(60) if w[0] not in ("그래서", "그런데", "이렇게", "이거는", "있어요", "없어요")][:40],
        "caption": cap_stats,
        "per_file": per_file,
    }
    print(json.dumps(out, ensure_ascii=False, indent=1))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용: python3 measure.py <계정 폴더>/대표대본"); sys.exit(1)
    main(sys.argv[1])
