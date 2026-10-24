"""Biblioteca automática: transições reais, efeitos sonoros gerados pelo próprio FFmpeg
(sem baixar nada) e música livre buscada online por clima (Openverse, licenças CC0/CC-BY)."""
from __future__ import annotations

import random
import unicodedata
from pathlib import Path

import requests

import media

XFADE = {"fade": "fade", "slideleft": "slideleft", "slideright": "slideright", "zoomin": "zoomin", "circleopen": "circleopen",
         # tipos medidos na referência (Laboratório)
         "flash": "fadewhite", "zoom": "zoomin", "whip": "smoothleft", "glitch": "pixelize", "cut": None}
TRANS_DUR = {"fadewhite": 0.18, "smoothleft": 0.22, "pixelize": 0.2}
TRANS_S = 0.35

# Efeitos sintetizados (expressões lavfi). Nenhum arquivo externo, nenhuma licença envolvida.
SFX = {
    "whoosh": "anoisesrc=d=0.5:c=white:a=0.5,bandpass=f=1400:width_type=o:w=1.5,afade=t=in:d=0.22:curve=exp,afade=t=out:st=0.22:d=0.28:curve=exp,volume=0.7",
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


SFX_QUERY = {"whoosh": "whoosh transition", "impact": "cinematic impact hit", "riser": "riser tension", "click": "click ui", "ding": "ding bell", "boom": "boom explosion"}


def online_sfx(kind: str, cache: Path) -> Path | None:
    """Efeito gravado de verdade (Openverse/Freesound, só CC0) — cacheado no PC. Sem internet, volta para o sintetizado."""
    out = cache / f"real_{kind}.wav"
    if out.exists():
        return out
    try:
        r = requests.get("https://api.openverse.org/v1/audio/", params={"q": SFX_QUERY.get(kind, kind), "license": "cc0", "category": "sound_effect", "page_size": 20}, timeout=12)
        r.raise_for_status()
        items = [i for i in r.json().get("results", []) if i.get("url") and 0.2 <= (i.get("duration") or 0) / 1000 <= 3]
        for it in items[:4]:
            try:
                d = requests.get(it["url"], timeout=30)
                d.raise_for_status()
                raw = cache / f"raw_{kind}{Path(it['url']).suffix[:5] or '.mp3'}"
                raw.write_bytes(d.content)
                media.run(["ffmpeg", "-y", "-i", str(raw), "-t", "2.5", "-af", "loudnorm=I=-16,afade=t=out:st=2.2:d=0.3", "-ar", "48000", "-ac", "2", str(out)])
                (cache / f"real_{kind}.txt").write_text(f"{it.get('title')} — {it.get('creator')} — CC0 — {it.get('foreign_landing_url')}", encoding="utf-8")
                return out
            except (requests.RequestException, media.MediaError):
                continue
    except requests.RequestException:
        pass
    return None


def make_sfx(kind: str, cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    own = next((p for p in (Path(__file__).parent / "sfx").glob(f"{kind}.*")), None) if (Path(__file__).parent / "sfx").exists() else None
    if own:
        return own
    real = online_sfx(kind, cache)
    if real:
        return real
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
        r = requests.get("https://api.openverse.org/v1/audio/", params={"q": MOOD_QUERY.get(mood, mood), "license": "cc0,by,pdm", "category": "music", "page_size": 20}, timeout=12)
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
    m = archive_music(mood, folder, log)
    if m:
        return m
    return random.choice(have) if have else None


ARCHIVE_TAG = {"suspense": "suspense", "epico": "epic", "calmo": "ambient", "alegre": "happy", "triste": "sad"}


def archive_music(mood: str, folder: Path, log=print) -> Path | None:
    """Plano B: Internet Archive, somente Creative Commons que permite uso comercial (sem -nc)."""
    folder.mkdir(parents=True, exist_ok=True)
    try:
        q = f"subject:({ARCHIVE_TAG.get(mood, mood)}) AND (subject:music OR subject:soundtrack OR subject:instrumental) AND NOT collection:librivoxaudio AND mediatype:audio AND licenseurl:*creativecommons* AND NOT licenseurl:*nc*"
        r = requests.get("https://archive.org/advancedsearch.php", params={"q": q, "fl[]": ["identifier", "licenseurl", "title"], "rows": 25, "output": "json"}, timeout=25)
        r.raise_for_status()
        docs = r.json()["response"]["docs"]
        random.shuffle(docs)
        for doc in docs[:5]:
            meta = requests.get(f"https://archive.org/metadata/{doc['identifier']}", timeout=25).json()
            files = [f for f in meta.get("files", []) if f.get("name", "").lower().endswith(".mp3") and 300_000 < int(f.get("size") or 0) < 15_000_000]
            if not files:
                continue
            f = random.choice(files)
            d = requests.get(f"https://archive.org/download/{doc['identifier']}/{requests.utils.quote(f['name'])}", timeout=90)
            d.raise_for_status()
            dest = folder / f"ia_{doc['identifier'][:40]}.mp3"
            dest.write_bytes(d.content)
            (folder / f"{dest.stem}.txt").write_text(f"{doc.get('title')} — {doc.get('licenseurl')} — https://archive.org/details/{doc['identifier']}", encoding="utf-8")
            log(f"música livre baixada: {doc.get('title')} ({doc.get('licenseurl')})")
            return dest
    except (requests.RequestException, KeyError, ValueError) as e:
        log(f"Internet Archive falhou: {e}")
    return None


def transitions(clips: list[Path], durs: list[float], trans: list[str], out: Path, fps: int, crf: int) -> None:
    """Junta os clipes com xfade sem alterar a duração total (o fim de cada clipe é estendido)."""
    kinds = [XFADE.get(t or "cut") for t in trans[:-1]]
    if not any(kinds):
        media.concat(clips, out, out.parent, audio=False)
        return
    inputs, pre, chain = [], [], ""
    for i, c in enumerate(clips):
        inputs += ["-i", str(c)]
        pad = TRANS_DUR.get(kinds[i], TRANS_S) if i < len(clips) - 1 and kinds[i] else (0.04 if i < len(clips) - 1 else 0)
        pre.append(f"[{i}:v]tpad=stop_mode=clone:stop_duration={pad},settb=AVTB,fps={fps}[p{i}]")
    last, offset = "p0", 0.0
    for i in range(1, len(clips)):
        offset += durs[i - 1]
        k = kinds[i - 1] or "fade"
        d = TRANS_DUR.get(kinds[i - 1], TRANS_S) if kinds[i - 1] else 0.04
        chain += f";[{last}][p{i}]xfade=transition={k}:duration={d}:offset={offset:.3f}[x{i}]"
        last = f"x{i}"
    graph = ";".join(pre) + chain
    media.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", f"[{last}]", "-c:v", "libx264",
               "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p", "-an", str(out)])


