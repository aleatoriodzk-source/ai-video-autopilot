"""Seleção de imagens por cena: arquivos enviados → Pexels (se houver chave) → IA (se permitido) → fundo neutro."""
from __future__ import annotations

import base64
import json
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
    sc["_checks"] = sc.get("_checks", 0) + 1
    if sc["_checks"] > 4:  # limite de conferências por cena (economiza IA)
        return True
    thumb = path.with_name(path.stem + "_chk.jpg")
    try:
        args = ["ffmpeg", "-y"] + (["-ss", f"{max(1.0, media.duration(path) / 2):.2f}"] if path.suffix == ".mp4" else []) + ["-i", str(path), "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "6", str(thumb)]
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


def archive_search(query: str) -> list[dict]:
    """Internet Archive: fotos e acervos históricos (muitos em domínio público — conferir a página)."""
    r = requests.get("https://archive.org/advancedsearch.php", headers=UA, timeout=30, params={
        "q": f"({query}) AND mediatype:image", "fl[]": ["identifier", "title", "subject", "licenseurl"], "rows": 15, "output": "json"})
    r.raise_for_status()
    out = []
    for d in r.json().get("response", {}).get("docs", []):
        lic = d.get("licenseurl") or ""
        if "publicdomain" not in lic and "creativecommons" not in lic:
            continue  # sem licença clara (ex.: capas de filme) não entra
        i = d["identifier"]
        subj = d.get("subject") or []
        out.append({"id": f"ia:{i}", "url": f"https://archive.org/services/img/{i}", "page": f"https://archive.org/details/{i}", "license": lic,
                    "attribution": "Internet Archive", "text": " ".join([str(d.get("title") or "")] + (subj if isinstance(subj, list) else [str(subj)]))})
    return out


def re_tags(html: str) -> str:
    import re
    return re.sub(r"<[^>]+>", "", html or "").strip()[:120]


SPACE = ("space", "planet", "galaxy", "nasa", "rocket", "moon", "mars", "star", "astronaut", "nebula", "earth orbit", "satellite")
OPEN_SOURCES = {"archive": archive_search, "wikimedia": wikimedia_search, "openverse": openverse_search, "nasa": nasa_search}


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
        return ["wikimedia", "archive", "openverse"]
    return ["openverse", "wikimedia"]


def _best_file(files: list[dict], w: int, h: int) -> dict | None:
    """Menor arquivo MP4 que ainda cubra a resolução do vídeo final (evita downloads enormes)."""
    mp4 = [f for f in files if f.get("file_type") == "video/mp4" and f.get("width") and f.get("height")]
    ok = sorted([f for f in mp4 if f["width"] * f["height"] >= w * h * 0.5], key=lambda f: f["width"] * f["height"])
    return ok[0] if ok else (max(mp4, key=lambda f: f["width"] * f["height"]) if mp4 else None)


POP = ("marvel", "dc ", "dc comics", "hero", "herói", "heroi", "super", "avengers", "vingadores", "spider", "aranha", "batman", "superman", "x-men", "wolverine",
       "deadpool", "iron man", "homem de ferro", "thor", "hulk", "captain", "capitão", "star wars", "disney", "pixar", "anime", "naruto", "dragon ball", "pokemon",
       "game", "jogo", "minecraft", "gta", "fortnite", "filme", "movie", "film", "série", "serie", "netflix", "trailer", "scene", "celebr", "famoso", "futebol",
       "football", "soccer", "nba", "ufc", "messi", "neymar", "ronaldo", "music", "música", "cantor", "rapper", "hollywood", "harry potter", "senhor dos anéis")


def is_pop(q: str, topic: str) -> bool:
    t = f" {q} {topic} ".lower()
    return any(w in t for w in POP)


def _scene_secs(sc: dict) -> float:
    return max(3.0, min(12.0, len((sc.get("narration") or "").split()) / 2.5 + 1.0))


def proper_names(q: str) -> list[str]:
    """Nomes próprios da busca (ex.: 'Homelander', 'Peter Parker'), em minúsculas."""
    import re
    stop = {"the", "a", "o", "os", "as", "de", "da", "do", "cena", "scene", "movie", "filme", "trailer", "série", "series"}
    return [w.lower() for w in re.findall(r"\b[A-ZÁÉÍÓÚÂÊÔÃÕ][\wÀ-ú'-]{2,}", q) if w.lower() not in stop]


def youtube_clip(runner, job, q: str, sc: dict, out: Path, used: set) -> dict | None:
    """Busca no YouTube (trailers/cenas) e baixa só o trecho que a cena precisa."""
    import random
    import subprocess
    from analyzer import _ytdlp
    try:
        data = json.loads(_ytdlp(["--flat-playlist", "-J", f"ytsearch8:{q}"]))
    except Exception as e:
        runner.log(job, f"YouTube busca: {str(e)[:150]}", "warn", "visuals")
        return None
    need = _scene_secs(sc)
    names = proper_names(q)
    for e in data.get("entries") or []:
        vid, dur = e.get("id"), e.get("duration")
        title = (e.get("title") or "").lower()
        # O personagem citado na cena tem que estar no vídeo: título sem o nome dele é descartado.
        if names and not any(nm in title for nm in names):
            continue
        # busca rápida às vezes vem sem duração: não descarta, assume um clipe de ~3 min
        if not vid or vid in used or (dur and (dur < 15 or dur > 3600)):
            continue
        dur = float(dur or 180)
        start = round(random.uniform(dur * 0.12, max(dur * 0.12, dur * 0.75 - need)), 1)
        out.unlink(missing_ok=True)
        try:
            _ytdlp(["-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4",
                    "--download-sections", f"*{start}-{start + need}", "--force-keyframes-at-cuts",
                    "--no-playlist", "-o", str(out), f"https://www.youtube.com/watch?v={vid}"])
        except Exception as ex:
            runner.log(job, f"YouTube download {vid}: {str(ex)[:150]}", "warn", "visuals")
            continue
        if out.exists() and out.stat().st_size > 20000:
            used.add(vid)
            return {"id": f"yt:{vid}:{start}", "page": f"https://www.youtube.com/watch?v={vid}&t={int(start)}", "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or ""}
    return None


def tiktok_clip(runner, job, q: str, sc: dict, out: Path, used: set) -> dict | None:
    """Busca vídeos verticais no TikTok (tikwm, sem marca d'água) e corta só o trecho da cena."""
    import random
    need = _scene_secs(sc)
    try:
        r = requests.post("https://www.tikwm.com/api/feed/search", timeout=30,
                          headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"},
                          data={"keywords": q[:80], "count": 12, "cursor": 0, "HD": 1})
        vids = ((r.json() or {}).get("data") or {}).get("videos") or []
    except Exception as e:
        runner.log(job, f"TikTok busca: {str(e)[:150]}", "warn", "visuals")
        return None
    names = proper_names(q)
    raw = out.with_name(out.stem + "_tt.mp4")
    for v in vids:
        vid, dur = str(v.get("video_id") or v.get("id") or ""), float(v.get("duration") or 0)
        title = (v.get("title") or "").lower()
        if not vid or vid in used or dur < 4 or (names and not any(nm in title for nm in names)):
            continue
        url = v.get("hdplay") or v.get("play")
        if not url:
            continue
        if url.startswith("/"):
            url = "https://www.tikwm.com" + url
        try:
            _download(url, raw)
            start = round(random.uniform(0, max(0.0, dur - need - 0.5)), 1) if dur > need + 1 else 0.0
            media.run(["ffmpeg", "-y", "-ss", f"{start}", "-i", str(raw), "-t", f"{need:.2f}", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(out)])
        except Exception as ex:
            runner.log(job, f"TikTok download {vid}: {str(ex)[:150]}", "warn", "visuals")
            continue
        finally:
            raw.unlink(missing_ok=True)
        if out.exists() and out.stat().st_size > 20000:
            used.add(vid)
            author = (v.get("author") or {}).get("unique_id") or ""
            return {"id": f"tt:{vid}:{start}", "page": f"https://www.tiktok.com/@{author}/video/{vid}", "title": v.get("title") or "", "channel": f"@{author}"}
    return None


def _google_cookies() -> dict:
    """Lê o google.txt (formato Netscape) enviado na aba Contas."""
    from analyzer import COOKIES
    f = COOKIES.get("google")
    out = {}
    if not f or not Path(f).exists():
        return out
    for line in Path(f).read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split("\t")
        if len(parts) >= 7 and "google" in parts[0]:
            out[parts[5]] = parts[6].strip()
    return out


def google_images(q: str) -> list[dict]:
    """Google Imagens com a sua sessão (cookies). Muito melhor para conteúdo brasileiro (novelas, famosos)."""
    import re
    ck = _google_cookies()
    if not ck:
        return []
    h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
         "Accept-Language": "pt-BR,pt;q=0.9"}
    r = requests.get("https://www.google.com/search", params={"q": q, "tbm": "isch", "hl": "pt-BR", "gl": "br", "tbs": "isz:l"}, headers=h, cookies=ck, timeout=30)
    if r.status_code != 200:
        return []
    seen, out = set(), []
    for u in re.findall(r'\["(https?://[^"\\]+?\.(?:jpg|jpeg|png|webp))",(\d+),(\d+)\]', r.text):
        url, hh, ww = u[0], int(u[1]), int(u[2])
        if "gstatic.com" in url or url in seen or ww < 600:
            continue
        seen.add(url)
        out.append({"id": f"web:{url[-80:]}", "url": url.replace("\\u003d", "=").replace("\\u0026", "&"), "page": None, "text": q})
        if len(out) >= 20:
            break
    return out


def web_images(q: str) -> list[dict]:
    """Busca de imagens na web: Google (se tiver cookies), depois DuckDuckGo e Bing."""
    import re
    try:
        g = google_images(q)
        if g:
            return g
    except Exception:
        pass
    h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"}
    r = requests.get("https://duckduckgo.com/", params={"q": q, "iax": "images", "ia": "images"}, headers=h, timeout=30)
    m = re.search(r"vqd=[\"']?([\d-]+)", r.text)
    if m:
        r = requests.get("https://duckduckgo.com/i.js", headers={**h, "Referer": "https://duckduckgo.com/"}, timeout=30,
                         params={"l": "wt-wt", "o": "json", "q": q, "vqd": m.group(1), "f": ",,,,,", "p": "1"})
        if r.status_code == 200 and "results" in r.text:
            res = [{"id": f"web:{x['image'][-80:]}", "url": x["image"], "page": x.get("url"), "text": x.get("title", "")}
                   for x in r.json().get("results", [])[:20] if (x.get("width") or 0) >= 600]
            if res:
                return res
    # Plano B: Bing Imagens.
    import html as _h
    r = requests.get("https://www.bing.com/images/async", params={"q": q, "first": 0, "count": 35, "qft": "+filterui:imagesize-large"}, headers=h, timeout=30)
    out = []
    for raw in re.findall(r'm="(\{.*?\})"', r.text):
        try:
            d = json.loads(_h.unescape(raw))
        except Exception:
            continue
        if d.get("murl"):
            out.append({"id": f"web:{d['murl'][-80:]}", "url": d["murl"], "page": d.get("purl"), "text": d.get("t", "")})
    if not out:
        raise RuntimeError("busca de imagens na web indisponível agora")
    return out[:20]


def scene_frame(sc: dict, prod: dict) -> str:
    """Proporção da cena segundo o DNA (frame_mix); sem DNA alterna vertical/horizontal."""
    ps = prod.get("settings") or {}
    if ps.get("format", "short") == "long":
        return "16:9"
    mix = [f for f in (ps.get("frame_mix") or []) if f in ("9:16", "16:9", "1:1", "3:4")]
    if sc.get("frame"):
        return sc["frame"]
    if mix:
        return mix[sc.get("idx", 0) % len(mix)]
    return ["9:16", "16:9", "9:16", "1:1"][sc.get("idx", 0) % 4]


def _web_pick(runner, job, q, work, sc, prod, recent, window, yt_used):
    """Mídia real do assunto: TikTok/YouTube conforme a proporção da cena, depois imagem da web."""
    video_only = bool((prod.get("settings") or {}).get("video_only")) or is_pop(q, prod.get("topic") or "")
    sources = []
    if runner.cfg.get("tiktok_clips", True):
        sources.append(("tiktok", tiktok_clip))
    if runner.cfg.get("youtube_clips", True):
        sources.append(("youtube", youtube_clip))
    # Cena 9:16 → TikTok/Shorts primeiro (vertical nativo); 16:9, 1:1, 3:4 → YouTube HD primeiro. A outra é plano B.
    if scene_frame(sc, prod) != "9:16":
        sources.reverse()
    vout = work / f"vid_{sc['idx']:03d}.mp4"
    for name, fn in sources:
        for _ in range(2 if video_only else 1):
            c = fn(runner, job, q, sc, vout, yt_used)
            if not c:
                break
            if not vision_ok(runner, job, vout, sc, prod):
                continue
            lic = "Trecho curto do TikTok — uso transformativo/comentário; verifique antes de monetizar" if name == "tiktok" else "Trecho curto do YouTube — uso transformativo/comentário; verifique antes de monetizar"
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "video", "source": name, "source_url": c["page"],
                                  "license": lic, "attribution": f"{c['channel']} — {c['title']}"[:200], "local_path": str(vout), "description": q})["id"]
            return {"id": aid, "key": c["id"]}
    vout.unlink(missing_ok=True)
    if video_only and (sc.get("_vo_try") or 0) < 1:
        # Nicho só de vídeos: tenta mais uma vez com uma busca mais ampla antes de aceitar foto.
        sc["_vo_try"] = 1
        base = " ".join((prod.get("topic") or q).split()[:4])
        return _web_pick(runner, job, f"{base} movie scene", work, sc, prod, recent, window, yt_used)
    out = work / f"img_{sc['idx']:03d}.jpg"
    try:
        tried = 0
        for c in web_images(q):
            if c["id"] in recent[-window * 3:] or tried >= 4:
                continue
            tried += 1
            try:
                _download(c["url"], out)
            except Exception:
                continue
            if not vision_ok(runner, job, out, sc, prod):
                recent.append(c["id"])
                continue
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "web", "source_url": c["page"],
                                  "license": "Imagem da web — direitos do autor original; verifique antes de monetizar", "attribution": (c["text"] or "web")[:200], "local_path": str(out), "description": q})["id"]
            return {"id": aid, "key": c["id"]}
    except Exception as e:
        runner.log(job, f"imagens web: {e}", "warn", "visuals")
    return None


