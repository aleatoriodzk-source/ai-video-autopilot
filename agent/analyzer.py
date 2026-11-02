"""Coleta de referências com yt-dlp + FFmpeg (cortes de cena e quadros-chave). Só dados reais; nada inventado."""
from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path

import forensics
import media


def structured(vid: Path, words=None, log=None) -> dict | None:
    """Perfil v2 medido localmente; falha nunca derruba a análise antiga."""
    try:
        return forensics.analyze(vid, words)
    except Exception as e:
        if log:
            log(f"forense v2 indisponível: {str(e)[:200]}")
        return None


UAS = {
    "chrome": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "edge": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "firefox": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
}
UA = UAS["chrome"]
# Cliente web nativo (sem emular TV/Android, que causava 403/SABR) + pausas naturais entre pedidos.
BASE = ["--user-agent", UA, "--extractor-args", "youtube:player_client=web,default", "--sleep-requests", "1"]


def set_browser(name: str) -> None:
    """Alinha a assinatura do navegador com a sessão vinculada (ex.: Firefox)."""
    global UA, BASE
    UA = UAS.get((name or "").split(":")[0].lower(), UAS["chrome"])
    BASE = ["--user-agent", UA, "--extractor-args", "youtube:player_client=web,default", "--sleep-requests", "1"]


# Arquivos cookies.txt das contas vinculadas no site ({"youtube": Path, "tiktok": Path}).
COOKIES: dict = {}


_UPDATED = False


def _self_update() -> None:
    """Atualiza o yt-dlp 1x por execução: o YouTube muda e versões antigas tomam 403."""
    global _UPDATED
    if _UPDATED:
        return
    _UPDATED = True
    import sys
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "yt-dlp"], capture_output=True, timeout=120)
    except Exception:
        pass