KIT_KIND = {"whoosh": "whoosh", "impact": "impact", "riser": "riser", "pop": "click", "click": "click", "bass_drop": "boom", "outro": "ding"}


def clone_transitions(kit: list[dict], n: int) -> list[str]:
    """Repete a sequência de transições medida na referência ao longo dos cortes do vídeo novo."""
    seq = [t.get("kind") or "cut" for t in sorted(kit or [], key=lambda t: float(t.get("at_s") or 0))]
    if not seq:
        return ["cut"] * n
    return [seq[i % len(seq)] for i in range(n)]


def kit_hits(kit: list[dict], durs: list[float], ref_s: float | None) -> list[tuple[float, str]]:
    """Mapa de SFX da referência levado para o vídeo novo: tempo proporcional e, se era no corte, cola no corte mais próximo."""
    total = sum(durs)
    ref = float(ref_s or 0) or max([float(k.get("at_s") or 0) for k in kit] + [total])
    cuts, t = [], 0.0
    for d in durs[:-1]:
        t += d
        cuts.append(t)
    hits, last = [], -99.0
    for k in sorted(kit, key=lambda k: float(k.get("at_s") or 0)):
        kind = KIT_KIND.get(k.get("kind") or "", "whoosh")
        at = float(k.get("at_s") or 0) * total / ref
        if k.get("on_cut") and cuts:
            at = min(cuts, key=lambda c: abs(c - at))
            if kind == "whoosh":
                at -= 0.25
        at = max(0.0, min(total - 0.3, at))
        if at - last < 0.6:
            continue
        hits.append((at, kind))
        last = at
    return hits[:40]


def sfx_track(scenes: list[dict], durs: list[float], cache: Path, out: Path, total: float, kit: list[dict] | None = None, ref_s: float | None = None) -> Path | None:
    """SFX pontual (estilo viral): impacto no gancho e no máximo mais 2 efeitos pedidos pelo roteiro, com 8 s de distância. Nada de whoosh em todo corte."""
    hits, t, last = [], 0.0, -99.0
    if kit:
        hits = [(at, make_sfx(k, cache)) for at, k in kit_hits(kit, durs, ref_s)]
    for i, sc in enumerate(scenes if not hits else []):
        k = sfx_kind(sc.get("sfx") or "")
        if i == 0:
            k = k or "impact"
        if k and (i == 0 or (len(hits) < 3 and t - last >= 8)):
            hits.append((max(0.0, t - (0.25 if k == "whoosh" else 0)), make_sfx(k, cache)))
            last = t
        t += durs[i]
    if not hits:
        return None
    inputs, parts = ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=48000:cl=stereo"], []
    for n, (at, f) in enumerate(hits, 1):
        inputs += ["-i", str(f)]
        ms = int(at * 1000)
        parts.append(f"[{n}:a]volume=0.35,adelay={ms}|{ms}[s{n}]")
    mix = "".join(f"[s{n}]" for n in range(1, len(hits) + 1))
    graph = ";".join(parts) + f";[0:a]{mix}amix=inputs={len(hits) + 1}:duration=first:normalize=0[a]"
    media.run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-map", "[a]", "-ar", "48000", str(out)])
    return out
