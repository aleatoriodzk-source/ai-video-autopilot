"""Seleção de imagens por cena: arquivos enviados → Pexels (se houver chave) → IA (se permitido) → fundo neutro."""
from __future__ import annotations

import base64
from pathlib import Path

import requests

import media


def _download(url: str, out: Path) -> None:
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    out.write_bytes(r.content)


def pexels_search(key: str, query: str, orientation: str) -> list[dict]:
    r = requests.get("https://api.pexels.com/v1/search", headers={"Authorization": key},
                     params={"query": query, "orientation": orientation, "per_page": 15}, timeout=30)
    if r.status_code == 429:
        raise RuntimeError("Pexels: limite de requisições atingido, tentando depois")
    r.raise_for_status()
    return r.json().get("photos", [])


def pexels_videos(key: str, query: str, orientation: str) -> list[dict]:
    r = requests.get("https://api.pexels.com/videos/search", headers={"Authorization": key},
                     params={"query": query, "orientation": orientation, "per_page": 10, "size": "medium"}, timeout=30)
    if r.status_code == 429:
        raise RuntimeError("limite de requisições atingido")
    r.raise_for_status()
    return r.json().get("videos", [])


def pixabay_videos(key: str, query: str) -> list[dict]:
    r = requests.get("https://pixabay.com/api/videos/", params={"key": key, "q": query[:100], "per_page": 10, "safesearch": "true"}, timeout=30)
    r.raise_for_status()
    return r.json().get("hits", [])


def pixabay_images(key: str, query: str, orientation: str) -> list[dict]:
    o = "vertical" if orientation == "portrait" else "horizontal" if orientation == "landscape" else "all"
    r = requests.get("https://pixabay.com/api/", params={"key": key, "q": query[:100], "orientation": o, "image_type": "photo", "per_page": 15, "safesearch": "true"}, timeout=30)
    r.raise_for_status()
    return r.json().get("hits", [])


def _pixabay(runner, job, key, q, orientation, w, h, work, sc, prod, recent, window):
    lic = "Pixabay Content License (uso gratuito, atribuição opcional)"
    try:
        for v in pixabay_videos(key, q):
            pid = f"pixabayv:{v['id']}"
            if pid in recent[-window * 3:]:
                continue
            vs = v.get("videos", {})
            f = next((vs[k] for k in ("medium", "large", "small") if vs.get(k, {}).get("url")), None)
            if not f:
                continue
            vout = work / f"vid_{sc['idx']:03d}.mp4"
            _download(f["url"], vout)
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "video", "source": "pixabay", "source_url": v.get("pageURL"), "license": lic, "attribution": f"Vídeo de {v.get('user', '')} no Pixabay", "local_path": str(vout), "description": q})["id"]
            return {"id": aid, "key": pid}
    except Exception as e:
        runner.log(job, f"Pixabay vídeos: {e}", "warn", "visuals")
    try:
        out = work / f"img_{sc['idx']:03d}.jpg"
        for ph in pixabay_images(key, q, orientation):
            pid = f"pixabay:{ph['id']}"
            if pid in recent[-window * 3:]:
                continue
            _download(ph.get("largeImageURL") or ph["webformatURL"], out)
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "pixabay", "source_url": ph.get("pageURL"), "license": lic, "attribution": f"Foto de {ph.get('user', '')} no Pixabay", "local_path": str(out), "description": q})["id"]
            return {"id": aid, "key": pid}
    except Exception as e:
        runner.log(job, f"Pixabay fotos: {e}", "warn", "visuals")
    return None


def _best_file(files: list[dict], w: int, h: int) -> dict | None:
    """Menor arquivo MP4 que ainda cubra a resolução do vídeo final (evita downloads enormes)."""
    mp4 = [f for f in files if f.get("file_type") == "video/mp4" and f.get("width") and f.get("height")]
    ok = sorted([f for f in mp4 if f["width"] * f["height"] >= w * h * 0.5], key=lambda f: f["width"] * f["height"])
    return ok[0] if ok else (max(mp4, key=lambda f: f["width"] * f["height"]) if mp4 else None)


