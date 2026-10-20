"""Coleta de referências com yt-dlp + FFmpeg (cortes de cena e quadros-chave). Só dados reais; nada inventado."""
from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path

import media


UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
BASE = ["--user-agent", UA, "--extractor-args", "youtube:player_client=android,web"]


def _ytdlp(args: list[str]) -> str:
    p = subprocess.run(["yt-dlp", *BASE, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
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


def _analyze_file(vid: Path, title: str, out: dict, imgs: list[str], work: Path, log) -> list[str]:
    dur = media.duration(vid)
    cuts = scene_cuts(vid)
    out["videos"].append({"title": title, "duration_s": dur, "view_count": None, "description": "",
                          "scene_cuts_s": cuts, "avg_scene_s": round(dur / (len(cuts) + 1), 2), "subtitles_available": False,
                          "source": "upload"})
    log(f"'{title}': {len(cuts)} cortes detectados em {dur:.0f}s")
    if not imgs:
        pts = ([0.5] + cuts)[:10] if cuts else [dur * i / 8 for i in range(8)]
        imgs = frames(vid, pts, work)
    return imgs


def collect_reference(urls: list[str], kind: str, work: Path, log, resolve=None) -> tuple[dict, list[str]]:
    """urls podem ser links (YouTube/TikTok) ou 'storage:<caminho>' de vídeos enviados pelo site."""
    work.mkdir(parents=True, exist_ok=True)
    out: dict = {"urls": urls, "videos": []}
    imgs: list[str] = []
    for url in urls[:3]:
        if url.startswith("storage:"):
            if not resolve:
                raise RuntimeError("vídeo enviado sem acesso ao site")
            import requests
            vid = work / f"up{len(out['videos'])}.mp4"
            log("baixando vídeo enviado pelo site")
            with requests.get(resolve(url[len("storage:"):]), stream=True, timeout=600) as r:
                r.raise_for_status()
                with open(vid, "wb") as fh:
                    for c in r.iter_content(1 << 20):
                        fh.write(c)
            name = Path(url).stem
            out["title"] = out.get("title") or name
            imgs = _analyze_file(vid, name, out, imgs, work, log)
            continue
        if kind == "channel":
            meta = json.loads(_ytdlp(["-J", "--flat-playlist", "--playlist-end", "30", url]))
            out["title"] = meta.get("title") or meta.get("uploader")
            out["entries"] = [{k: e.get(k) for k in ("title", "duration", "view_count", "url")} for e in meta.get("entries") or []]
            log(f"{len(out['entries'])} vídeos listados")
            targets = pick_targets(out["entries"])
            log(f"comparando {len(targets)} vídeos (mais e menos vistos)")
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
            per = 10 if len(targets) == 1 else 3
            if len(imgs) < 10:
                pts = (([0.5] + cuts) if cuts else [dur * i / 8 for i in range(8)])[:per]
                sub = work / f"f{len(out['videos'])}"
                sub.mkdir(exist_ok=True)
                imgs += frames(vid, pts, sub)[: 10 - len(imgs)]
    if len(out["videos"]) > 1:
        vs = out["videos"]
        out["channel_stats"] = {
            "videos_analisados": len(vs),
            "duracao_media_s": round(sum(v["duration_s"] for v in vs) / len(vs), 1),
            "cena_media_s": round(sum(v["avg_scene_s"] for v in vs) / len(vs), 2),
            "views": [v.get("view_count") for v in vs],
        }
    return out, imgs


def pick_targets(entries: list[dict], n: int = 5) -> list[str]:
    """Os 3 mais vistos + 2 menos vistos (ou os mais recentes se não houver views)."""
    ok = [e for e in entries if e.get("url")]
    if not any(e.get("view_count") for e in ok):
        return [e["url"] for e in ok[:n]]
    ranked = sorted(ok, key=lambda e: e.get("view_count") or 0, reverse=True)
    chosen = ranked[:3] + [e for e in ranked[-2:] if e not in ranked[:3]]
    return [e["url"] for e in chosen[:n]]
