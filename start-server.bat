@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 python，请先安装 Python 3，并在安装时勾选 Add Python to PATH。
  pause
  exit /b 1
)
echo 启动闪词 FlashVocab 本地服务器...
start "FlashVocab Server" cmd /k "python -m http.server 5173 --bind 0.0.0.0"
timeout /t 1 >nul
start "" "http://localhost:5173"
