"""Processamento local: Piper (voz), FFmpeg (cenas, legendas, mixagem, render) e validação."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

ASPECTS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}


class MediaError(RuntimeError):
    pass


def size_for(aspect: str, resolution: str = "1080p") -> tuple[int, int]:
    w, h = ASPECTS.get(aspect, ASPECTS["9:16"])
    if resolution == "720p":
        w, h = w * 2 // 3, h * 2 // 3
    return w - w % 2, h - h % 2


def run(cmd: list[str], cwd: Path | None = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise MediaError(f"{Path(cmd[0]).name} falhou ({p.returncode}): {p.stderr[-1500:]}")
    return p.stdout


def require_tools() -> dict:
    missing = [t for t in ("ffmpeg", "ffprobe") if not shutil.which(t)]
    if missing:
        raise MediaError("Não encontrado no PATH: " + ", ".join(missing) + ". Rode install_windows.bat ou 'winget install Gyan.FFmpeg'.")
    return {"ffmpeg": run(["ffmpeg", "-version"]).splitlines()[0][:80]}


def probe(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(path)])
    return json.loads(out)


def duration(path: Path) -> float:
    return float(probe(path)["format"]["duration"])


# ---------------- Narração (Piper local) ----------------

_SYMBOL_WORDS = {"%": " por cento", "&": " e ", "+": " mais ", "=": " igual a ", "R$": " reais "}


def clean_tts(text: str) -> str:
    """Deixa só texto falável: remove emojis, símbolos (§ ¶ * # _ etc.), rubricas entre ()/[] e espaços extras."""
    t = unicodedata.normalize("NFC", text or "")
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)|\{[^}]*\}", " ", t)  # rubricas: (pausa), [música]
    for k, v in _SYMBOL_WORDS.items():
        t = t.replace(k, v)
    keep = []
    for ch in t:
        cat = unicodedata.category(ch)
        if cat[0] in ("L", "N") or ch in " .,!?;:'-\n":
            keep.append(ch)
        elif cat.startswith("Z") or ch in "\t\r":
            keep.append(" ")
        elif ch in "—–…":
            keep.append(", ")
        # emojis (So), modificadores, ZWJ (Cf), § ¶ * # _ / etc. são descartados
    t = "".join(keep).replace("\n", ". ")
    t = re.sub(r"\s*-\s+|\s+-\s*", ", ", t)
    t = re.sub(r"([.,!?;:])\1+", r"\1", t)
    t = re.sub(r"\s+([.,!?;:])", r"\1", t)
    t = re.sub(r"(^|[.!?]\s*)[,;:]\s*", r"\1", t)
    return re.sub(r"\s{2,}", " ", t).strip(" ,;:")


def piper_tts(text: str, voice_path: Path, out_wav: Path, length_scale=1.0, noise_scale=0.667, sentence_silence=0.3) -> None:
    if not voice_path.exists():
        raise MediaError(f"Voz Piper não encontrada: {voice_path}. Rode install_windows.bat para baixá-la.")
    text = clean_tts(text)
    if not text:
        raise MediaError("narração ficou vazia depois da limpeza de símbolos")
    cmd = [sys.executable, "-m", "piper", "-m", str(voice_path), "-f", str(out_wav),
           "--length-scale", str(length_scale), "--noise-scale", str(noise_scale), "--sentence-silence", str(sentence_silence)]
    p = subprocess.run(cmd, input=text, capture_output=True, text=True, encoding="utf-8")
    if p.returncode != 0 or not out_wav.exists():
        raise MediaError(f"Piper falhou: {p.stderr[-800:]}")


def edge_tts(text: str, voice: str, out_wav: Path, rate: str = "+0%") -> None:
    """Voz neural gratuita da Microsoft (precisa de internet). Gera MP3 e converte para WAV."""
    text = clean_tts(text)
    if not text:
        raise MediaError("narração ficou vazia depois da limpeza de símbolos")
    mp3 = out_wav.with_suffix(".mp3")
    cmd = [sys.executable, "-m", "edge_tts", "--voice", voice, f"--rate={rate}", "--text", text, "--write-media", str(mp3)]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0 or not mp3.exists() or mp3.stat().st_size < 500:
        raise MediaError(f"edge-tts falhou: {p.stderr[-400:]}")
    run(["ffmpeg", "-y", "-i", str(mp3), "-ar", "48000", "-ac", "1", str(out_wav)])


def scene_audio(raw_wav: Path, out_wav: Path, pause_ms: int) -> float:
    """Converte para 48 kHz e adiciona a pausa ao fim da cena. Retorna a duração final."""
    pad = max(0, pause_ms) / 1000
    run(["ffmpeg", "-y", "-i", str(raw_wav), "-af", f"apad=pad_dur={pad:.3f}", "-ar", "48000", "-ac", "1", str(out_wav)])
    return duration(out_wav)


# ---------------- Legendas (.ass) ----------------

def chunk_words(text: str, max_words: int = 3) -> list[str]:
    words = text.split()
    return [" ".join(words[i:i + max_words]) for i in range(0, len(words), max_words)]


def word_timings(text: str, speech_s: float, start: float = 0.0, max_words: int = 3) -> list[dict]:
    """Distribui os blocos de legenda proporcionalmente ao nº de caracteres (estimativa sem alinhamento acústico)."""
    chunks = chunk_words(text, max_words)
    total = sum(len(c) for c in chunks) or 1
    t, out = start, []
    for c in chunks:
        d = speech_s * len(c) / total
        out.append({"text": c, "start": round(t, 3), "end": round(t + d, 3)})
        t += d
    return out


