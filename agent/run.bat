@echo off
set "PYTHONHASHSEED=random"
chcp 65001 >nul
cd /d "%~dp0"
echo == Verificando o computador ==
where ffmpeg >nul 2>nul || (echo [ERRO] FFmpeg nao encontrado. Rode install_windows.bat e depois feche e abra esta janela. & pause & exit /b 1)
where ffprobe >nul 2>nul || (echo [ERRO] FFprobe nao encontrado. Rode install_windows.bat e depois feche e abra esta janela. & pause & exit /b 1)
ffmpeg -hide_banner -version >nul 2>nul || (echo [ERRO] O FFmpeg esta instalado mas nao responde. Reinstale com install_windows.bat. & pause & exit /b 1)
if not exist .venv\Scripts\activate.bat (echo [ERRO] Ambiente nao instalado. Rode install_windows.bat primeiro. & pause & exit /b 1)
if not exist videos mkdir videos
if not exist cache mkdir cache
if not exist sfx echo [AVISO] Pasta sfx nao encontrada - os efeitos serao buscados na internet.
echo FFmpeg OK.
call .venv\Scripts\activate.bat
python agent.py --check || (pause & exit /b 1)
python agent.py
pause
