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
from analyzer import fetch_video, scene_cuts


def _shots(dur: float, cuts: list[float], min_len: float = 0.5, max_n: int = 40) -> list[tuple[float, float]]:
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
    shots = _shots(dur, scene_cuts(base, 0.27))
    log(f"{len(shots)} tomadas encontradas em {dur:.0f}s de vídeo base")
    frames = []
    fdir = work / "shots"
    fdir.mkdir(exist_ok=True)
    for i, (a, b) in enumerate(shots):
        f = fdir / f"s{i:02d}.jpg"
        media.run(["ffmpeg", "-y", "-ss", f"{(a + b) / 2:.2f}", "-i", str(base), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", str(f)])
        frames.append("data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode())
    scenes = ctx["scenes"]
    runner.update(job, status="waiting_api", wait_reason="IA assistindo as tomadas do vídeo base")
    match = runner.api.call("ai_match_shots", job_id=job["id"], frames=frames,
                            scenes=[(sc.get("visual_query") or "") + " — " + sc["narration"][:300] for sc in scenes])["match"]
    for s in (match.get("shots") or [])[:60]:
        if 0 <= s.get("i", -1) < len(shots):
            log(f"tomada {s['i']}: {s.get('who', '')} — {s.get('what', '')} (energia {s.get('energy')})")
    runner.update(job, status="running", wait_reason=None)
    picks = match.get("pick") or []
    recent: list[int] = []
    for n, sc in enumerate(scenes):
        need = float(sc.get("duration_s") or 2.0)
        cand = [i for i in (picks[n] if n < len(picks) else []) if 0 <= i < len(shots)]
        cand += [i for i in range(len(shots)) if i not in cand]
        idx = next((i for i in cand if i not in recent[-6:]), cand[0])
        recent.append(idx)
        a, b = shots[idx]
        start = a + 0.05
        if b - a > need + 0.3:
            start = a + min(0.3, (b - a - need) / 2)
        start = max(0.0, min(start, dur - need - 0.05))
        out = work / f"vid_{sc['idx']:03d}.mp4"
        media.run(["ffmpeg", "-y", "-ss", f"{start:.3f}", "-i", str(base), "-t", f"{need + 0.2:.3f}", "-an",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out)])
        runner.log(job, f"cena {sc['idx'] + 1}: tomada {idx} ({start:.1f}s do vídeo base)", step="visuals")
    return True