def _ts(s: float) -> str:
    cs = int(round(s * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _esc(t: str) -> str:
    return re.sub(r"[{}\\]", "", t).replace("\n", " ")


def write_ass(cues: list[dict], w: int, h: int, out: Path, font: str = "Arial Black") -> None:
    fs = int(h * (0.045 if h > w else 0.06))
    margin_v = int(h * (0.28 if h > w else 0.1))
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,{font},{fs},&H00FFFFFF,&H0000D7FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,{max(3, fs // 12)},2,2,60,60,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [
        f"Dialogue: 0,{_ts(c['start'])},{_ts(c['end'])},Main,,0,0,0,,{{\\fad(60,40)\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)}}{_esc(c['text']).upper()}"
        for c in cues if c["end"] > c["start"]
    ]
    out.write_text(head + "\n".join(lines) + "\n", encoding="utf-8")


# ---------------- Imagens e cenas ----------------

def text_card(text: str, w: int, h: int, out: Path) -> None:
    """Fundo neutro quando não há imagem disponível (a legenda é aplicada depois)."""
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=0x1d1f26:s={w}x{h}", "-vf", "vignette", "-frames:v", "1", str(out)])


MOTIONS = {
    "zoom_in": ("min(zoom+{r},1.25)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "zoom_out": ("if(eq(on,0),1.25,max(zoom-{r},1.0))", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "pan_left": ("1.15", "(iw-iw/zoom)*(1-on/{n})", "ih/2-(ih/zoom/2)"),
    "pan_right": ("1.15", "(iw-iw/zoom)*on/{n}", "ih/2-(ih/zoom/2)"),
}


def scene_clip(image: Path, dur: float, w: int, h: int, fps: int, motion: str, out: Path, crf: int = 20) -> None:
    n = max(1, int(round(dur * fps)))
    z, x, y = MOTIONS.get(motion or "zoom_in", MOTIONS["zoom_in"])
    rate = 0.25 / n
    z, x, y = (s.format(r=f"{rate:.6f}", n=n) for s in (z, x, y))
    vf = (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=increase,crop={w * 2}:{h * 2},"
          f"zoompan=z='{z}':x='{x}':y='{y}':d={n}:s={w}x{h}:fps={fps},format=yuv420p")
    run(["ffmpeg", "-y", "-i", str(image), "-vf", vf, "-frames:v", str(n), "-r", str(fps),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-an", str(out)])


def video_clip(src: Path, dur: float, w: int, h: int, fps: int, out: Path, crf: int = 20) -> None:
    """Corta/repete um vídeo de banco para a duração da cena, preenchendo o quadro (crop central)."""
    n = max(1, int(round(dur * fps)))
    vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps={fps},format=yuv420p,setsar=1"
    run(["ffmpeg", "-y", "-stream_loop", "-1", "-i", str(src), "-vf", vf, "-frames:v", str(n), "-r", str(fps),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-an", str(out)])


def concat(files: list[Path], out: Path, workdir: Path, audio: bool) -> None:
    lst = workdir / (out.stem + "_list.txt")
    lst.write_text("".join(f"file '{f.resolve().as_posix()}'\n" for f in files), encoding="utf-8")
    codec = ["-c:a", "pcm_s16le"] if audio else ["-c", "copy"]
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), *codec, str(out)])


def final_mix(video: Path, voice: Path, subs_name: str, out: Path, workdir: Path, music: Path | None,
              music_db: float = -20, lufs: float = -16, crf: int = 20) -> None:
    """Queima legendas, normaliza a voz e, se houver música, aplica ducking (sidechain) sob a narração."""
    inputs = ["-i", str(video), "-i", str(voice)]
    vf = f"[0:v]subtitles={subs_name}[v]"
    if music and music.exists():
        inputs += ["-stream_loop", "-1", "-i", str(music)]
        af = (f"[1:a]loudnorm=I={lufs}:TP=-1.5:LRA=11,asplit=2[vo][sc];"
              f"[2:a]volume={music_db}dB[m];[m][sc]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[md];"
              f"[vo][md]amix=inputs=2:duration=first:normalize=0[a]")
    else:
        af = f"[1:a]loudnorm=I={lufs}:TP=-1.5:LRA=11[a]"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", f"{vf};{af}", "-map", "[v]", "-map", "[a]",
         "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", out.name], cwd=workdir)


def validate(out: Path, expected_s: float, w: int, h: int) -> dict:
    issues: list[str] = []
    if not out.exists() or out.stat().st_size < 10_000:
        return {"ok": False, "issues": ["arquivo final ausente ou vazio"]}
    info = probe(out)
    kinds = [s.get("codec_type") for s in info.get("streams", [])]
    if "video" not in kinds:
        issues.append("sem trilha de vídeo")
    if "audio" not in kinds:
        issues.append("sem trilha de áudio")
    v = next((s for s in info["streams"] if s.get("codec_type") == "video"), {})
    if (v.get("width"), v.get("height")) != (w, h):
        issues.append(f"proporção incorreta: {v.get('width')}x{v.get('height')} (esperado {w}x{h})")
    d = float(info["format"]["duration"])
    if abs(d - expected_s) > max(1.0, expected_s * 0.05):
        issues.append(f"duração {d:.1f}s difere do esperado {expected_s:.1f}s")
    # Verifica se o arquivo decodifica do início ao fim.
    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
    if p.stderr.strip():
        issues.append("erros de decodificação: " + p.stderr[:300])
    return {"ok": not issues, "issues": issues, "duration_s": round(d, 2), "size_bytes": out.stat().st_size, "resolution": f"{v.get('width')}x{v.get('height')}"}
