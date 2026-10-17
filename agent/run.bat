@echo off
chcp 65001 >nul
cd /d "%~dp0"
call .venv\Scripts\activate.bat
python agent.py --check || (pause & exit /b 1)
python agent.py
pause
