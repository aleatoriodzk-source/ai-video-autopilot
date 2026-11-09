"""Seleção de imagens por cena: arquivos enviados → Pexels (se houver chave) → IA (se permitido) → fundo neutro."""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import requests

import media


def _download(url: str, out: Path) -> None:
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    out.write_bytes(r.content)


def local_frames(path: Path, n: int = 4):
    """Lê n quadros espalhados pelo clipe (pula vinheta inicial/final). None se não der para ler."""
    try:
        import cv2
        cap = cv2.VideoCapture(str(path))
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        out = []
        pts = [0.15 + 0.7 * i / max(1, n - 1) for i in range(n)] if total > 1 else [0]
        for p in pts:
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * p))
            ok, fr = cap.read()
            if ok:
                out.append(fr)
        cap.release()
        return out or None
    except Exception:
        return None


def vision_ok(runner, job, path: Path, sc: dict, prod: dict) -> bool:
    """Pede para a IA olhar a mídia baixada e confirmar se mostra o assunto da cena. Se a conferência falhar, aceita (não trava o vídeo)."""
    if not runner.cfg.get("check_images", True):
        return True
    sc["_checks"] = sc.get("_checks", 0) + 1
    if sc["_checks"] > 1:  # 1 checagem só; depois aceita (fim da recusa em loop)  # limite por cena (economiza IA); com personagem citado insiste mais
        return True
    thumb = path.with_name(path.stem + "_chk.jpg")
    try:
        # V3: assiste o clipe em 4 momentos (não 1 print congelado) e monta um mosaico 2x2.
        frames = local_frames(path, 4)
        if frames is not None and path.suffix == ".mp4":
            if max(f.mean() for f in frames) < 18:
                runner.log(job, f"cena {sc['idx'] + 1}: clipe escuro/tela preta — descartado localmente", "info", "visuals")
                return False
        if frames:
            import cv2, numpy as np
            fs = [cv2.resize(f, (256, 144)) for f in (frames + frames * 3)[:4]]
            cv2.imwrite(str(thumb), np.vstack([np.hstack(fs[:2]), np.hstack(fs[2:])]), [cv2.IMWRITE_JPEG_QUALITY, 70])
        else:
            media.run(["ffmpeg", "-y", "-i", str(path), "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "6", str(thumb)])
        img = "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode()
        q = sc.get("visual_query") or ""
        desc = (f"{sc.get('visual_description') or q} | narração: {(sc.get('narration') or '')[:200]}"
                " | A imagem é um mosaico de 4 momentos do mesmo clipe: aprove se o assunto aparece em QUALQUER um deles.")
        r = runner.api.call("check_image", job_id=job["id"], image=img, description=desc, topic=prod.get("topic") or prod.get("title") or "",
                            characters=", ".join(dict.fromkeys(proper_names(q))))
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
    # Nome próprio (pessoa/programa/filme): bancos abertos só trazem animais e paisagens.
    if re.search(r"\b[A-ZÀ-Ú][a-zà-ú]+\s+[A-ZÀ-Ú][a-zà-ú]+", f"{q} {topic}") or any(w in t for w in ("apresentador", "tv ", "televis", "ator", "atriz", "cantor", "filme", "novela", "famos")):
        return ["wikimedia"]
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


_YT_CACHE: dict = {}
import re as _re
BANNED_TITLE = _re.compile(r"(?i)\b(interview|entrevista|podcast|cortes?|react|reação|legendado|subtitles?|lyrics?)\b")


def _yt_searches(q: str) -> list:
    _nm = proper_names(q)
    _qq = (f'"{" ".join(w.capitalize() for w in _nm[0].split())}" ' + " ".join(x for x in q.split() if x.lower() not in _nm[0])) if _nm else q
    return [f"ytsearch8:{_qq} shorts", f"ytsearch8:{_qq} edit"]


def prefetch_youtube_searches(queries: list, workers: int = 4) -> None:
    """Faz as buscas do YouTube de todas as cenas ao mesmo tempo (4 por vez); a cena depois só baixa o trecho."""
    from concurrent.futures import ThreadPoolExecutor
    from analyzer import _ytdlp

    def one(search):
        try:
            _YT_CACHE[search] = json.loads(_ytdlp(["--flat-playlist", "-J", search])).get("entries") or []
        except Exception:
            pass
    todo = list(dict.fromkeys(s for q in queries if q for s in _yt_searches(q)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, todo))


def youtube_clip(runner, job, q: str, sc: dict, out: Path, used: set) -> dict | None:
    """Busca no YouTube priorizando Shorts/clipes curtos (o personagem fica em cena o tempo todo) e baixa só o trecho da cena."""
    import random
    from analyzer import _ytdlp
    entries = []
    for search in _yt_searches(q):
        try:
            if search in _YT_CACHE:
                entries += _YT_CACHE[search]
                continue
            data = json.loads(_ytdlp(["--flat-playlist", "-J", search]))
            entries += data.get("entries") or []
        except Exception as e:
            runner.log(job, f"YouTube busca: {str(e)[:150]}", "warn", "visuals")
    if not entries:
        return None
    # Clipes curtos primeiro: em vídeos longos um corte cai quase sempre no momento errado.
    entries.sort(key=lambda e: (e.get("duration") or 180) > 90)
    need = _scene_secs(sc)
    names = proper_names(q)
    for e in entries:
        vid, dur = e.get("id"), e.get("duration")
        title = (e.get("title") or "").lower()
        # O personagem citado na cena tem que estar no vídeo: título sem o nome dele é descartado.
        if names and not any(nm in title for nm in names):
            continue
        # Entrevistas/podcasts/cortes quase sempre têm legenda queimada: nunca usar.
        if BANNED_TITLE.search(title):
            continue
        # busca rápida às vezes vem sem duração: não descarta, assume um clipe de ~3 min
        if not vid or vid in used or (dur and (dur < 5 or dur > 1200)):
            continue
        dur = float(dur or 180)
        if dur <= need + 1:
            start = 0.0
        elif dur <= 90:
            # Short: o personagem aparece logo; pega um trecho nos primeiros 2/3.
            start = round(random.uniform(0.5, max(0.5, min(dur * 0.66, dur - need - 0.5))), 1)
        else:
            # Vídeo longo: evita a abertura e créditos e fica no miolo, onde a cena citada costuma estar.
            start = round(random.uniform(dur * 0.2, max(dur * 0.2, dur * 0.6 - need)), 1)
        out.unlink(missing_ok=True)
        try:
            _ytdlp(["-f", "bv*[height>=720]+ba/b[height>=720]/bv*+ba/b", "--merge-output-format", "mp4",
                    "--download-sections", f"*{start}-{start + need}", "--force-keyframes-at-cuts",
                    "--no-playlist", "-o", str(out), f"https://www.youtube.com/watch?v={vid}"])
        except Exception as ex:
            runner.log(job, f"YouTube download {vid}: {str(ex)[:150]}", "warn", "visuals")
            used.add(vid)  # link quebrado/lento: nunca tentar de novo
            continue
        if out.exists() and out.stat().st_size > 20000:
            used.add(vid)
            return {"id": f"yt:{vid}:{start}", "page": f"https://www.youtube.com/watch?v={vid}&t={int(start)}", "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or ""}
    return None


def _tiktok_search(q: str) -> list[dict]:
    """Acha links de vídeos do TikTok pelo Bing (sem TikWM). O download é feito pelo yt-dlp com os cookies da conta."""
    import re, html as _h
    r = requests.get("https://www.bing.com/search", timeout=25,
                     params={"q": f"site:tiktok.com {q[:80]}", "setlang": "pt-br", "cc": "BR", "count": 30},
                     headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
                              "Accept-Language": "pt-BR,pt;q=0.9"})
    if r.status_code != 200:
        raise RuntimeError(f"Bing HTTP {r.status_code}")
    out, seen = [], set()
    for m in re.finditer(r"https?://(?:www\.)?tiktok\.com/@([\w.\-]+)/video/(\d+)", _h.unescape(r.text)):
        if m.group(2) not in seen:
            seen.add(m.group(2))
            out.append({"id": m.group(2), "author": m.group(1), "url": m.group(0)})
    return out


def tiktok_clip(runner, job, q: str, sc: dict, out: Path, used: set) -> dict | None:
    """Busca vídeos do TikTok (links via Bing, download direto pelo yt-dlp + cookies) e corta só o trecho da cena."""
    import random
    from analyzer import fetch_tiktok
    need = _scene_secs(sc)
    if getattr(runner, "_tt_blocked", False):
        return None
    try:
        vids = _tiktok_search(q)
    except Exception as e:
        runner.log(job, f"Busca TikTok falhou ({str(e)[:100]})", "warn", "visuals")
        return None
    raw = out.with_name(out.stem + "_tt.mp4")
    fails = 0
    for v in vids[:5]:
        vid = v["id"]
        if vid in used:
            continue
        try:
            fetch_tiktok(v["url"], raw)
            dur = media.duration(raw)
            start = round(random.uniform(0, max(0.0, dur - need - 0.5)), 1) if dur > need + 1 else 0.0
            media.run(["ffmpeg", "-y", "-ss", f"{start}", "-i", str(raw), "-t", f"{need:.2f}", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(out)])
        except Exception as ex:
            fails += 1
            runner.log(job, f"TikTok download {vid}: {str(ex)[:150]}", "warn", "visuals")
            if "403" in str(ex) or fails >= 3:
                runner._tt_blocked = True  # bloqueio: não perde mais tempo nas próximas cenas
                return None
            continue
        finally:
            raw.unlink(missing_ok=True)
        if out.exists() and out.stat().st_size > 20000:
            used.add(vid)
            return {"id": f"tt:{vid}:{start}", "page": v["url"], "title": "", "channel": f"@{v['author']}"}
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


_WEB_CACHE: dict = {}


def prefetch_web_images(queries: list, workers: int = 8) -> None:
    """Busca as fotos de várias cenas ao mesmo tempo (8 de uma vez)."""
    from concurrent.futures import ThreadPoolExecutor
    todo = [q for q in dict.fromkeys(queries) if q and q not in _WEB_CACHE]
    def one(q):
        try:
            web_images(q)
        except Exception:
            pass
    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(one, todo))


def web_images(q: str) -> list[dict]:
    if q in _WEB_CACHE:
        return _WEB_CACHE[q]
    r = _web_images_raw(q)
    _WEB_CACHE[q] = r
    return r


def _web_images_raw(q: str) -> list[dict]:
    """Busca de imagens na web: Google (se tiver cookies), depois DuckDuckGo e Bing."""
    import re
    try:
        g = google_images(q)
        if g:
            return g
    except Exception:
        pass
    h = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36"}
    m = None  # DuckDuckGo desativado: bloqueia e atrasa 2-4s por cena; vai direto ao Bing
    if m:
        r = requests.get("https://duckduckgo.com/i.js", headers={**h, "Referer": "https://duckduckgo.com/"}, timeout=30,
                         params={"l": "wt-wt", "o": "json", "q": q, "vqd": m.group(1), "f": ",,,,,", "p": "1"})
        if r.status_code == 200 and "results" in r.text:
            res = [{"id": f"web:{x['image'][-80:]}", "url": x["image"], "page": x.get("url"), "text": x.get("title", "")}
                   for x in r.json().get("results", [])[:20] if (x.get("width") or 0) >= 600]
            if res:
                return res
    # Plano B: Bing Imagens (sem acentos e encurtando a busca se vier vazia).
    import html as _h
    import unicodedata
    clean = "".join(c for c in unicodedata.normalize("NFD", q) if unicodedata.category(c) != "Mn")
    words = clean.split()
    import time
    core = [w for w in words if w.lower() not in ("foto", "fotos", "antiga", "imagem", "real", "de", "da", "do")]
    tries = [clean, " ".join(core)] + [" ".join(core[:n]) for n in (3, 2) if len(core) > n]
    for i, tq in enumerate([t for t in dict.fromkeys(tries) if t] * 2):
        if i:
            time.sleep(1.0)
        r = requests.get("https://www.bing.com/images/async", params={"q": tq, "first": 0, "count": 35, "mmasync": 1, "setlang": "pt-br", "cc": "BR"},
                         headers={**h, "Accept-Language": "pt-BR,pt;q=0.9"}, timeout=30)
        out = []
        for u in dict.fromkeys(_h.unescape(x) for x in re.findall(r'murl&quot;:&quot;(.*?)&quot;', r.text)):
            out.append({"id": f"web:{u[-80:]}", "url": u, "page": None, "text": tq})
        for raw in re.findall(r'm="(\{.*?\})"', r.text):
            try:
                d = json.loads(_h.unescape(raw))
            except Exception:
                continue
            if d.get("murl"):
                out.append({"id": f"web:{d['murl'][-80:]}", "url": d["murl"], "page": d.get("purl"), "text": d.get("t", "")})
        if out:
            return out[:20]
    raise RuntimeError("busca de imagens na web indisponível agora")


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


def _img_ok(path: Path) -> bool:
    try:
        if path.stat().st_size < 25000:
            return False
        from PIL import Image
        with Image.open(path) as im:
            return min(im.size) >= 480 and max(im.size) >= 720
    except Exception:
        return path.exists() and path.stat().st_size > 60000


def _web_pick(runner, job, q, work, sc, prod, recent, window, yt_used):
    """Mídia real do assunto: TikTok/YouTube conforme a proporção da cena, depois imagem da web."""
    ps = prod.get("settings") or {}
    image_only = bool(ps.get("image_only")) or ps.get("media_rule") == "image_only" or bool(re.search(r"(?i)\b(foto|fotos|photo|arquivo|jornal|retrato)\b", q))
    video_only = not image_only and (bool(ps.get("video_only")) or is_pop(q, prod.get("topic") or ""))
    sources = []
    # Igual à referência: canal de fotos não busca vídeo; referência do YouTube nunca busca TikTok.
    # TikTok só quando a referência é comprovadamente do TikTok.
    if not image_only and runner.cfg.get("tiktok_clips", True) and ps.get("ref_platform") == "tiktok":
        sources.append(("tiktok", tiktok_clip))
    if not image_only and runner.cfg.get("youtube_clips", True):
        sources.append(("youtube", youtube_clip))
    # Cena 9:16 → TikTok/Shorts primeiro (vertical nativo); 16:9, 1:1, 3:4 → YouTube HD primeiro. A outra é plano B.
    if scene_frame(sc, prod) != "9:16":
        sources.reverse()
    vout = work / f"vid_{sc['idx']:03d}.mp4"
    if not video_only:
        sources = sources[:1]  # misto: 1 tentativa de vídeo, depois foto HD direto
    for name, fn in sources:
        for _ in range(2 if video_only else 1):
            c = fn(runner, job, q, sc, vout, yt_used)
            if not c:
                break
            _tl = (c.get("title") or "").lower()
            _nm = [n for n in dict.fromkeys(proper_names(q)) if len(n) > 2]
            # Título já cita o personagem da busca: aprova direto (sem tribunal de 1 frame).
            if not (_nm and any(n in _tl for n in _nm)) and not vision_ok(runner, job, vout, sc, prod):
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
        return _web_pick(runner, job, base, work, sc, prod, recent, window, yt_used)
    if video_only:
        runner.log(job, f"cena {sc['idx'] + 1}: canal só de vídeo — sem foto, reaproveita clipe", step="visuals")
        return None
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
            # Foto da web: sem IA de visão (lenta). Só confere tamanho/resolução mínima.
            if not _img_ok(out):
                recent.append(c["id"])
                continue
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "web", "source_url": c["page"],
                                  "license": "Imagem da web — direitos do autor original; verifique antes de monetizar", "attribution": (c["text"] or "web")[:200], "local_path": str(out), "description": q})["id"]
            return {"id": aid, "key": c["id"]}
    except Exception as e:
        runner.log(job, f"imagens web: {e}", "warn", "visuals")
    return None


