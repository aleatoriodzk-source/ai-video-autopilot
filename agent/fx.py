"""Biblioteca automática: transições reais, efeitos sonoros gerados pelo próprio FFmpeg
(sem baixar nada) e música livre buscada online por clima (Openverse, licenças CC0/CC-BY)."""
from __future__ import annotations

import random
import unicodedata
from pathlib import Path

import requests

import media

XFADE = {"fade": "fade", "slideleft": "slideleft", "slideright": "slideright", "zoomin": "zoomin", "circleopen": "circleopen"}
TRANS_S = 0.35

# Efeitos sintetizados (expressões lavfi). Nenhum arquivo externo, nenhuma licença envolvida.
SFX = {
    "whoosh": "anoisesrc=d=0.6:c=pink:a=0.9,highpass=f=300,lowpass=f=4000,afade=t=in:d=0.25,afade=t=out:st=0.3:d=0.3",
    "impact": "sine=f=55:d=0.7,volume=2.5,afade=t=out:st=0.05:d=0.65",
    "riser": "anoisesrc=d=1.4:c=white:a=0.5,highpass=f=800,afade=t=in:d=1.3,afade=t=out:st=1.3:d=0.1",
    "click": "sine=f=1800:d=0.05,afade=t=out:d=0.05",
    "ding": "sine=f=1320:d=0.8,afade=t=out:st=0.02:d=0.78",
    "boom": "anoisesrc=d=1.2:c=brown:a=1,lowpass=f=180,afade=t=out:st=0.05:d=1.1",
}
SFX_WORDS = {
    "whoosh": ["whoosh", "swoosh", "transi", "vento", "passagem"],
    "impact": ["impact", "impacto", "hit", "soco", "batida", "revela"],
    "riser": ["riser", "tensao", "suspense", "subida", "build"],
    "click": ["click", "clique", "tick", "relogio"],
    "ding": ["ding", "sino", "notifica", "acerto"],
    "boom": ["boom", "explos", "trovao", "rugido", "grave"],
}
MOOD_WORDS = {
    "suspense": ["misterio", "segredo", "oculto", "medo", "terror", "crime", "sombrio", "perigo", "predador"],
    "epico": ["guerra", "batalha", "imperio", "historia", "conquista", "heroi", "poder", "lenda"],
    "calmo": ["natureza", "relax", "medita", "oceano", "sono", "paz"],
    "alegre": ["dica", "receita", "divertid", "curios", "engracad", "viagem"],
    "triste": ["tragedia", "morte", "perda", "triste", "abandon"],
}
MOOD_QUERY = {"suspense": "suspense dark ambient", "epico": "epic cinematic", "calmo": "calm ambient piano",
              "alegre": "upbeat happy", "triste": "sad piano"}


def _norm(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (t or "").lower()) if unicodedata.category(c) != "Mn")


def sfx_kind(text: str) -> str | None:
    t = _norm(text)
    if not t or t in ("nenhum", "none", "-"):
        return None
    for k, words in SFX_WORDS.items():
        if any(w in t for w in words):
            return k
    return "whoosh"


def guess_mood(topic: str, scenes: list[dict]) -> str:
    text = _norm(topic + " " + " ".join(s.get("narration") or "" for s in scenes[:4]))
    scores = {m: sum(text.count(w) for w in ws) for m, ws in MOOD_WORDS.items()}
    best = max(scores, key=scores.get)
    return best if scores[best] else "suspense"


