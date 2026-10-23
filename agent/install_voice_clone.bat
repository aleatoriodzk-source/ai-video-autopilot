@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Instalando isolamento de voz (Demucs) e clonagem de voz (F5-TTS) ===
echo Isso baixa alguns GB e pode levar 10-30 minutos. Com placa de video NVIDIA fica bem mais rapido.
if not exist .venv\Scripts\activate.bat (
  echo Rode primeiro o install_windows.bat
  pause
  exit /b 1
)
rem Instala DENTRO do ambiente do agente (antes instalava no Python do sistema e o agente nao achava).
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
python -m pip install torch==2.5.1 torchaudio==2.5.1 || goto :erro
python -m pip install demucs || goto :erro
python -m pip install f5-tts || goto :erro
python -m pip uninstall -y torchcodec >nul 2>nul
python -m pip install torch==2.5.1 torchaudio==2.5.1
python -c "import demucs; print('Demucs OK')" || goto :erro
echo.
echo Pronto. Feche o agente e abra o run.bat de novo. Depois apague o kit e dissecar o video de novo.
pause
exit /b 0
:erro
echo Falha na instalacao. Veja a mensagem acima.
pause
exit /b 1
