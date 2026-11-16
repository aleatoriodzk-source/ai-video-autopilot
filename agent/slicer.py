"""Modo fatiador: usa as cenas do vídeo base (sua referência) para montar o seu roteiro.

1. baixa o vídeo base uma vez (fica em cache)
2. detecta cada tomada (corte) com FFmpeg
3. a IA olha um quadro de cada tomada e escolhe a melhor para cada fala do roteiro
4. corta só o trecho necessário de cada tomada (sem baixar mais nada)
"""
from __future__ import annotations

import base64
from pathlib import Path

import media
from analyzer import fetch_video, scene_cuts, transcript


def _shots(dur: float, cuts: list[float], min_len: float = 0.5, max_n: int = 50) -> list[tuple[float, float]]:
    pts = [0.0] + [c for c in cuts if 0 < c < dur] + [dur]
    shots = []
    for a, b in zip(pts, pts[1:]):
        if shots and b - a < min_len:
            shots[-1] = (shots[-1][0], b)
        elif b - a >= 0.2:
            shots.append((a, b))
    if len(shots) > max_n:
        step = len(shots) / max_n
        shots = [shots[int(i * step)] for i in range(max_n)]
    return shots


def slice_from_reference(runner, job, ctx, ref: dict) -> bool:
    work = ctx["work"]
    urls = ref.get("urls") or []
    if not urls:
        return False
    cache = Path(runner.cfg.get("cache_dir") or Path(__file__).resolve().parent / "cache") / "base"
    log = lambda m: runner.log(job, m, step="visuals")
    log("modo fatiador: usando as cenas do vídeo base")
    base = fetch_video(urls[0], cache / f"{ref['id']}.mp4", resolve=lambda p: runner.api.call("download_url", path=p)["url"])
    dur = media.duration(base)
    shots = _shots(dur, scene_cuts(base))
    log(f"{len(shots)} tomadas encontradas em {dur:.0f}s de vídeo base")
    frames = []
    fdir = work / "shots"
    fdir.mkdir(exist_ok=True)
    for i, (a, b) in enumerate(shots):
        for k, pos in enumerate((0.3, 0.75)):  # 2 quadros por tomada: a IA vê o movimento, não uma foto só
            f = fdir / f"s{i:02d}_{k}.jpg"
            media.run(["ffmpeg", "-y", "-ss", f"{a + (b - a) * pos:.2f}", "-i", str(base), "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "6", str(f)])
            frames.append("data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode())
    notes = [""] * len(shots)
    if str(urls[0]).startswith("http"):
        try:
            for line in transcript(urls[0], work):
                for i, (a, b) in enumerate(shots):
                    if a - 0.3 <= line["t"] < b and len(notes[i]) < 600:
                        notes[i] = (notes[i] + " " + line["text"]).strip()
                        break
            if any(notes):
                log(f"narração original lida em {sum(1 for n in notes if n)} tomadas")
        except Exception as err:
            log(f"sem transcrição do vídeo base ({err})")
    scenes = ctx["scenes"]
    runner.update(job, status="waiting_api", wait_reason="IA assistindo as tomadas do vídeo base")
    match = runner.api.call("ai_match_shots", job_id=job["id"], frames=frames,
                            scenes=[(((sc.get("visual_query") or "") + " — " + sc["narration"])[:1500]) for sc in scenes],
                            notes=[n[:1500] for n in notes])["match"]
    band = match.get("text_band") or {}
    blur = ""
    keep = ((ctx["prod"].get("settings") or {}).get("base_captions") or "hide") == "keep"
    if band.get("has") and not keep:
        y0 = max(0.0, min(0.95, float(band.get("y0") or 0) - 0.02))
        y1 = max(y0 + 0.04, min(1.0, float(band.get("y1") or 0) + 0.02))
        blur = (f"split[a][b];[b]crop=iw:ih*{y1 - y0:.3f}:0:ih*{y0:.3f},boxblur=10:4[t];"
                f"[a][t]overlay=0:H*{y0:.3f}")
        log(f"escondendo a legenda do vídeo base (faixa {y0:.0%}–{y1:.0%} da altura)")
    for s in (match.get("shots") or [])[:60]:
        if 0 <= s.get("i", -1) < len(shots):
            log(f"tomada {s['i']}: {s.get('who', '')} — {s.get('what', '')} (energia {s.get('energy')})")
    runner.update(job, status="running", wait_reason=None)
    picks = match.get("pick") or []
    recent: list[int] = []
    for n, sc in enumerate(scenes):
        need = float(sc.get("duration_s") or 2.0)
        # A escolha da IA manda: só evita repetir a tomada anterior se a IA deu outra opção.
        ai = [i for i in (picks[n] if n < len(picks) else []) if 0 <= i < len(shots)]
        if ai:
            idx = next((i for i in ai if not recent or i != recent[-1]), ai[0])
        else:
            rest = [i for i in range(len(shots)) if i not in recent[-6:]] or list(range(len(shots)))
            idx = rest[0]
        recent.append(idx)
        a, b = shots[idx]
        start = a + 0.05
        if b - a > need + 0.3:
            start = a + min(0.3, (b - a - need) / 2)
        start = max(0.0, min(start, dur - need - 0.05))
        out = work / f"vid_{sc['idx']:03d}.mp4"
        short = (b - a) < need
        if short:  # tomada mais curta que a fala: repete só essa tomada (não invade a próxima cena)
            start = a + 0.05
        src = ["-ss", f"{start:.3f}", "-i", str(base)] if short else ["-ss", f"{start:.3f}", "-i", str(base)]
        media.run(["ffmpeg", "-y", *src, "-t", f"{need + 0.2:.3f}", "-an", *(["-vf", blur] if blur else []),
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out)])
        runner.log(job, f"cena {sc['idx'] + 1}: tomada {idx} ({start:.1f}s do vídeo base)", step="visuals")
    return True
