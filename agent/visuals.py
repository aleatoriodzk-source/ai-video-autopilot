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


def vision_ok(runner, job, path: Path, sc: dict, prod: dict) -> bool:
    """Pede para a IA olhar a mídia baixada e confirmar se mostra o assunto da cena. Se a conferência falhar, aceita (não trava o vídeo)."""
    if not runner.cfg.get("check_images", True):
        return True
    thumb = path.with_name(path.stem + "_chk.jpg")
    try:
        args = ["ffmpeg", "-y"] + (["-ss", "1"] if path.suffix == ".mp4" else []) + ["-i", str(path), "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "6", str(thumb)]
        media.run(args)
        img = "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode()
        r = runner.api.call("check_image", job_id=job["id"], image=img, description=sc.get("visual_description") or sc.get("visual_query") or sc["narration"][:200], topic=prod.get("topic") or prod.get("title") or "")
    except Exception as e:
        runner.log(job, f"conferência de imagem indisponível ({str(e)[:120]}); usando a mídia mesmo assim", "warn", "visuals")
        return True
    finally:
        thumb.unlink(missing_ok=True)
    if not r.get("match"):
        runner.log(job, f"cena {sc['idx'] + 1}: mídia recusada pela IA — {r.get('reason', '')[:150]}", "info", "visuals")
    return bool(r.get("match"))


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
            if pid in recent[-window * 3:] or not relevant(q, v.get("tags", "")):
                continue
            vs = v.get("videos", {})
            f = next((vs[k] for k in ("medium", "large", "small") if vs.get(k, {}).get("url")), None)
            if not f:
                continue
            vout = work / f"vid_{sc['idx']:03d}.mp4"
            _download(f["url"], vout)
            if not vision_ok(runner, job, vout, sc, prod):
                recent.append(pid)
                continue
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "video", "source": "pixabay", "source_url": v.get("pageURL"), "license": lic, "attribution": f"Vídeo de {v.get('user', '')} no Pixabay", "local_path": str(vout), "description": q})["id"]
            return {"id": aid, "key": pid}
    except Exception as e:
        runner.log(job, f"Pixabay vídeos: {e}", "warn", "visuals")
    try:
        out = work / f"img_{sc['idx']:03d}.jpg"
        for ph in pixabay_images(key, q, orientation):
            pid = f"pixabay:{ph['id']}"
            if pid in recent[-window * 3:] or not relevant(q, ph.get("tags", "")):
                continue
            _download(ph.get("largeImageURL") or ph["webformatURL"], out)
            if not vision_ok(runner, job, out, sc, prod):
                recent.append(pid)
                continue
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "pixabay", "source_url": ph.get("pageURL"), "license": lic, "attribution": f"Foto de {ph.get('user', '')} no Pixabay", "local_path": str(out), "description": q})["id"]
            return {"id": aid, "key": pid}
    except Exception as e:
        runner.log(job, f"Pixabay fotos: {e}", "warn", "visuals")
    return None


STOP = {"a", "an", "the", "of", "in", "on", "with", "and", "close", "up", "closeup", "shot", "view", "slow", "motion"}


def relevant(query: str, text: str) -> bool:
    """O assunto principal (primeira palavra útil da busca) precisa aparecer nas etiquetas da mídia — evita pessoas/outros bichos."""
    words = [w for w in query.lower().split() if w not in STOP and len(w) > 2]
    if not words:
        return True
    t = (text or "").lower()
    return words[0].rstrip("s") in t


UA = {"User-Agent": "EstudioAutomatico/0.4 (agente local; contato pelo painel)"}