_HOOK = r"\b(revela|revelou|segredo|segredos|que ninguém notou|ninguém|nunca|jamais|mexa|com|você|voce|não|nao|sabia|verdade|incrível|incrivel|chocante|mais forte|top \d+|\d+|o|a|os|as|de|do|da|dos|das|que|por|isso|quem|como|porque|why|the|of|secret|nobody|noticed)\b"


def _subject(topic: str) -> str:
    """Tira o gancho do título ('IRON MAN REVELA SEGREDO...' → 'Iron Man')."""
    import re as _re
    topic = _re.split(r"(?i)\b(gancho|[âa]ngulo)\s*:", topic)[0]
    topic = _re.sub(r"#\w+", " ", topic)
    names = [n for n in proper_names(topic) if n.lower() not in ("gancho", "ângulo", "angulo")]
    if names:
        return " ".join(names[:2]).title()
    t = _re.sub(_HOOK, " ", topic.lower())
    t = _re.sub(r"[^\wÀ-ÿ ]", " ", t)
    return " ".join(t.split()[:3]).title() or topic[:40]


_STOP = set("o a os as um uma de do da dos das e em no na nos nas com por para que se seu sua com sobre muito mais quando onde como the of and with in on at".split())
_VAGUE = set("expressao expressão chocado chocada anunciando dramatico dramático olhando cena momento close tensao tensão misterioso misteriosa sombrio epico épico conceito simbolizando representando enquanto frente".split())


