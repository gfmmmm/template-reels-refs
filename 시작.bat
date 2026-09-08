@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 가 설치되어 있지 않아요.
  echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 더블클릭해 주세요.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo 서버가 꺼졌어요.
pause