def _ytdlp(args: list[str]) -> str:
    _self_update()
    joined = " ".join(args)
    plat = "tiktok" if "tiktok.com" in joined else "youtube"
    base = ["--user-agent", UA] if plat == "tiktok" else BASE
    extra = ["--cookies", str(COOKIES[plat])] if COOKIES.get(plat) and Path(COOKIES[plat]).exists() else []
    p = subprocess.run(["yt-dlp", *base, *extra, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0 and extra:
        # cookie vencido não pode travar tudo: tenta sem a conta
        p = subprocess.run(["yt-dlp", *base, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError("yt-dlp: " + p.stderr[-800:])
    return p.stdout


def search_videos(query: str, shorts: bool = False, n: int = 20) -> list[dict]:
    """Busca vídeos no YouTube (com a sua conta, se vinculada)."""
    q = f"{query} #shorts" if shorts else query
    data = json.loads(_ytdlp(["--flat-playlist", "-J", f"ytsearch{n}:{q}"]))
    out = []
    for e in data.get("entries") or []:
        vid = e.get("id")
        if not vid:
            continue
        out.append({"id": vid, "title": e.get("title") or "", "channel": e.get("channel") or e.get("uploader") or "",
                    "duration": e.get("duration"), "views": e.get("view_count"),
                    "url": f"https://www.youtube.com/watch?v={vid}", "thumb": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"})
    return out


def fetch_video(url: str, out: Path, resolve=None, max_h: int = 1080) -> Path:
    """Baixa um vídeo inteiro (link ou 'storage:' do site) para usar como base."""
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists() and out.stat().st_size > 50000:
        return out
    if url.startswith("storage:"):
        import requests
        with requests.get(resolve(url[len("storage:"):]), stream=True, timeout=600) as r:
            r.raise_for_status()
            with open(out, "wb") as fh:
                for c in r.iter_content(1 << 20):
                    fh.write(c)
        return out
    if "tiktok.com" in url:
        return fetch_tiktok(url, out)
    _ytdlp(["-f", f"bv*[height<={max_h}][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4", "-o", str(out), "--no-playlist", "--force-overwrites", url])
    return out


def clean_tiktok_url(url: str) -> str:
    """Abre links curtos (vm./vt.tiktok.com) e tira ?is_from_webapp=... que confunde o extrator."""
    u = url.strip()
    if re.search(r"//(vm|vt)\.tiktok\.com/", u):
        try:
            import requests
            u = requests.head(u, allow_redirects=True, timeout=20, headers={"User-Agent": UA}).url
        except Exception:
            pass
    return u.split("?")[0].split("#")[0]


def fetch_tiktok(url: str, out: Path) -> Path:
    """TikTok direto pelo yt-dlp (com cookies/navegador da conta vinculada). Sem TikWM."""
    u = clean_tiktok_url(url)
    try:
        _ytdlp(["-f", "b[vcodec!=none][acodec!=none]/b", "-o", str(out), "--no-playlist", "--force-overwrites", u])
        if out.exists() and out.stat().st_size > 50000:
            return out
        err = "yt-dlp gerou arquivo vazio"
    except Exception as e:
        err = str(e)[-300:]
    raise RuntimeError("Não consegui baixar o TikTok: " + err + ". Dica: vincule sua conta pelo navegador na aba Contas.")


def tiktok_profile(url: str, first_err=None) -> dict:
    """Lista os vídeos de um perfil do TikTok pelo serviço público tikwm quando o yt-dlp é bloqueado."""
    import requests
    m = re.search(r"tiktok\.com/@([\w.\-]+)", url)
    if not m:
        raise RuntimeError(f"link de perfil do TikTok inválido: {url}")
    user = m.group(1)
    r = requests.post("https://www.tikwm.com/api/user/posts", data={"unique_id": user, "count": 30, "cursor": 0},
                      timeout=40, headers={"User-Agent": UA})
    try:
        vids = ((r.json() or {}).get("data") or {}).get("videos") or []
    except ValueError:
        vids = []
    if not vids:
        raise RuntimeError(f"Não consegui listar o perfil @{user} do TikTok ({str(first_err)[-150:]} | {r.text[:150]}). "
                           "Cole o link de um vídeo do perfil em vez do perfil.")
    return {"title": f"@{user}", "uploader": user, "entries": [
        {"title": v.get("title"), "duration": v.get("duration"), "view_count": v.get("play_count"),
         "url": f"https://www.tiktok.com/@{user}/video/{v.get('video_id')}"} for v in vids]}


def scene_cuts(video: Path, threshold: float = 0.3) -> list[float]:
    p = subprocess.run(["ffmpeg", "-i", str(video), "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return [round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", p.stderr)]


def audio_forensics(video: Path) -> dict:
    """Pausas na voz, densidade de fala e picos sonoros (prováveis efeitos/impactos). Medido, não inventado."""
    p = subprocess.run(["ffmpeg", "-i", str(video), "-af", "silencedetect=noise=-32dB:d=0.12,ebur128=metadata=1,ametadata=print:key=lavfi.r128.M",
                        "-vn", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    err = p.stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [(float(a), float(b)) for a, b in re.findall(r"silence_end: ([\d.]+) \| silence_duration: ([\d.]+)", err)]
    pauses = [round(d, 2) for _, d in ends]
    loud = [(float(t), float(m)) for t, m in re.findall(r"pts_time:([\d.]+)[^\n]*\n[^\n]*lavfi.r128.M=(-?[\d.]+)", err)]
    hits, prev = [], None
    for t, m in loud:
        if prev is not None and m - prev > 7 and m > -20 and (not hits or t - hits[-1] > 0.8):
            hits.append(round(t, 2))
        prev = m
    vals = [m for _, m in loud if m > -70]
    return {
        "pauses_count": len(pauses),
        "pause_avg_s": round(sum(pauses) / len(pauses), 2) if pauses else 0,
        "pause_max_s": max(pauses) if pauses else 0,
        "long_pauses_over_0_5s": sum(1 for x in pauses if x > 0.5),
        "pause_positions_s": [round(a - d, 2) for a, d in ends][:60],
        "silent_ratio": None,
        "loudness_avg_lufs": round(sum(vals) / len(vals), 1) if vals else None,
        "sound_hits_s": hits[:60],
        "note": "sound_hits = saltos bruscos de volume (impactos, whooshes, drops de música).",
    } if starts or loud else {"note": "sem áudio mensurável"}


def transcript(url: str, work: Path) -> list[dict]:
    """Legendas (manuais ou automáticas) com tempos. Usadas só para entender o formato."""
    try:
        _ytdlp(["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", "pt.*,en.*", "--sub-format", "vtt",
                "-o", str(work / "subs.%(ext)s"), "--no-playlist", url])
    except Exception:
        return []
    f = next(iter(sorted(work.glob("subs*.vtt"))), None)
    if not f:
        return []
    out, seen = [], set()
    for a, b, txt in re.findall(r"(\d+:\d+:[\d.]+) --> (\d+:\d+:[\d.]+)[^\n]*\n(.+?)(?:\n\n|$)", f.read_text("utf-8", "replace"), re.S):
        t = re.sub(r"<[^>]+>", "", txt).strip().replace("\n", " ")
        if t and t not in seen:
            seen.add(t)
            h, m, s = a.split(":")
            out.append({"t": round(int(h) * 3600 + int(m) * 60 + float(s), 2), "text": t})
    for x in work.glob("subs*.vtt"):
        x.unlink(missing_ok=True)
    return out[:3000]


def edit_forensics(dur: float, cuts: list[float], words: list[dict], audio: dict) -> dict:
    """Curva de ritmo por terço, gancho de 3s e velocidade de fala."""
    third = dur / 3 or 1
    curve = [round(sum(1 for c in cuts if i * third <= c < (i + 1) * third) / (third / 60), 1) for i in range(3)]
    n_words = sum(len(w["text"].split()) for w in words)
    hits = audio.get("sound_hits_s") or []
    return {
        "cuts_per_min": round(len(cuts) / (dur / 60), 1) if dur else 0,
        "cuts_per_min_by_third": curve,
        "hook_cuts_first_3s": sum(1 for c in cuts if c < 3),
        "hook_text_first_3s": " ".join(w["text"] for w in words if w["t"] < 3.5)[:200],
        "first_cut_s": cuts[0] if cuts else None,
        "words_per_second": round(n_words / dur, 2) if dur and n_words else None,
        "sound_hits_on_cuts": sum(1 for h in hits if any(abs(h - c) < 0.25 for c in cuts)),
        "sound_hits_total": len(hits),
    }


def motion_forensics(video: Path, cuts: list[float], dur: float) -> dict:
    """Nunca trava a análise: qualquer falha do OpenCV devolve {}."""
    try:
        return _motion_forensics(video, cuts, dur)
    except Exception:
        return {}


def _motion_forensics(video: Path, cuts: list[float], dur: float) -> dict:
    """Mede em cada tomada se houve zoom de entrada/saída, pan ou câmera parada (OpenCV), e se os cortes usam flash."""
    try:
        import cv2
        import numpy as np
    except Exception:
        return {}
    cap = cv2.VideoCapture(str(video))

    def grab(t):
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, fr = cap.read()
        return cv2.cvtColor(cv2.resize(fr, (320, int(320 * fr.shape[0] / fr.shape[1]))), cv2.COLOR_BGR2GRAY) if ok else None

    bounds = [0.0] + list(cuts) + [dur]
    counts = {"zoom_in": 0, "zoom_out": 0, "pan_left": 0, "pan_right": 0, "static": 0}
    flashes = 0
    for a, b in list(zip(bounds, bounds[1:]))[:60]:
        if b - a < 0.5:
            continue
        f1, f2 = grab(a + 0.15), grab(b - 0.15)
        if f1 is None or f2 is None:
            continue
        p1 = cv2.goodFeaturesToTrack(f1, 200, 0.01, 8)
        if p1 is None or len(p1) < 10:
            continue
        p2, st, _ = cv2.calcOpticalFlowPyrLK(f1, f2, p1, None)
        good1, good2 = p1[st.flatten() == 1], p2[st.flatten() == 1]
        if len(good1) < 8:
            continue
        m, _ = cv2.estimateAffinePartial2D(good1, good2)
        if m is None:
            continue
        scale = float(np.sqrt(m[0, 0] ** 2 + m[0, 1] ** 2))
        tx = float(m[0, 2]) / f1.shape[1]
        k = "zoom_in" if scale > 1.04 else "zoom_out" if scale < 0.96 else "pan_left" if tx < -0.05 else "pan_right" if tx > 0.05 else "static"
        counts[k] += 1
    for c in cuts[:60]:
        f = grab(c + 0.03)
        if f is not None and float(f.mean()) > 225:
            flashes += 1
    cap.release()
    total = sum(counts.values())
    if not total:
        return {}
    moving = {k: v for k, v in counts.items() if k != "static"}
    return {"shots": counts, "dominant": max(counts, key=counts.get), "moving_share": round(sum(moving.values()) / total, 2),
            "main_move": max(moving, key=moving.get) if any(moving.values()) else "static", "flash_cuts": flashes}


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
    audio = audio_forensics(vid)
    out["videos"].append({"title": title, "duration_s": dur, "view_count": None, "description": "",
                          "scene_cuts_s": cuts, "avg_scene_s": round(dur / (len(cuts) + 1), 2), "subtitles_available": False,
                          "source": "upload", "audio": audio, "edit": {**edit_forensics(dur, cuts, [], audio), "motion": motion_forensics(vid, cuts, dur)},
                          "structured": structured(vid, None, log)})
    log(f"áudio: {audio.get('pauses_count', 0)} pausas (média {audio.get('pause_avg_s', 0)}s), {len(audio.get('sound_hits_s') or [])} impactos sonoros")
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
            url = channel_url(url)
            try:
                meta = json.loads(_ytdlp(["-J", "--flat-playlist", "--playlist-end", "30", url]))
            except Exception as err:
                if "tiktok.com" not in url:
                    raise
                log("TikTok bloqueou a lista do perfil; usando caminho alternativo")
                meta = tiktok_profile(url, err)
            out["title"] = meta.get("title") or meta.get("uploader")
            out["entries"] = [{k: e.get(k) for k in ("title", "duration", "view_count", "url")} for e in meta.get("entries") or []]
            log(f"{len(out['entries'])} vídeos listados")
            targets = pick_targets(out["entries"])
            log(f"comparando os {len(targets)} vídeos mais recentes")
        else:
            targets = [url]
        for t in targets:
            vid = work / f"v{len(out['videos'])}.mp4"
            try:
                meta = json.loads(_ytdlp(["-J", "--no-playlist", t]))
            except Exception:
                if "tiktok.com" not in t:
                    raise
                meta = {"title": None}
            if "tiktok.com" in t:
                fetch_tiktok(t, vid)
            else:
                _ytdlp(["-f", "mp4[height<=720]/best[height<=720]/best", "-o", str(vid), "--no-playlist", "--force-overwrites", t])
            dur = media.duration(vid)
            cuts = scene_cuts(vid)
            out["title"] = out.get("title") or meta.get("title")
            words = transcript(t, work)
            audio = audio_forensics(vid)
            log(f"transcrição: {len(words)} trechos; áudio: {audio.get('pauses_count', 0)} pausas, {len(audio.get('sound_hits_s') or [])} impactos")
            out["videos"].append({
                "transcript": words, "audio": audio, "edit": {**edit_forensics(dur, cuts, words, audio), "motion": motion_forensics(vid, cuts, dur)},
                "title": meta.get("title"), "duration_s": dur, "view_count": meta.get("view_count"),
                "description": (meta.get("description") or "")[:1500], "scene_cuts_s": cuts,
                "avg_scene_s": round(dur / (len(cuts) + 1), 2), "subtitles_available": bool(meta.get("subtitles") or meta.get("automatic_captions")),
                "structured": structured(vid, words, log),
            })
            log(f"'{meta.get('title')}': {len(cuts)} cortes detectados em {dur:.0f}s")
            per = 10 if len(targets) == 1 else 3
            if len(targets) == 1 and not imgs:
                cuts = [0.3, 1.2, 2.4] + [c for c in cuts if c > 2.6]  # gancho em detalhe
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


def channel_url(url: str) -> str:
    """Canal do YouTube sem aba retorna só as abas; força /videos (ou mantém /shorts)."""
    u = re.sub(r"[?#].*$", "", url.strip()).rstrip("/")  # remove ?si=... de links compartilhados
    if re.search(r"youtube\.com/(@[^/]+|c/[^/]+|channel/[^/]+|user/[^/]+)$", u):
        return u + "/videos"
    return u


def pick_targets(entries: list[dict], n: int = 5) -> list[str]:
    """Os n vídeos mais recentes (a listagem do canal já vem do mais novo para o mais antigo)."""
    ok = [e for e in entries if e.get("url") and ("watch" in e["url"] or "/shorts/" in e["url"] or "/video/" in e["url"])] or [e for e in entries if e.get("url")]
    return [e["url"] for e in ok[:n]]