def pick_visuals(runner, job, ctx) -> None:
    s, work, prod = ctx["settings"], ctx["work"], ctx["prod"]
    w, h = ctx["w"], ctx["h"]
    orientation = "portrait" if h > w else "landscape" if w > h else "square"
    key = runner.cfg.get("pexels_api_key")
    pxb = runner.cfg.get("pixabay_api_key")
    window = s["visuals"].get("avoid_repeat_window", 4)
    uploads = [a for a in ctx["assets"] if a["source"] == "upload" and a["kind"] == "image" and a.get("storage_path")]
    recent: list[str] = []
    yt_used: set = set()
    ai_used = 0
    topic = prod.get("topic") or prod.get("title") or ""
    total = len(ctx["scenes"])
    for n_sc, sc in enumerate(ctx["scenes"], 1):
        print(f"[visuals] cena {n_sc} de {total}")
        try:
            runner.update(job, wait_reason=f"Buscando imagens e vídeos: cena {n_sc} de {total}")
        except Exception:
            pass
        out = work / f"img_{sc['idx']:03d}.jpg"
        # Limpa mídias de renderizações anteriores (cenas podem ter sido editadas no site).
        for old in (out, work / f"vid_{sc['idx']:03d}.mp4"):
            old.unlink(missing_ok=True)
        chosen = None
        # Mídia escolhida pelo usuário no editor: usa ela e não busca outra.
        mine = next((a for a in ctx["assets"] if a["id"] == sc.get("asset_id") and a.get("storage_path")), None)
        if mine:
            url = runner.api.call("download_url", path=mine["storage_path"])["url"]
            _download(url, work / f"vid_{sc['idx']:03d}.mp4" if mine["kind"] == "video" else out)
            recent.append(mine["id"])
            runner.log(job, f"cena {sc['idx'] + 1}: usando mídia escolhida por você", step="visuals")
            continue
        q0 = sc.get("visual_query") or sc["narration"][:60]
        if is_pop(q0, topic):
            # Cultura pop / filmes / famosos: bancos de estoque não têm isso — vai direto no YouTube e na web.
            chosen = _web_pick(runner, job, q0, work, sc, prod, recent, window, yt_used)
        for src in ([] if chosen else s["visuals"]["prefer"]):
            if src == "upload" and uploads:
                # Acervo: prefere uma mídia sua que combine com o assunto da cena; se nenhuma combinar, usa outra ainda não usada.
                q_lib = sc.get("visual_query") or sc.get("visual_description") or sc["narration"][:60]
                cands = [u for u in uploads if u["id"] not in recent[-window:]]
                a = next((u for u in cands if relevant(q_lib, " ".join([u.get("description") or "", str((u.get("meta") or {}).get("tags") or "")]))), None) or (cands[0] if cands else None)
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
                for ph in ([] if (prod.get("settings") or {}).get("video_only") else pexels_search(key, q, orientation)):
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
            if src == "pexels" and not chosen and not is_pop(q0, topic):
                chosen = _web_pick(runner, job, q0, work, sc, prod, recent, window, yt_used)
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