def _clean_q(q: str, topic: str = "") -> str:
    """Busca concreta: nomes próprios + até 3 substantivos; nada de frase poética da narração."""
    names = proper_names(q)
    q = re.sub(r"\b(19|20)\d{2}\b", " ", q)  # anos poluem a busca
    words = [w for w in re.sub(r"[^\wÀ-ÿ ]", " ", q).split() if not w.isdigit() if w.lower() not in _STOP and w.lower() not in _VAGUE and len(w) > 2]
    rest = [w for w in words if not any(w.lower() in n.lower() for n in names)][:3 if not names else 2]
    # nunca descartar o personagem: mantém todos os nomes (até 5), na ordem original
    out = " ".join(list(dict.fromkeys(names))[:5] + rest).strip()
    return out or q[:40]



def _master_subs(out, link, work):
    """Legendas (auto) do vídeo base, grátis via yt-dlp: [(ini, fim, texto)] para casar fala × trecho."""
    import re as _re
    from analyzer import _ytdlp
    base = work / f"{out.stem}_subs"
    try:
        _ytdlp(["--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", "pt.*,en.*",
                "--sub-format", "vtt", "--no-playlist", "-o", str(base), link])
    except Exception:
        pass
    cues = []
    for f in sorted(work.glob(f"{base.name}*.vtt")):
        txt = f.read_text(encoding="utf-8", errors="ignore")
        for m in _re.finditer(r"(\d+):(\d+):([\d.]+) --> (\d+):(\d+):([\d.]+)[^\n]*\n(.+?)(?:\n\n|$)", txt, _re.S):
            a = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])
            b = int(m[4]) * 3600 + int(m[5]) * 60 + float(m[6])
            cues.append((a, b, _re.sub(r"<[^>]+>", "", m[7]).lower()))
        if cues:
            break
    return cues


