@echo off
chcp 65001 >nul
title 智行地圖後端伺服器
cd /d "%~dp0.."

rem 資料存放位置(不要放在 OneDrive 裡)。要換地方就改這一行
if "%SNM_DATA_DIR%"=="" set SNM_DATA_DIR=C:\SmartNavData

where node >/dev/null 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝：
  echo   https://nodejs.org  下載 LTS 版本安裝，或在命令列執行：
  echo   winget install OpenJS.NodeJS.LTS
  echo 安裝完關掉這個視窗再重新開啟。
  pause
  exit /b 1
)

:loop
node server\server.js
echo.
echo 伺服器停止了，5 秒後自動重新啟動(要結束請直接關掉這個視窗)...
timeout /t 5 /nobreak >nul
goto loop
