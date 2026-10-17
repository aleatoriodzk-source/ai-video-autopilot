@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo == Estudio Automatico - instalacao ==
where python >nul 2>nul || (echo Instalando Python... & winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements)
where ffmpeg >nul 2>nul || (echo Instalando FFmpeg... & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements)
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt || goto :erro
if not exist voices mkdir voices
set BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR
for %%V in (faber) do (
  if not exist voices\pt_BR-%%V-medium.onnx (
    echo Baixando voz pt_BR-%%V-medium...
    curl -L -o voices\pt_BR-%%V-medium.onnx %BASE%/%%V/medium/pt_BR-%%V-medium.onnx || goto :erro
    curl -L -o voices\pt_BR-%%V-medium.onnx.json %BASE%/%%V/medium/pt_BR-%%V-medium.onnx.json || goto :erro
  )
)
if not exist config.json copy config.example.json config.json >nul
echo.
echo Pronto. Abra config.json, cole o token do painel e rode run.bat
echo (Se o FFmpeg acabou de ser instalado, feche e abra o terminal antes.)
pause
exit /b 0
:erro
echo Falha na instalacao. Veja a mensagem acima.
pause
exit /b 1
