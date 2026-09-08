#!/bin/bash
# 릴스 레퍼런스 수집기 — 맥용 시작 파일. 더블클릭하면 서버가 켜지고 브라우저가 열려요.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js 가 설치되어 있지 않아요."
  echo "https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 더블클릭해 주세요."
  echo ""
  read -p "엔터를 누르면 창이 닫혀요."
  exit 1
fi
node server.js
echo ""
read -p "서버가 꺼졌어요. 엔터를 누르면 창이 닫혀요."