def _scene_terms(sc) -> set:
    import re as _re
    txt = f"{sc.get('narration') or ''} {sc.get('visual_query') or ''}"
    names = {n.lower() for n in proper_names(txt)}
    words = {w for w in _re.findall(r"[a-zà-ú]{5,}", txt.lower())}
    return {"!" + n for n in names} | {"!" + w for n in names for w in n.split() if len(w) > 2} | words


def _shot_score(m, shot, terms) -> float:
    cues = (m.get("subs") or {}).get(str(shot[0]) if len(shot) == 3 else str(m["path"])) or []
    a, b = shot[-2], shot[-1]
    txt = " ".join(c[2] for c in cues if c[1] >= a - 1.5 and c[0] <= b + 1.5)
    if not txt:
        return 0.0
    names = {t for t in terms if t.startswith("!")}
    return float(sum((3 if t in names else 1) for t in terms if t.lstrip("!") in txt))


def _master_pack(runner, job, topic: str, work: Path, links: list | None = None) -> dict | None:
    """Baixa vídeo(s)-mestre (links do usuário ou busca do tema) e detecta os cortes reais com FFmpeg."""
    import re as _re, subprocess
    from analyzer import _ytdlp
    subs = {}
    if links:
        packs = []
        for i, link in enumerate(links[:2]):
            out = work / f"master_{i}.mp4"
            try:
                out.unlink(missing_ok=True)
                _ytdlp(["-f", "bv*[height>=720]+ba/b[height>=720]/bv*+ba/b", "--merge-output-format", "mp4",
                        "--no-playlist", "-o", str(out), link])
            except Exception as ex:
                runner.log(job, f"vídeo base {i + 1}: não baixou ({str(ex)[:120]})", "warn", "visuals")
                continue
            if not out.exists():
                continue
            r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(out), "-vf", "scale=-2:240,select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
                               capture_output=True, text=True)
            cuts = [float(x) for x in _re.findall(r"pts_time:([\d.]+)", r.stderr)]
            dm = _re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
            dur = int(dm[1]) * 3600 + int(dm[2]) * 60 + float(dm[3]) if dm else (cuts[-1] if cuts else 0)
            pts = [0.0] + cuts
            shots = [(out, a, b) for a, b in zip(pts, pts[1:] + [dur]) if b - a >= 1.0]
            subs[str(out)] = _master_subs(out, link, work)
            runner.log(job, f"vídeo base {i + 1}: {len(shots)} tomadas, {len(subs[str(out)])} falas legendadas", step="visuals")
            packs += shots
        if packs:
            # intercala os dois vídeos para distribuir pelo roteiro
            return {"path": None, "shots": packs, "used": set(), "vid": "base", "title": "vídeo base", "channel": "", "links": links, "user": True, "subs": subs}
        return None
    subj = _subject(topic)
    names = [n for n in proper_names(_re.split(r"(?i)\b(gancho|[âa]ngulo)\s*:", topic)[0]) if len(n) > 2]
    ents = list(dict.fromkeys([subj] + [n.title() for n in names]))[:2]
    runner.log(job, f"vídeo-mestre: assuntos = {ents}", step="visuals")
    runner.update(job, wait_reason="Baixando e escaneando vídeos base…")
    packs, got, pages = [], set(), []
    for qi in range(2):
        ent = ents[qi % len(ents)]
        entries = []
        for q in ((" ".join(topic.split()[:8]) if qi == 0 else ent), f"{ent} edit", f"{ent} cenas hd", f"{ent} melhores momentos"):
            try:
                entries += json.loads(_ytdlp(["--flat-playlist", "-J", f"ytsearch8:{q}"])).get("entries") or []
            except Exception as e:
                runner.log(job, f"vídeo-mestre: busca '{q}' falhou ({str(e)[:100]})", "warn", "visuals")
            if len(entries) >= 4:
                break
        out = work / f"master_{len(pages)}.mp4"
        for e in entries:
            vid, dur = e.get("id"), e.get("duration") or 0
            if not vid or vid in got or (dur and (dur < 20 or dur > 900)):
                continue
            try:
                out.unlink(missing_ok=True)
                _ytdlp(["-f", "bv*[height>=720]+ba/b[height>=720]/bv*+ba/b", "--merge-output-format", "mp4",
                        "--no-playlist", "-o", str(out), f"https://www.youtube.com/watch?v={vid}"])
            except Exception as ex:
                runner.log(job, f"vídeo-mestre {vid}: {str(ex)[:120]}", "warn", "visuals")
                continue
            if not out.exists() or out.stat().st_size < 100000:
                continue
            r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(out), "-vf", "scale=-2:240,select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"],
                               capture_output=True, text=True)
            cuts = [float(x) for x in _re.findall(r"pts_time:([\d.]+)", r.stderr)]
            dm = _re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
            d = int(dm[1]) * 3600 + int(dm[2]) * 60 + float(dm[3]) if dm else float(dur or (cuts[-1] if cuts else 0))
            pts = [0.0] + cuts
            shots = [(out, a, b) for a, b in zip(pts, pts[1:] + [d]) if b - a >= 1.0 and a > d * 0.03 and b < d * 0.97]
            if not shots:
                continue
            got.add(vid)
            pages.append(f"https://www.youtube.com/watch?v={vid}")
            packs += shots
            subs[str(out)] = _master_subs(out, pages[-1], work)
            runner.log(job, f"vídeo-mestre {len(pages)}: {e.get('title', '')[:80]} — {len(shots)} tomadas", step="visuals")
            break
    if packs:
        return {"path": packs[0][0], "shots": packs, "used": set(), "vid": got and next(iter(got)) or "", "title": "vídeos-mestres", "channel": "YouTube",
                "links": pages, "auto": True, "subs": subs}
    return None