def make_sfx(kind: str, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{kind}.wav"
    if not out.exists():
        media.run(["ffmpeg", "-y", "-f", "lavfi", "-i", SFX[kind], "-ar", "48000", "-ac", "2", str(out)])
    return out


def online_music(mood: str, cache: Path, log=print) -> Path | None:
    """Busca uma música livre (CC0/CC-BY) por clima e guarda só no cache temporário do programa."""
    folder = cache / mood
    folder.mkdir(parents=True, exist_ok=True)
    have = [p for p in folder.glob("*.mp3")]
    if len(have) >= 3:
        return random.choice(have)
    try:
        r = requests.get("https://api.openverse.org/v1/audio/", params={"q": MOOD_QUERY.get(mood, mood), "license": "cc0,by,pdm", "category": "music", "page_size": 20}, timeout=20)
        r.raise_for_status()
        items = [i for i in r.json().get("results", []) if i.get("url") and 20 <= (i.get("duration") or 0) / 1000 <= 600]
        random.shuffle(items)
        for it in items[:3]:
            dest = folder / f"{it['id']}.mp3"
            try:
                d = requests.get(it["url"], timeout=60)
                d.raise_for_status()
                if len(d.content) < 50_000:
                    continue
                dest.write_bytes(d.content)
                (folder / f"{it['id']}.txt").write_text(f"{it.get('title')} — {it.get('creator')} — {it.get('license')} {it.get('license_version') or ''} — {it.get('foreign_landing_url')}", encoding="utf-8")
                log(f"música livre baixada: {it.get('title')} ({it.get('license')})")
                return dest
            except requests.RequestException:
                continue
    except requests.RequestException as e:
        log(f"busca de música online falhou: {e}")
    return random.choice(have) if have else None


def transitions(clips: list[Path], durs: list[float], trans: list[str], out: Path, fps: int, crf: int) -> None:
    """Junta os clipes com xfade sem alterar a duração total (o fim de cada clipe é estendido)."""
    kinds = [XFADE.get(t or "cut") for t in trans[:-1]]
    if not any(kinds):
        media.concat(clips, out, out.parent, audio=False)
        return
    inputs, pre, chain = [], [], ""
    for i, c in enumerate(clips):
        inputs += ["-i", str(c)]
        pad = TRANS_S if i < len(clips) - 1 and kinds[i] else (0.04 if i < len(clips) - 1 else 0)
        pre.append(f"[{i}:v]tpad=stop_mode=clone:stop_duration={pad},settb=AVTB,fps={fps}[p{i}]")
    last, offset = "p0", 0.0
    for i in range(1, len(clips)):
        offset += durs[i - 1]
        k = kinds[i - 1] or "fade"
        d = TRANS_S if kinds[i - 1] else 0.04
        chain += f";[{last}][p{i}]xfade=transition={k}:duration={d}:offset={offset:.3f}[x{i}]"
        last = f"x{i}"
    graph = ";".join(pre) + chain
    media.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", f"[{last}]", "-c:v", "libx264",
               "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-an", str(out)])


def sfx_track(scenes: list[dict], durs: list[float], cache: Path, out: Path, total: float) -> Path | None:
    """Monta uma faixa de efeitos: o efeito pedido na cena entra no início dela; transições ganham whoosh."""
    hits, t = [], 0.0
    for i, sc in enumerate(scenes):
        k = sfx_kind(sc.get("sfx") or "")
        if i == 0 and not k:
            k = "impact"
        if not k and i > 0 and (scenes[i - 1].get("transition") or "cut") != "cut":
            k = "whoosh"
        if k:
            hits.append((max(0.0, t - (0.25 if k == "whoosh" else 0)), make_sfx(k, cache)))
        t += durs[i]
    if not hits:
        return None
    inputs, parts = ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo"], []
    for n, (at, f) in enumerate(hits, 1):
        inputs += ["-i", str(f)]
        ms = int(at * 1000)
        parts.append(f"[{n}:a]volume=0.6,adelay={ms}|{ms}[s{n}]")
    mix = "".join(f"[s{n}]" for n in range(1, len(hits) + 1))
    graph = ";".join(parts) + f";[0:a]{mix}amix=inputs={len(hits) + 1}:duration=first:normalize=0[a]"
    media.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", "[a]", "-ar", "48000", str(out)])
    return out
