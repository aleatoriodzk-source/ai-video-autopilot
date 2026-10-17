"""Coleta de referências com yt-dlp + FFmpeg (cortes de cena e quadros-chave). Só dados reais; nada inventado."""
from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path

import media


def _ytdlp(args: list[str]) -> str:
    p = subprocess.run(["yt-dlp", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError("yt-dlp: " + p.stderr[-800:])
    return p.stdout


def scene_cuts(video: Path, threshold: float = 0.3) -> list[float]:
    p = subprocess.run(["ffmpeg", "-i", str(video), "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return [round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", p.stderr)]


def frames(video: Path, times: list[float], out_dir: Path) -> list[str]:
    res = []
    for i, t in enumerate(times[:10]):
        f = out_dir / f"frame_{i}.jpg"
        media.run(["ffmpeg", "-y", "-ss", str(t), "-i", str(video), "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", str(f)])
        res.append("data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode())
    return res


def collect_reference(urls: list[str], kind: str, work: Path, log) -> tuple[dict, list[str]]:
    work.mkdir(parents=True, exist_ok=True)
    out: dict = {"urls": urls, "videos": []}
    imgs: list[str] = []
    for url in urls[:3]:
        if kind == "channel":
            meta = json.loads(_ytdlp(["-J", "--flat-playlist", "--playlist-end", "30", url]))
            out["title"] = meta.get("title") or meta.get("uploader")
            out["entries"] = [{k: e.get(k) for k in ("title", "duration", "view_count", "url")} for e in meta.get("entries") or []]
            log(f"{len(out['entries'])} vídeos listados")
            targets = [e["url"] for e in out["entries"][:2] if e.get("url")]
        else:
            targets = [url]
        for t in targets:
            vid = work / f"v{len(out['videos'])}.mp4"
            meta = json.loads(_ytdlp(["-J", "--no-playlist", t]))
            _ytdlp(["-f", "mp4[height<=720]/best[height<=720]/best", "-o", str(vid), "--no-playlist", "--force-overwrites", t])
            dur = media.duration(vid)
            cuts = scene_cuts(vid)
            out["title"] = out.get("title") or meta.get("title")
            out["videos"].append({
                "title": meta.get("title"), "duration_s": dur, "view_count": meta.get("view_count"),
                "description": (meta.get("description") or "")[:1500], "scene_cuts_s": cuts,
                "avg_scene_s": round(dur / (len(cuts) + 1), 2), "subtitles_available": bool(meta.get("subtitles") or meta.get("automatic_captions")),
            })
            log(f"'{meta.get('title')}': {len(cuts)} cortes detectados em {dur:.0f}s")
            if not imgs:
                pts = ([0.5] + cuts)[:10] if cuts else [dur * i / 8 for i in range(8)]
                imgs = frames(vid, pts, work)
    return out, imgs