def _master_clip(runner, job, m: dict, sc: dict, vout: Path, prod: dict) -> dict | None:
    """Fatia o mestre em tomadas inteiras (sem esticar clipes curtos); até 3 tentativas locais."""
    import subprocess
    need = _scene_secs(sc)
    cur = m.setdefault("cursor", {})  # fim já consumido por fonte: nunca reexibe os mesmos segundos
    srcof = lambda s: str(s[0]) if len(s) == 3 else str(m["path"])
    free = [s for s in m["shots"] if s not in m["used"] and s[-2] >= cur.get(srcof(s), 0.0)]
    # prefere tomadas que cubram a fala sozinhas; senão as mais longas
    ln = lambda s: s[-1] - s[-2]
    if m.get("user") or m.get("auto"):
        # intercala os vídeos base: cena 1 no vídeo 1, cena 2 no vídeo 2...
        srcs = sorted({srcof(s) for s in m["shots"]})
        turn = m.get("turn", 0)
        m["turn"] = turn + 1
        if srcs:
            want = srcs[turn % len(srcs)]
            free.sort(key=lambda s: (srcof(s) != want, s[-2]))
    else:
        free.sort(key=lambda s: (ln(s) < need, -ln(s)))
    # Fala × trecho: tomada onde o personagem/assunto citado aparece na legenda do vídeo base vem primeiro
    terms = _scene_terms(sc)
    if terms and m.get("subs"):
        pool = [s for s in m["shots"] if s not in m["used"]]
        hit = sorted(((_shot_score(m, s, terms), s) for s in pool), key=lambda x: -x[0])
        best = [s for sc_, s in hit if sc_ > 0][:3]
        if best:
            runner.log(job, f"cena {sc['idx'] + 1}: trecho casado com a fala", step="visuals")
            free = best + [s for s in free if s not in best]
    for shot in [x for x in free if ln(x) >= 1.5][:3] or free[:2]:
        m["used"].add(shot)
        src, a = (shot[0], shot[1]) if len(shot) == 3 else (m["path"], shot[0])
        start = a + 0.1
        cur[str(src)] = start + need
        m["used"].update(x for x in m["shots"] if srcof(x) == str(src) and x[-2] < start + need)
        vout.unlink(missing_ok=True)
        subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{start:.2f}", "-i", str(src),
                        "-t", f"{need:.2f}", "-c:v", "libx264", "-preset", "veryfast", "-an", str(vout)])
        # vídeo base escolhido por você: não passa pela recusa da IA
        # Catálogo do mestre: depois de 2 tomadas aprovadas da mesma fonte, confia nela (sem nova checagem da IA).
        trust = m.setdefault("trust", {})
        ok = vout.exists() and vout.stat().st_size > 20000 and (
            m.get("user") or trust.get(str(src), 0) >= 2 or vision_ok(runner, job, vout, sc, prod))
        if ok:
            trust[str(src)] = trust.get(str(src), 0) + 1
            if m.get("user") or m.get("auto"):
                i = int(Path(src).stem.split("_")[-1])
                return {"id": f"base{i}:{start:.1f}", "page": m["links"][i]}
            return {"id": f"master:{m['vid']}:{start:.1f}", "page": f"https://www.youtube.com/watch?v={m['vid']}&t={int(start)}"}
    return None



