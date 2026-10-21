@echo off
chcp 65001 >nul
echo === Instalando isolamento de voz (Demucs) e clonagem de voz (F5-TTS) ===
echo Isso baixa alguns GB e pode levar 10-30 minutos. Com placa de video NVIDIA fica bem mais rapido.
python -m pip install --upgrade pip
python -m pip install demucs
python -m pip install f5-tts
echo.
echo Pronto. Feche o agente e abra o run.bat de novo.
pause