def pick_visuals(runner, job, ctx) -> None:
    s, work, prod = ctx["settings"], ctx["work"], ctx["prod"]
    w, h = ctx["w"], ctx["h"]
    orientation = "portrait" if h > w else "landscape" if w > h else "square"
    key = runner.cfg.get("pexels_api_key")
    pxb = runner.cfg.get("pixabay_api_key")
    window = s["visuals"].get("avoid_repeat_window", 4)
    uploads = [a for a in ctx["assets"] if a["source"] == "upload" and a["kind"] == "image" and a.get("storage_path")]
    recent: list[str] = []
    ai_used = 0
    for sc in ctx["scenes"]:
        out = work / f"img_{sc['idx']:03d}.jpg"
        # Limpa mídias de renderizações anteriores (cenas podem ter sido editadas no site).
        for old in (out, work / f"vid_{sc['idx']:03d}.mp4"):
            old.unlink(missing_ok=True)
        chosen = None
        for src in s["visuals"]["prefer"]:
            if src == "upload" and uploads:
                a = next((u for u in uploads if u["id"] not in recent[-window:]), None)
                if a:
                    url = runner.api.call("download_url", path=a["storage_path"])["url"]
                    _download(url, out)
                    chosen = {"id": a["id"]}
            elif src == "pexels" and key:
                q = sc.get("visual_query") or sc["narration"][:60]
                try:
                    vids = pexels_videos(key, q, orientation)
                except Exception as e:
                    vids = []
                    runner.log(job, f"Pexels vídeos: {e}", "warn", "visuals")
                for v in vids:
                    pid = f"pexelsv:{v['id']}"
                    f = _best_file(v.get("video_files", []), w, h)
                    if pid in recent[-window * 3:] or not f:
                        continue
                    vout = work / f"vid_{sc['idx']:03d}.mp4"
                    _download(f["link"], vout)
                    aid = runner.api.call("create_asset", asset={
                        "production_id": prod["id"], "kind": "video", "source": "pexels", "source_url": v["url"],
                        "license": "Pexels License (uso gratuito, atribuição opcional)", "attribution": f"Vídeo de {v['user']['name']} no Pexels",
                        "local_path": str(vout), "description": q})["id"]
                    chosen = {"id": aid, "key": pid}
                    break
                if chosen:
                    break
                for ph in pexels_search(key, q, orientation):
                    pid = f"pexels:{ph['id']}"
                    if pid in recent[-window * 3:]:
                        continue
                    _download(ph["src"]["large2x"], out)
                    aid = runner.api.call("create_asset", asset={
                        "production_id": prod["id"], "kind": "image", "source": "pexels", "source_url": ph["url"],
                        "license": "Pexels License (uso gratuito, atribuição opcional)", "attribution": f"Foto de {ph['photographer']} no Pexels",
                        "local_path": str(out), "description": q})["id"]
                    chosen = {"id": aid, "key": pid}
                    break
            if src == "pexels" and not chosen and pxb:
                q = sc.get("visual_query") or sc["narration"][:60]
                chosen = _pixabay(runner, job, pxb, q, orientation, w, h, work, sc, prod, recent, window)
            elif src == "ai_image" and s["ai"]["allow_ai_images"]:
                aspect = prod["aspect"]
                r = runner.api.call("ai_image", job_id=job["id"], prompt=sc.get("visual_description") or sc["narration"], aspect=aspect, used=ai_used)
                if r.get("b64"):
                    out.write_bytes(base64.b64decode(r["b64"]))
                    ai_used += 1
                    aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "ai_image", "license": "Gerada por IA", "local_path": str(out), "description": sc.get("visual_description")})["id"]
                    chosen = {"id": aid}
            if chosen:
                break
        if not chosen:
            media.text_card(sc.get("caption") or "", w, h, out.with_suffix(".png"))
            out.with_suffix(".png").replace(out)
            runner.log(job, f"cena {sc['idx'] + 1}: nenhuma fonte de imagem disponível — usado fundo neutro. Configure a chave Pexels ou envie imagens.", "warn", "visuals")
            continue
        recent.append(chosen.get("key") or chosen["id"])
        runner.api.call("update_scene", scene_id=sc["id"], fields={"asset_id": chosen["id"], "status": "visual_ok"})
        sc["asset_id"] = chosen["id"]