def _live_thumb(runner, src, asset_id, prod_id, idx):
    """Miniatura da cena para o painel. Nunca interrompe a produção."""
    try:
        src = Path(src)
        if not src.exists():
            return
        jpg = src.with_name(src.stem + "_live.jpg")
        media.run(["ffmpeg", "-y", "-ss", "0.5", "-i", str(src), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "7", str(jpg)])
        if not jpg.exists():
            media.run(["ffmpeg", "-y", "-i", str(src), "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "7", str(jpg)])
        if not jpg.exists():
            return
        up = runner.api.call("upload_url", name=f"thumbs/{prod_id}-{idx}.jpg")
        r = requests.put(up["signed_url"], data=jpg.read_bytes(), headers={"Content-Type": "image/jpeg", "x-upsert": "true"}, timeout=30)
        r.raise_for_status()
        runner.api.call("set_asset_thumb", asset_id=asset_id, path=up["path"])
        jpg.unlink(missing_ok=True)
    except Exception:
        pass


def pick_visuals(runner, job, ctx) -> None:

    s, work, prod = ctx["settings"], ctx["work"], ctx["prod"]
    w, h = ctx["w"], ctx["h"]
    orientation = "portrait" if h > w else "landscape" if w > h else "square"
    key = None  # Pexels removido: banco genérico não combina com os canais de referência
    pxb = None  # Pixabay removido: banco genérico só gerava recusas
    window = s["visuals"].get("avoid_repeat_window", 4)
    uploads = [a for a in ctx["assets"] if a["source"] == "upload" and a["kind"] == "image" and a.get("storage_path")]
    recent: list[str] = []
    recent_imgs: list[str] = []
    yt_used: set = set()
    ai_used = 0
    topic = prod.get("topic") or prod.get("title") or ""
    image_only = bool((prod.get("settings") or {}).get("image_only"))
    master = None
    total = len(ctx["scenes"])
    try:
        runner.update(job, wait_reason="Buscando fotos de 8 cenas ao mesmo tempo…")
        prefetch_web_images([_clean_q(x.get("visual_query") or x["narration"][:60], topic) for x in ctx["scenes"]])
    except Exception as e:
        runner.log(job, f"busca paralela de fotos: {str(e)[:100]}", "warn", "visuals")
    if not image_only:
        try:
            runner.update(job, wait_reason="Pesquisando vídeos de 4 cenas ao mesmo tempo…")
            prefetch_youtube_searches([_clean_q(x.get("visual_query") or x["narration"][:60], topic) for x in ctx["scenes"]])
        except Exception as e:
            runner.log(job, f"busca paralela de vídeos: {str(e)[:100]}", "warn", "visuals")
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
        q0 = _clean_q(sc.get("visual_query") or sc["narration"][:60], topic)
        links = [u for u in ((prod.get("settings") or {}).get("source_urls") or []) if u][:2]
        if master is None and links:
            master = _master_pack(runner, job, topic, work, links) or False
        # Vídeo-mestre só para personagem único; listas/vários nomes buscam cena a cena.
        if master is None and not image_only and is_pop(topic, topic) and runner.cfg.get("master_video", True) and len(set(proper_names(topic))) <= 1 and len({n for x in ctx["scenes"] for n in proper_names(x.get("visual_query") or "")}) <= 3:
            master = _master_pack(runner, job, topic, work) or False
        # Cena de "ruptura": cita alguém que não está no tema → busca fora do mestre.
        off_topic = not (master and master.get("user")) and any(nm not in topic.lower() for nm in proper_names(q0))
        if master and not off_topic:
            c = _master_clip(runner, job, master, sc, work / f"vid_{sc['idx']:03d}.mp4", prod)
            if c:
                aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "video", "source": "youtube", "source_url": c["page"],
                                      "license": "Trecho curto do YouTube — uso transformativo/comentário; verifique antes de monetizar",
                                      "attribution": f"{master['channel']} — {master['title']}"[:200], "local_path": str(work / f"vid_{sc['idx']:03d}.mp4"), "description": q0})["id"]
                chosen = {"id": aid, "key": c["id"]}
                runner.log(job, f"cena {sc['idx'] + 1}: trecho do vídeo-mestre", step="visuals")
        if not chosen and (is_pop(q0, topic) or image_only):
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
            if src == "pexels" and not chosen and not is_pop(q0, topic):
                # Openverse/Flickr traz bichos e fotos amadoras: nunca para filmes, séries, novelas ou famosos.
                q = sc.get("visual_query") or sc["narration"][:60]
                chosen = _open_pick(runner, job, q, work, sc, prod, recent, window, open_order(q, prod.get("topic") or ""))
            elif src == "ai_image" and s["ai"]["allow_ai_images"]:
                aspect = (prod.get("settings") or {}).get("aspect_override") or prod["aspect"]
                r = runner.api.call("ai_image", job_id=job["id"], prompt=sc.get("visual_description") or sc["narration"], aspect=aspect, used=ai_used)
                if r.get("b64"):
                    out.write_bytes(base64.b64decode(r["b64"]))
                    ai_used += 1
                    aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "ai_image", "license": "Gerada por IA", "local_path": str(out), "description": sc.get("visual_description")})["id"]
                    chosen = {"id": aid}
            if chosen:
                break
        if not chosen and master:
            # garantia de mídia: tomada livre do mestre (sem nova validação) em vez de fundo neutro
            import subprocess as _sp
            free = [x for x in master["shots"] if x not in master["used"]] or master["shots"]
            pick = max(free, key=lambda x: x[-1] - x[-2])
            master["used"].add(pick)
            a = pick[-2]
            msrc = pick[0] if len(pick) == 3 else master["path"]
            vout = work / f"vid_{sc['idx']:03d}.mp4"
            _sp.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{a + 0.1:.2f}", "-i", str(msrc),
                     "-t", f"{_scene_secs(sc):.2f}", "-c:v", "libx264", "-preset", "veryfast", "-an", str(vout)])
            if vout.exists() and vout.stat().st_size > 20000:
                runner.log(job, f"cena {sc['idx'] + 1}: sem fonte aprovada — usada tomada do vídeo-mestre (evita fundo neutro)", "warn", "visuals")
                aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "video", "source": "youtube",
                                      "source_url": f"https://www.youtube.com/watch?v={master['vid']}&t={int(a)}",
                                      "license": "Trecho curto do YouTube — uso transformativo/comentário; verifique antes de monetizar",
                                      "attribution": f"{master['channel']} — {master['title']}"[:200], "local_path": str(vout), "description": q0})["id"]
                chosen = {"id": aid, "key": f"master:{master['vid']}:{a:.1f}"}
        if not chosen and not (prod.get("settings") or {}).get("video_only"):
            # Garantia final (zero tela preta): primeira foto HD do protagonista, sem validação de IA.
            try:
                for c in web_images(_subject(topic) or q0)[:8]:
                    try:
                        _download(c["url"], out)
                    except Exception:
                        continue
                    if _img_ok(out):
                        aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "web", "source_url": c["page"],
                                              "license": "Imagem da web — direitos do autor original; verifique antes de monetizar", "attribution": (c["text"] or "web")[:200], "local_path": str(out), "description": q0})["id"]
                        chosen = {"id": aid, "key": c["id"] + f":{sc['idx']}"}
                        break
            except Exception as e:
                runner.log(job, f"foto de garantia: {e}", "warn", "visuals")
        if not chosen and recent_imgs:
            import shutil as _sh
            _sh.copyfile(recent_imgs[-1], out)
            aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "web", "local_path": str(out), "description": "reaproveitada (Ken Burns)"})["id"]
            chosen = {"id": aid, "key": f"reuse:{sc['idx']}"}
            runner.log(job, f"cena {sc['idx'] + 1}: reaproveitada foto anterior com novo movimento (sem fundo neutro)", "warn", "visuals")
        if not chosen:
            media.text_card(sc.get("caption") or "", w, h, out.with_suffix(".png"))
            out.with_suffix(".png").replace(out)
            runner.log(job, f"cena {sc['idx'] + 1}: nenhuma fonte de imagem disponível — usado fundo neutro. Configure a chave Pexels ou envie imagens.", "warn", "visuals")
            continue
        recent.append(chosen.get("key") or chosen["id"])
        if out.exists():
            recent_imgs.append(str(out))
        runner.api.call("update_scene", scene_id=sc["id"], fields={"asset_id": chosen["id"], "status": "visual_ok"})
        sc["asset_id"] = chosen["id"]
        _live_thumb(runner, out, chosen["id"], prod["id"], sc["idx"])