def wikimedia_search(query: str) -> list[dict]:
    """Wikimedia Commons: fotos históricas, mapas, documentos (domínio público / CC). Sem chave."""
    r = requests.get("https://commons.wikimedia.org/w/api.php", headers=UA, timeout=30, params={
        "action": "query", "format": "json", "generator": "search", "gsrsearch": f"{query} filetype:bitmap",
        "gsrnamespace": 6, "gsrlimit": 15, "prop": "imageinfo", "iiprop": "url|extmetadata|size", "iiurlwidth": 1920})
    r.raise_for_status()
    out = []
    for pg in (r.json().get("query", {}).get("pages", {}) or {}).values():
        ii = (pg.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata", {})
        if not ii.get("thumburl") or (ii.get("width") or 0) < 640:
            continue
        lic = (meta.get("LicenseShortName", {}) or {}).get("value", "ver página")
        artist = re_tags((meta.get("Artist", {}) or {}).get("value", ""))
        out.append({"id": f"wiki:{pg['pageid']}", "url": ii["thumburl"], "page": ii.get("descriptionurl"), "license": f"Wikimedia Commons — {lic}", "attribution": f"{artist or 'autor na página'} / Wikimedia Commons", "text": pg.get("title", "")})
    return out


def openverse_search(query: str) -> list[dict]:
    """Openverse: milhões de imagens Creative Commons. Sem chave (limite baixo por minuto)."""
    r = requests.get("https://api.openverse.org/v1/images/", headers=UA, timeout=30, params={"q": query, "page_size": 15, "mature": "false"})
    r.raise_for_status()
    return [{"id": f"ov:{h['id']}", "url": h["url"], "page": h.get("foreign_landing_url"), "license": f"{(h.get('license') or '').upper()} {h.get('license_version') or ''} (Openverse)",
             "attribution": f"{h.get('creator') or 'autor'} — {h.get('provider') or ''}", "text": " ".join([h.get("title") or ""] + [t.get("name", "") for t in h.get("tags") or []])}
            for h in r.json().get("results", []) if (h.get("width") or 0) >= 640]


def nasa_search(query: str) -> list[dict]:
    """NASA Image Library: espaço, astronomia, foguetes. Domínio público."""
    r = requests.get("https://images-api.nasa.gov/search", headers=UA, timeout=30, params={"q": query, "media_type": "image"})
    r.raise_for_status()
    out = []
    for it in r.json().get("collection", {}).get("items", [])[:15]:
        d = (it.get("data") or [{}])[0]
        link = next((l["href"] for l in it.get("links") or [] if l.get("rel") == "preview"), None)
        if link:
            out.append({"id": f"nasa:{d.get('nasa_id')}", "url": link.replace("~thumb", "~large"), "page": f"https://images.nasa.gov/details/{d.get('nasa_id')}", "license": "NASA (domínio público)", "attribution": f"NASA — {d.get('center') or ''}", "text": " ".join([d.get("title") or ""] + (d.get("keywords") or []))})
    return out


def re_tags(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", html or "").strip()[:120]


SPACE = ("space", "planet", "galaxy", "nasa", "rocket", "moon", "mars", "star", "astronaut", "nebula", "earth orbit", "satellite")
OPEN_SOURCES = {"wikimedia": wikimedia_search, "openverse": openverse_search, "nasa": nasa_search}


def _open_pick(runner, job, q, work, sc, prod, recent, window, order):
    out = work / f"img_{sc['idx']:03d}.jpg"
    for name in order:
        if name == "nasa" and not any(w in q.lower() for w in SPACE):
            continue
        try:
            for c in OPEN_SOURCES[name](q):
                if c["id"] in recent[-window * 3:] or not relevant(q, c["text"]):
                    continue
                try:
                    _download(c["url"], out)
                except Exception:
                    continue
                if not vision_ok(runner, job, out, sc, prod):
                    recent.append(c["id"])
                    continue
                aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": name, "source_url": c["page"], "license": c["license"], "attribution": c["attribution"], "local_path": str(out), "description": q})["id"]
                return {"id": aid, "key": c["id"]}
        except Exception as e:
            runner.log(job, f"{name}: {e}", "warn", "visuals")
    return None


HISTORY = ("war", "ww2", "wwii", "world war", "soldier", "nazi", "hitler", "battle", "ancient", "medieval", "empire", "historic", "history", "18", "19", "king", "queen", "revolution", "map")


def open_order(q: str, topic: str) -> list[str]:
    """Para temas históricos, acervos (Wikimedia) vêm antes; para o resto, Openverse."""
    t = f"{q} {topic}".lower()
    if any(w in t for w in SPACE):
        return ["nasa", "wikimedia", "openverse"]
    if any(w in t for w in HISTORY):
        return ["wikimedia", "openverse"]
    return ["openverse", "wikimedia"]


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
                    if not vision_ok(runner, job, vout, sc, prod):
                        recent.append(pid)
                        continue
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
                    if not vision_ok(runner, job, out, sc, prod):
                        recent.append(pid)
                        continue
                    aid = runner.api.call("create_asset", asset={
                        "production_id": prod["id"], "kind": "image", "source": "pexels", "source_url": ph["url"],
                        "license": "Pexels License (uso gratuito, atribuição opcional)", "attribution": f"Foto de {ph['photographer']} no Pexels",
                        "local_path": str(out), "description": q})["id"]
                    chosen = {"id": aid, "key": pid}
                    break
            if src == "pexels" and not chosen and pxb:
                q = sc.get("visual_query") or sc["narration"][:60]
                chosen = _pixabay(runner, job, pxb, q, orientation, w, h, work, sc, prod, recent, window)
            if src == "pexels" and not chosen:
                q = sc.get("visual_query") or sc["narration"][:60]
                chosen = _open_pick(runner, job, q, work, sc, prod, recent, window, open_order(q, prod.get("topic") or ""))
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
