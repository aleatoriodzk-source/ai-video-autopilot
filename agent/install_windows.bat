@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo == Estudio Automatico - instalacao ==
rem A voz Piper (onnxruntime) precisa de Python 3.10 a 3.12. Versoes muito novas (3.13+) podem nao funcionar.
set PY=
py -3.12 -c "print()" >nul 2>nul && set PY=py -3.12
if not defined PY py -3.11 -c "print()" >nul 2>nul && set PY=py -3.11
if not defined PY (
  echo Instalando Python 3.12 ^(necessario para a voz^)...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  py -3.12 -c "print()" >nul 2>nul && set PY=py -3.12
)
if not defined PY (
  echo Nao encontrei Python 3.12. Instale em python.org/downloads/release/python-3129 e rode de novo.
  goto :erro
)
where ffmpeg >nul 2>nul || (echo Instalando FFmpeg... & winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements)
if not exist .venv %PY% -m venv .venv || goto :erro
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt || goto :erro
pip install --upgrade yt-dlp
if not exist voices mkdir voices
if not exist videos mkdir videos
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
echo Pronto. Confira se config.json tem o endereco do site e o token, depois rode run.bat
echo (Se o FFmpeg acabou de ser instalado, feche e abra a janela antes.)
pause
exit /b 0
:erro
echo Falha na instalacao. Veja a mensagem acima.
pause
exit /b 1
