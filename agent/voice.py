"""Isolamento de voz e clonagem de voz (tudo local, no seu PC).

Isolamento: Demucs (Meta) separa a fala da música/efeitos. Sem Demucs, usa um filtro FFmpeg
(bem mais fraco — o log avisa).
Clonagem: F5-TTS (recomendado) ou XTTS-v2 (Coqui). Rode install_voice_clone.bat uma vez.
Sem nenhum deles instalado, a narração NÃO finge ser clonada: o log avisa e usa a voz Edge
com a mesma velocidade de fala medida na referência.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import media


def has_demucs() -> bool:
    try:
        import demucs  # noqa: F401
        return True
    except ImportError:
        return False


def isolate(video: Path, work: Path, log) -> Path:
    """Devolve um WAV só com a voz (sem música e sem efeitos)."""
    work.mkdir(parents=True, exist_ok=True)
    full = work / "full.wav"
    media.run(["ffmpeg", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "44100", str(full)])
    out = work / "vocals.wav"
    if has_demucs():
        log("isolando a voz com Demucs (pode levar 1-3 min sem placa de vídeo)")
        p = subprocess.run([sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(work / "sep"), str(full)],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            raise media.MediaError("Demucs falhou: " + p.stderr[-500:])
        found = next((work / "sep").rglob("vocals.wav"), None)
        if not found:
            raise media.MediaError("Demucs não gerou a faixa de voz")
        shutil.copy(found, out)
        inst = next((work / "sep").rglob("no_vocals.wav"), None)
        if inst:
            media.run(["ffmpeg", "-y", "-i", str(inst), "-ac", "2", "-b:a", "192k", str(work / "music.mp3")])
    else:
        log("Demucs não instalado: usando filtro simples (a música pode vazar). Rode install_voice_clone.bat para isolamento de verdade.")
        media.run(["ffmpeg", "-y", "-i", str(full), "-af", "highpass=f=90,lowpass=f=7500,afftdn=nf=-25,speechnorm=e=6", str(out)])
    return out


def instrumental(work: Path) -> Path | None:
    """Música + efeitos sem a voz (só existe quando o Demucs rodou)."""
    p = work / "music.mp3"
    return p if p.exists() else None


def best_sample(vocals: Path, work: Path, seconds: float = 15.0) -> Path:
    """Corta o trecho mais contínuo de fala (sem pausas longas) para servir de amostra da clonagem."""
    from analyzer import audio_forensics
    dur = media.duration(vocals)
    a = audio_forensics(vocals)
    pauses = [p for p in (a.get("pause_positions_s") or []) if isinstance(p, (int, float))]
    start, best = 0.0, -1.0
    t = 0.0
    while t + seconds <= dur:
        n = sum(1 for p in pauses if t <= p <= t + seconds)
        score = -n
        if best < 0 or score > best:
            best, start = score, t
        t += 2.0
    out = work / "sample.wav"
    media.run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-t", f"{min(seconds, dur):.2f}", "-i", str(vocals), "-ac", "1", "-ar", "24000", str(out)])
    return out


def engine() -> str | None:
    if shutil.which("f5-tts_infer-cli"):
        return "f5"
    try:
        import TTS  # noqa: F401
        return "xtts"
    except ImportError:
        return None


_F5 = None
_REF_TEXT: dict[str, str] = {}


def _f5_model():
    """Carrega o F5-TTS UMA vez e reaproveita em todas as frases (antes recarregava 1.5GB por frase)."""
    global _F5
    if _F5 is None:
        try:
            from f5_tts.api import F5TTS
            _F5 = F5TTS()
        except Exception:
            _F5 = False
    return _F5 or None


def clone_tts(text: str, sample: Path, out_wav: Path, ref_text: str = "") -> str:
    """Fala o texto com o timbre da amostra. Retorna o motor usado."""
    eng = engine()
    if eng == "f5":
        m = _f5_model()
        if m is not None:
            key = str(sample)
            if not ref_text:
                # Transcreve a amostra só uma vez por vídeo (antes o Whisper rodava em toda frase).
                if key not in _REF_TEXT:
                    try:
                        _REF_TEXT[key] = m.transcribe(key)
                    except Exception:
                        _REF_TEXT[key] = ""
                ref_text = _REF_TEXT[key]
            res = out_wav.parent / f"f5_{out_wav.stem}.wav"
            m.infer(ref_file=key, ref_text=ref_text, gen_text=text, file_wave=str(res), remove_silence=True)
            media.run(["ffmpeg", "-y", "-i", str(res), "-ac", "1", "-ar", "44100", str(out_wav)])
            return "F5-TTS"
        tmp = out_wav.parent / f"f5_{out_wav.stem}"
        tmp.mkdir(exist_ok=True)
        cmd = ["f5-tts_infer-cli", "--ref_audio", str(sample), "--ref_text", ref_text or "", "--gen_text", text, "--output_dir", str(tmp), "--output_file", "out.wav"]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        res = tmp / "out.wav"
        if p.returncode != 0 or not res.exists():
            raise media.MediaError("F5-TTS falhou: " + (p.stderr or p.stdout)[-400:])
        media.run(["ffmpeg", "-y", "-i", str(res), "-ac", "1", "-ar", "44100", str(out_wav)])
        return "F5-TTS"
    if eng == "xtts":
        from TTS.api import TTS as Coqui
        global _XTTS
        try:
            _XTTS
        except NameError:
            _XTTS = Coqui("tts_models/multilingual/multi-dataset/xtts_v2")
        _XTTS.tts_to_file(text=text, speaker_wav=str(sample), language="pt", file_path=str(out_wav))
        return "XTTS-v2"
    raise media.MediaError("nenhum motor de clonagem instalado (rode install_voice_clone.bat)")


def edge_rate_for(wpm: float | None) -> str:
    """Converte a velocidade medida (palavras/min) em ajuste da voz Edge (base ~150 wpm)."""
    if not wpm:
        return "+0%"
    pct = max(-30, min(50, round((wpm / 150.0 - 1) * 100)))
    return f"{pct:+d}%"
