"""Agente local do Estúdio Automático.

Busca trabalhos no painel, executa as etapas pesadas no seu computador (voz Piper,
imagens, cenas, legendas, FFmpeg) e salva o MP4 final em output_dir.
Uso: python agent.py   |   python agent.py --check
"""
from __future__ import annotations

import base64
import json
import platform
import random
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

import requests

import media

ROOT = Path(__file__).resolve().parent
VERSION = "0.2.0"
REVIEWABLE = {"topic", "script", "narration", "visuals", "scenes", "captions", "render"}
STEPS = ["analyze", "topic", "script", "narration", "visuals", "scenes", "captions", "audio", "render", "validate"]


class Paused(Exception):
    """Usuário pausou/cancelou no painel."""


class Api:
    def __init__(self, url: str, token: str):
        self.url, self.s = url, requests.Session()
        self.s.headers["Authorization"] = f"Bearer {token}"

    def call(self, action: str, **kw):
        for attempt in range(5):
            try:
                r = self.s.post(self.url, json={"action": action, **kw}, timeout=180)
            except requests.RequestException as e:
                err, retry = str(e), True
            else:
                if r.ok:
                    return r.json()
                body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {"error": r.text[:300]}
                err, retry = body.get("error", r.status_code), r.status_code == 429 or r.status_code >= 500
                if r.status_code == 401:
                    raise SystemExit(f"Token recusado pelo painel: {err}. Gere um novo token na página Agente.")
            if not retry:
                raise RuntimeError(f"{action}: {err}")
            time.sleep(min(60, 2 ** attempt + random.random()))
        raise RuntimeError(f"{action}: falhou após 5 tentativas ({err})")


def load_config() -> dict:
    p = ROOT / "config.json"
    if not p.exists():
        raise SystemExit("config.json não encontrado. Copie config.example.json e cole o token gerado no painel.")
    c = json.loads(p.read_text(encoding="utf-8-sig"))
    if not c.get("token") or "COLE" in c["token"]:
        raise SystemExit("Cole o token do painel em config.json.")
    c.setdefault("output_dir", str(ROOT / "videos"))
    c.setdefault("voices_dir", str(ROOT / "voices"))
    c.setdefault("work_dir", str(ROOT / "work"))
    return c


class Runner:
    def __init__(self, api: Api, cfg: dict):
        self.api, self.cfg = api, cfg

    # ---------- helpers ----------
    def log(self, job, msg, level="info", step=None):
        print(f"[{level}] {step or ''} {msg}")
        try:
            self.api.call("log", job_id=job["id"], production_id=job.get("production_id"), level=level, step=step, message=str(msg)[:4000])
        except Exception:
            pass

    def update(self, job, **patch):
        r = self.api.call("update_job", job_id=job["id"], patch=patch)["job"]
        if r["status"] in ("paused", "cancelled"):
            raise Paused(r["status"])
        job.update(r)
        return r

    # ---------- entrada ----------
    def run(self, job: dict, bundle: dict):
        try:
            self.load_cookies()
            if job["type"] == "analyze_reference":
                self.analyze_reference(job, bundle)
            elif job["type"] == "extract_voice":
                self.extract_voice(job, bundle)
            elif job["type"] == "search_videos":
                self.search_videos(job)
            else:
                self.production(job, bundle)
        except Paused as p:
            print(f"Trabalho {p}.")
        except Exception as e:
            attempts = (job.get("attempts") or 0) + 1
            tb = traceback.format_exc()
            self.log(job, f"{e}", "error", job.get("step"))
            retry = attempts < 3 and not isinstance(e, media.MediaError) and "ORÇAMENTO" not in str(e)
            payload = dict(job.get("payload") or {})
            if retry:
                payload["retry_at"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() + 60 * attempts)) + "Z"
            try:
                self.api.call("update_job", job_id=job["id"], patch={"status": "queued" if retry else "failed", "attempts": attempts, "error": f"{e}\n{tb[-1500:]}", "payload": payload})
            except Exception:
                pass

    # ---------- contas vinculadas ----------
    def load_cookies(self):
        import analyzer
        try:
            res = self.api.call("cookies")
        except Exception:
            return
        urls = res.get("cookies") or {}
        browsers = res.get("browsers") or {}
        d = ROOT / "cookies"
        d.mkdir(exist_ok=True)
        probe = {"youtube": "https://www.youtube.com/", "tiktok": "https://www.tiktok.com/", "google": "https://www.google.com/"}
        for plat in ("youtube", "tiktok", "google"):
            f = d / f"{plat}.txt"
            if plat in browsers:
                # Conexão direta: exporta a sessão do navegador do PC para o mesmo cookies.txt usado por todo o agente.
                try:
                    p = subprocess.run(["yt-dlp", "--cookies-from-browser", browsers[plat], "--cookies", str(f),
                                        "--skip-download", "--flat-playlist", "--playlist-items", "0", probe[plat]],
                                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
                    if f.exists() and f.stat().st_size > 100:
                        analyzer.COOKIES[plat] = f
                        analyzer.set_browser(browsers[plat])
                        print(f"conta {plat}: conectada pela sessão do {browsers[plat]}")
                    else:
                        print(f"conta {plat}: não consegui ler o {browsers[plat]} (feche o navegador e tente de novo). {p.stderr[-300:]}")
                except Exception as e:
                    print(f"conta {plat} ({browsers[plat]}): {e}")
            elif plat in urls:
                try:
                    r = requests.get(urls[plat], timeout=60)
                    r.raise_for_status()
                    f.write_bytes(r.content)
                    analyzer.COOKIES[plat] = f
                except Exception as e:
                    print(f"cookies {plat}: {e}")
            else:
                f.unlink(missing_ok=True)
                analyzer.COOKIES.pop(plat, None)

    # ---------- explorador ----------
    def search_videos(self, job):
        from analyzer import search_videos
        p = job.get("payload") or {}
        self.update(job, status="waiting_download", step="search", progress=20, wait_reason="buscando no YouTube")
        res = search_videos(str(p.get("query") or ""), bool(p.get("shorts")))
        self.update(job, status="done", progress=100, wait_reason=None, payload={**p, "results": res})

    # ---------- clonagem de voz ----------
    def extract_voice(self, job, bundle):
        import voice as vc
        from analyzer import fetch_video, audio_forensics, transcript
        v, ref = bundle.get("voice"), bundle.get("reference")
        if not v or not ref:
            raise media.MediaError("voz ou referência não encontrada")
        try:
            self.api.call("save_voice", voice_id=v["id"], fields={"status": "processing", "error": None})
            work = Path(self.cfg["work_dir"]) / f"voice_{v['id']}"
            self.update(job, status="waiting_download", step="voice", progress=10, wait_reason="baixando o vídeo")
            url = ref["urls"][0]
            base = fetch_video(url, work / "base.mp4", resolve=lambda p: self.api.call("download_url", path=p)["url"], max_h=480)
            self.update(job, status="running", progress=35, wait_reason="isolando a voz")
            vocals = vc.isolate(base, work, lambda m: self.log(job, m, step="voice"))
            self.update(job, progress=70, wait_reason="medindo ritmo e pausas")
            a = audio_forensics(vocals)
            dur = media.duration(vocals)
            words = 0
            if not url.startswith("storage:"):
                try:
                    words = sum(len(w["text"].split()) for w in transcript(url, work))
                except Exception:
                    words = 0
            speech = max(1.0, dur - (a.get("pauses_count") or 0) * (a.get("pause_avg_s") or 0))
            stats = {"duration_s": round(dur, 1), "pauses_count": a.get("pauses_count"), "pause_avg_s": a.get("pause_avg_s"),
                     "pause_max_s": a.get("pause_max_s"), "loudness_lufs": a.get("loudness_avg_lufs"),
                     "wpm": round(words / speech * 60) if words else None,
                     "isolation": "demucs" if vc.has_demucs() else "filtro simples", "engine_available": vc.engine()}
            sample = vc.best_sample(vocals, work)
            up = self.api.call("upload_url", name=f"voices/{v['id']}.wav")
            with open(sample, "rb") as fh:
                requests.put(up["signed_url"], data=fh, headers={"Content-Type": "audio/wav", "x-upsert": "true"}, timeout=300).raise_for_status()
            inst = vc.instrumental(work)
            if inst:
                up2 = self.api.call("upload_url", name=f"voices/{v['id']}_music.mp3")
                with open(inst, "rb") as fh:
                    requests.put(up2["signed_url"], data=fh, headers={"Content-Type": "audio/mpeg", "x-upsert": "true"}, timeout=300).raise_for_status()
                stats["music_path"] = up2["path"]
                self.log(job, "música de fundo isolada (sem voz) salva", step="voice")
            self.api.call("save_voice", voice_id=v["id"], fields={"status": "ready", "sample_path": up["path"], "stats": stats})
            self.log(job, f"voz pronta: {stats}", step="voice")
            self.update(job, status="done", progress=100, wait_reason=None, completed_steps=["voice"])
        except Paused:
            raise
        except Exception as e:
            self.api.call("save_voice", voice_id=v["id"], fields={"status": "failed", "error": str(e)[:1500]})
            raise media.MediaError(str(e))

    # ---------- análise de referência ----------
    def analyze_reference(self, job, bundle):
        from analyzer import collect_reference
        ref = bundle["reference"]
        kind = (bundle.get("analysis") or {}).get("kind", "channel")
        self.update(job, status="waiting_download", step="analyze", progress=10, wait_reason="baixando referência")
        work = Path(self.cfg["work_dir"]) / f"ref_{ref['id']}"
        prog = {"p": 10}

        def step_log(m):
            self.log(job, m, step="analyze")
            prog["p"] = min(65, prog["p"] + 8)
            self.update(job, status="running", progress=prog["p"], wait_reason=f"Dissecando: {m}"[:180])

        collected, frames = collect_reference(ref["urls"], kind, work, step_log,
                                             resolve=lambda path: self.api.call("download_url", path=path)["url"])
        self.api.call("save_collected", job_id=job["id"], collected=collected, title=collected.get("title"))
        self.update(job, status="waiting_api", progress=70, wait_reason="IA esqueletando legenda, transições e efeitos")
        self.api.call("ai_analyze", job_id=job["id"], collected=collected, frames=frames)
        self.update(job, status="done", progress=100, wait_reason=None, completed_steps=["analyze"])

    # ---------- produção ----------
    def production(self, job, bundle):
        settings = self.api.call("heartbeat", info=None)["settings"]
        prod, scenes = bundle["production"], bundle.get("scenes") or []
        done = list(job.get("completed_steps") or [])
        w, h = media.size_for((prod.get("settings") or {}).get("aspect_override") or prod["aspect"], settings["export"]["resolution"])
        work = Path(self.cfg["work_dir"]) / prod["id"]
        work.mkdir(parents=True, exist_ok=True)
        ctx = {"settings": settings, "prod": prod, "scenes": scenes, "w": w, "h": h, "work": work, "assets": bundle.get("assets") or [],
               "source_reference": bundle.get("source_reference") or bundle.get("reference"), "voice": bundle.get("voice"), "elevenlabs_key": bundle.get("elevenlabs_key"),
               "style_link": bundle.get("style_link")}
        self.last_ctx = ctx  # inspeção/testes
        try:
            from style_apply import load_report
            for line in load_report(self._plan(ctx), prod, ctx.get("style_link")):
                self.log(job, line, step="style")
        except Exception as err:
            self.log(job, f"relatório do perfil v2 indisponível: {str(err)[:200]}", "warn", step="style")

        for i, step in enumerate(STEPS):
            if step in done:
                continue
            self.update(job, status="running", step=step, progress=int(i * 100 / len(STEPS)), wait_reason=None)
            self.log(job, "iniciando", step=step)
            getattr(self, f"step_{step}")(job, ctx)
            done.append(step)
            self.update(job, completed_steps=done)
            if prod["mode"] == "assisted" and step in REVIEWABLE and step != STEPS[-1]:
                self.update(job, status="awaiting_review", wait_reason=f"Revise a etapa '{step}' no painel e aprove para continuar")
                return
        self.update(job, status="done", step=None, progress=100)

    def refresh(self, job, ctx):
        b = self.api.call("get_job", job_id=job["id"])
        ctx["prod"], ctx["scenes"], ctx["assets"] = b["production"], b.get("scenes") or [], b.get("assets") or []

    def step_analyze(self, job, ctx):
        if job.get("analysis_id"):
            return
        p = ctx["prod"]
        if not p.get("reference_id"):
            self.log(job, "produção sem vídeo de referência: o estilo virá só das suas escolhas", step="analyze")
            return
        ps = p.get("settings") or {}
        self.log(job, f"usando o DNA da referência já analisada (mídia: {'somente vídeos' if ps.get('video_only') else 'automática'}, legenda: {ps.get('caption_resolved') or ps.get('caption_style') or 'auto'})", step="analyze")

    def step_topic(self, job, ctx):
        if (ctx["prod"].get("topic") or "").strip():
            return
        self.update(job, status="waiting_api", wait_reason="IA sugerindo temas")
        ideas = self.api.call("ai_ideas", job_id=job["id"])["ideas"]
        if ideas:
            self.api.call("save_production", production_id=ctx["prod"]["id"], fields={"topic": ideas[0].get("title", "")})
        self.refresh(job, ctx)

    def step_script(self, job, ctx):
        if ctx["scenes"]:
            return
        self.update(job, status="waiting_api", wait_reason="IA escrevendo roteiro")
        self.api.call("ai_script", job_id=job["id"], topic=ctx["prod"].get("topic"))
        self.refresh(job, ctx)
        if not ctx["scenes"]:
            raise RuntimeError("roteiro sem cenas")

    def step_narration(self, job, ctx):
        v = ctx["settings"]["voice"]
        use_edge = (self.cfg.get("tts") or "edge") == "edge"
        if not use_edge and v["provider"] != "piper":
            raise media.MediaError("Somente Piper (local) ou Edge (Microsoft) estão implementados. Troque a voz para Piper em Configurações.")
        voice = Path(self.cfg["voices_dir"]) / f"{v['piper_voice']}.onnx"
        ps = ctx["prod"].get("settings") or {}
        edge_voice = ps.get("voice") or self.cfg.get("edge_voice") or "pt-BR-AntonioNeural"
        edge_rate = ps.get("voice_rate") or self.cfg.get("edge_rate") or "+0%"
        # Voz clonada do banco de vozes
        clone, cv = None, ctx.get("voice")
        if cv and cv.get("status") == "ready" and cv.get("sample_path"):
            import voice as vc
            el_key = ctx.get("elevenlabs_key") or self.cfg.get("elevenlabs_api_key")
            if el_key:
                try:
                    sample = ctx["work"] / "clone_sample.wav"
                    r = requests.get(self.api.call("download_url", path=cv["sample_path"])["url"], timeout=120)
                    r.raise_for_status()
                    sample.write_bytes(r.content)
                    clone = ("eleven", el_key, vc.eleven_voice(el_key, sample, cv["name"], Path(self.cfg["work_dir"])))
                    self.log(job, f"narrando com a voz clonada '{cv['name']}' na ElevenLabs (nuvem)", step="narration")
                except Exception as e:
                    clone = None
                    self.log(job, f"ElevenLabs falhou ({e}); usando voz grátis", "warn", step="narration")
            if clone:
                pass
            elif vc.engine():
                clone = ctx["work"] / "clone_sample.wav"
                r = requests.get(self.api.call("download_url", path=cv["sample_path"])["url"], timeout=120)
                r.raise_for_status()
                clone.write_bytes(r.content)
                self.log(job, f"narrando com a voz clonada '{cv['name']}'", step="narration")
            else:
                edge_rate = vc.edge_rate_for((cv.get("stats") or {}).get("wpm"))
                self.log(job, f"clonagem não instalada no PC (rode install_voice_clone.bat). Usando voz Edge no ritmo da voz '{cv['name']}' ({edge_rate})", "warn", step="narration")
        import threading
        from concurrent.futures import ThreadPoolExecutor
        total_n, counter, lock = len(ctx["scenes"]), [0], threading.Lock()

        def narrate(sc):
            if not sc["narration"].strip():
                raise RuntimeError(f"cena {sc['idx'] + 1} sem narração")
            raw, wav = ctx["work"] / f"raw_{sc['idx']:03d}_{__import__('hashlib').md5((sc['narration'] + str(clone[2] if isinstance(clone, tuple) else clone) + edge_voice + str(edge_rate)).encode()).hexdigest()[:8]}.wav", ctx["work"] / f"voice_{sc['idx']:03d}.wav"
            done = raw.exists() and raw.stat().st_size > 1000
            if clone and not done:
                try:
                    import voice as vc
                    if isinstance(clone, tuple):
                        vc.eleven_tts(media.clean_tts(sc["narration"]), clone[1], clone[2], raw)
                    else:
                        vc.clone_tts(media.clean_tts(sc["narration"]), clone, raw)
                    done = True
                except Exception as e:
                    self.log(job, f"cena {sc['idx'] + 1}: clonagem falhou ({e}); usando Edge", "warn", step="narration")
            if not done and use_edge:
                try:
                    media.edge_tts(sc["narration"], edge_voice, raw, edge_rate)
                    done = True
                except media.MediaError as e:
                    self.log(job, f"Voz Edge falhou ({e}); usando Piper", "warn", step="narration")
            if not done:
                media.piper_tts(sc["narration"], voice, raw, v["length_scale"], v["noise_scale"], v["sentence_silence"])
            speech = media.duration(raw)
            total = media.scene_audio(raw, wav, sc.get("pause_after_ms") or 0)
            timings = media.aligned_timings(media.clean_tts(sc["narration"]), wav)
            self.api.call("update_scene", scene_id=sc["id"], fields={"audio_path": str(wav), "audio_duration_s": round(speech, 3), "duration_s": round(total, 3), "word_timings": timings, "status": "narrated"})
            sc.update(audio_path=str(wav), audio_duration_s=speech, duration_s=total, word_timings=timings)
            with lock:
                counter[0] += 1
                k = counter[0]
            print(f"  narração: cena {k} de {total_n} pronta", flush=True)
            self.update(job, progress=30 + int(10 * k / total_n), wait_reason=f"Narrando: {k} de {total_n} cenas prontas")

        # Edge (internet) aguenta várias cenas ao mesmo tempo; a clonagem usa a placa de vídeo, então vai uma por vez.
        workers = 1 if (clone and not isinstance(clone, tuple)) else int(self.cfg.get("narration_workers") or 4)
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(narrate, ctx["scenes"]))
        self.update(job, wait_reason=None)
        self._fit_duration(job, ctx)

    def _fit_duration(self, job, ctx):
        """Nunca injeta silêncio: ritmo de vídeo curto pede fala contínua. Só avisa se o roteiro ficou curto."""
        target = float((ctx["prod"].get("settings") or {}).get("target_seconds") or 0)
        total = sum(sc["duration_s"] for sc in ctx["scenes"])
        self.log(job, f"duração da narração: {total:.0f}s (alvo {target:.0f}s)", step="narration")
        if target and total < target * 0.85:
            self.log(job, f"o roteiro rende {total:.0f}s de {target:.0f}s pedidos. Para ficar maior, clique em 'Refazer roteiro'.", "warn", "narration")

    def step_visuals(self, job, ctx):
        ps = ctx["prod"].get("settings") or {}
        ref = ctx.get("source_reference")
        if ps.get("source_mode") == "reference":
            if not ref:
                raise media.MediaError("modo fatiador ligado, mas a produção não tem vídeo de referência escolhido")
            from slicer import slice_from_reference
            for sc in ctx["scenes"]:
                (ctx["work"] / f"img_{sc['idx']:03d}.jpg").unlink(missing_ok=True)
            if slice_from_reference(self, job, ctx, ref):
                return
        from visuals import pick_visuals
        pick_visuals(self, job, ctx)

    def step_scenes(self, job, ctx):
        """Monta os clipes em paralelo e reaproveita os que não mudaram desde a última renderização."""
        from concurrent.futures import ThreadPoolExecutor
        import hashlib
        fps, crf = ctx["settings"]["export"]["fps"], ctx["settings"]["export"]["crf"]
        todo, reused = [], 0
        ctx["job"] = job
        for sc in ctx["scenes"]:
            img, vid = ctx["work"] / f"img_{sc['idx']:03d}.jpg", ctx["work"] / f"vid_{sc['idx']:03d}.mp4"
            src = vid if vid.exists() else img
            dur = float(sc.get("duration_s") or 0)
            sig = hashlib.md5(f"{src.name}|{src.stat().st_size if src.exists() else 0}|{src.read_bytes()[:65536] if src.exists() else b''}|{dur:.3f}|{sc.get('motion')}|{(self._scene_plan(ctx, sc) or {}).get('motion', {}).get('value')}|{self._plan(ctx)['cut_seconds']['value'] if self._plan(ctx)['profile_used'] else ''}|{(ctx['prod'].get('settings') or {}).get('frame_mix')}|{ctx['w']}x{ctx['h']}|{fps}|{crf}|split2".encode()).hexdigest()
            out, mark = ctx["work"] / f"clip_{sc['idx']:03d}.mp4", ctx["work"] / f"clip_{sc['idx']:03d}.sig"
            if out.exists() and mark.exists() and mark.read_text() == sig:
                reused += 1
                continue
            todo.append((sc, mark, sig))
        workers = int(self.cfg.get("render_threads") or 3)
        import threading
        lock, cnt = threading.Lock(), [0]
        def one(t):
            self._clip(ctx, t[0], fps, crf)
            t[1].write_text(t[2])
            with lock:
                cnt[0] += 1
                k = cnt[0]
            print(f"[scenes] clipe {k} de {len(todo)}")
            try:
                self.update(job, wait_reason=f"Montando clipes: {k} de {len(todo)} prontos")
            except Exception:
                pass
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(one, todo))
        self.update(job, wait_reason=None)
        self.log(job, f"{len(todo)} clipes montados, {reused} reaproveitados", step="scenes")

    def _plan(self, ctx):
        """Plano de estilo v2 (Fase 3). Sem perfil v2, profile_used=False e o caminho antigo segue intacto."""
        from style_apply import resolve_plan, structured_of
        key = tuple((sc.get("idx"), sc.get("status"), sc.get("motion"), sc.get("transition")) for sc in ctx["scenes"])
        if ctx.get("_plan_key") != key:
            ctx["plan"] = resolve_plan(structured_of(ctx["prod"].get("style_profiles")), ctx["prod"].get("settings") or {}, ctx["scenes"])
            ctx["_plan_key"] = key
        return ctx["plan"]

    def _scene_plan(self, ctx, sc):
        plan = self._plan(ctx)
        if not plan["profile_used"]:
            return None
        return next((x for x in plan["scenes"] if x["idx"] == sc.get("idx")), None)

    def _clip(self, ctx, sc, fps, crf):
        img = Path(ctx["work"] / f"img_{sc['idx']:03d}.jpg")
        vid = Path(ctx["work"] / f"vid_{sc['idx']:03d}.mp4")
        dur = float(sc.get("duration_s") or media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav"))
        out = ctx["work"] / f"clip_{sc['idx']:03d}.mp4"
        ps = ctx["prod"].get("settings") or {}
        mix = [f for f in (ps.get("frame_mix") or []) if f in media.FRAME_RATIOS]
        if not mix and ctx["h"] > ctx["w"]:
            mix = ["9:16", "16:9", "9:16", "1:1"]  # sem DNA de proporções: alterna para não ficar monótono
        frame = sc.get("frame") or (mix[sc["idx"] % len(mix)] if mix else None)
        if vid.exists():
            cut = float(ps.get("cut_seconds") or 0)
            if self._plan(ctx)["profile_used"]:
                cut = float(self._plan(ctx)["cut_seconds"]["value"] or 0)
            pieces, why = media.video_clip(vid, dur, ctx["w"], ctx["h"], fps, out, crf, cut, frame)
            ctx.setdefault("split_log", {})[sc["idx"]] = {"pieces": [round(p, 3) for p in pieces], "reason": why}
            if cut:
                self.log(ctx.get("job") or {}, f"cena {sc['idx'] + 1}: {why} → {[round(p, 2) for p in pieces]}", step="render")
            return
        if not img.exists():
            raise media.MediaError(f"imagem da cena {sc['idx'] + 1} ausente")
        km = (ctx["prod"].get("settings") or {}).get("kit_motion") or {}
        mv = km["main_move"] if km.get("main_move") in media.MOTIONS and (km.get("moving_share") or 0) >= 0.4 else (sc.get("motion") or "zoom_in")
        sp = self._scene_plan(ctx, sc)
        if sp:
            mv = sp["motion"]["value"]
        media.scene_clip(img, dur, ctx["w"], ctx["h"], fps, mv, out, crf, frame)

    def step_captions(self, job, ctx):
        cues, t = [], 0.0
        for sc in ctx["scenes"]:
            wav = ctx["work"] / f"voice_{sc['idx']:03d}.wav"
            total = media.duration(wav)
            speech = float(sc.get("audio_duration_s") or total)
            cues += media.aligned_timings(media.clean_tts(sc["narration"]), wav, start=t)
            t += total
        ps = ctx["prod"].get("settings") or {}
        plan = self._plan(ctx)
        if plan["profile_used"]:
            cap = plan["caption"]["value"]
            if cap.get("style") == "none" and ps.get("caption_style") != "none":
                cap = {**cap, "style": "hormozi"}  # legenda ligada por padrão
            if cap.get("style") == "none":
                (ctx["work"] / "subs.ass").unlink(missing_ok=True)
                self.log(job, "sem legenda (escolha sua)", step="captions")
                return
            media.write_ass(cues, ctx["w"], ctx["h"], ctx["work"] / "subs.ass", style=cap.get("style") if cap.get("style") != "clone" else "hormozi", clone=cap.get("clone"))
            self.log(job, f"legenda: {cap.get('style')} ({plan['caption']['source']}/{plan['caption']['basis']}) {plan['caption']['note']}", step="captions")
            return
        if ps.get("caption_style") == "none":
            (ctx["work"] / "subs.ass").unlink(missing_ok=True)
            self.log(job, "sem legenda (escolha sua)", step="captions")
            return
        media.write_ass(cues, ctx["w"], ctx["h"], ctx["work"] / "subs.ass", style=ps.get("caption_resolved") or ps.get("caption_style") or "hormozi",
                        clone=ps.get("caption_clone") if ps.get("caption_style") == "clone" else None)

    def step_audio(self, job, ctx):
        files = [ctx["work"] / f"voice_{sc['idx']:03d}.wav" for sc in ctx["scenes"]]
        media.concat(files, ctx["work"] / "voice.wav", ctx["work"], audio=True)

    def step_render(self, job, ctx):
        self.update(job, status="rendering", wait_reason="FFmpeg renderizando")
        t0 = time.time()
        clips = [ctx["work"] / f"clip_{sc['idx']:03d}.mp4" for sc in ctx["scenes"]]
        import fx
        durs = [media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav") for sc in ctx["scenes"]]
        kps = ctx["prod"].get("settings") or {}
        plan = self._plan(ctx)
        self.log(job, __import__("style_apply").summary(plan) if plan["profile_used"] else "plano de estilo — sem perfil v2: caminho legado", step="render")
        if plan["profile_used"]:
            for lim in plan["limitations"]:
                self.log(job, f"limitação: {lim}", step="render")
        if plan["profile_used"]:
            trans = [x["transition"]["value"] for x in plan["scenes"]]
        elif kps.get("kit_transitions"):
            trans = fx.clone_transitions(kps["kit_transitions"], len(ctx["scenes"]))
            self.log(job, f"transições clonadas da referência: {', '.join(sorted(set(trans)))}", step="render")
        else:
            trans = [sc.get("transition") or "cut" for sc in ctx["scenes"]]
        fx.transitions(clips, durs, trans, ctx["work"] / "video.mp4", ctx["settings"]["export"]["fps"], ctx["settings"]["export"]["crf"])
        grade = media.COLOR_GRADES.get(kps.get("color_grade") or "none")
        if grade:
            try:
                g = ctx["work"] / "video_graded.mp4"
                media.run(["ffmpeg", "-y", "-i", str(ctx["work"] / "video.mp4"), "-vf", grade, "-c:v", "libx264", "-preset", "veryfast", "-crf", str(ctx["settings"]["export"]["crf"]), "-pix_fmt", "yuv420p", "-an", str(g)])
                g.replace(ctx["work"] / "video.mp4")
                self.log(job, f"filtro de cor clonado da referência: {kps['color_grade']}", step="render")
            except media.MediaError as err:
                self.log(job, f"filtro de cor ignorado: {err}", "warn", step="render")
        cache = Path(self.cfg.get("cache_dir") or ROOT / "cache")
        sfx = None
        if ((ctx["prod"].get("settings") or {}).get("sfx") or "on") == "off":
            self.log(job, "sem efeitos sonoros (escolha sua)", step="render")
        else:
          try:
            kps = ctx["prod"].get("settings") or {}
            kit, ref_s = kps.get("kit_sfx"), kps.get("kit_sfx_ref_s")
            if plan["profile_used"]:
                sv = plan["sfx"]["value"]
                kit, ref_s = (sv.get("kit"), sv.get("ref_s")) if sv["mode"] == "kit" else (None, None)
            sfx = fx.sfx_track(ctx["scenes"], durs, cache / "sfx", ctx["work"] / "sfx.wav", sum(durs), kit, ref_s)
            if kps.get("kit_sfx"):
                self.log(job, f"efeitos sonoros clonados da referência ({len(kps['kit_sfx'])} marcas)", step="render")
          except media.MediaError as err:
            self.log(job, f"efeitos sonoros ignorados: {err}", "warn", step="render")
        out_dir = Path(ctx["settings"]["export"].get("output_dir") or self.cfg["output_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in ctx["prod"]["title"])[:60].strip() or "video"
        tmp = ctx["work"] / "final.mp4"
        mood = (ctx["prod"].get("settings") or {}).get("music_mood") or "auto"
        if mood == "auto":
            mood = fx.guess_mood(ctx["prod"].get("topic") or ctx["prod"].get("title") or "", ctx["scenes"])
            self.log(job, f"clima escolhido automaticamente: {mood}", step="render")
        kit_music = (ctx["prod"].get("settings") or {}).get("music_path")
        music = None if mood == "none" else (pick_music(self.cfg, mood) if any((Path(self.cfg.get("music_dir") or ROOT / "music") / mood).glob("*.*")) else None)
        if mood != "none" and not music:
            m = fx.online_music(mood, cache / "music", lambda t: self.log(job, t, step="render"))
            music = str(m) if m else pick_music(self.cfg, mood)
        if kit_music:
            try:
                dst = ctx["work"] / "kit_music.mp3"
                if not dst.exists():
                    r = requests.get(self.api.call("download_url", path=kit_music)["url"], timeout=120)
                    r.raise_for_status()
                    dst.write_bytes(r.content)
                music = str(dst)
            except Exception as err:
                self.log(job, f"não consegui baixar a música do kit: {err}", "warn", step="render")
        if music:
            self.log(job, f"música: {Path(music).name}", step="render")
        e = ctx["settings"]["export"]
        media.final_mix(ctx["work"] / "video.mp4", ctx["work"] / "voice.wav", "subs.ass" if (ctx["work"] / "subs.ass").exists() else None, tmp, ctx["work"], Path(music) if music else None, e["music_volume_db"], e["voice_target_lufs"], e["crf"], sfx)
        final = out_dir / f"{safe} - {ctx['prod']['aspect'].replace(':', 'x')} - {time.strftime('%Y%m%d-%H%M')}.mp4"
        final.write_bytes(tmp.read_bytes())
        ctx["final"] = final
        self.api.call("save_production", production_id=ctx["prod"]["id"], fields={"output_path": str(final), "status": "rendered"})
        self.log(job, f"vídeo salvo em {final}", step="render")
        print(f"  vídeo salvo em: {final}")
        try:
            n = len(ctx["prod"].get("versions") or []) + 1
            up = self.api.call("upload_url", name=f"videos/{ctx['prod']['id']}-v{n}.mp4")
            with open(final, "rb") as fh:
                r = requests.put(up["signed_url"], data=fh, headers={"Content-Type": "video/mp4", "x-upsert": "true"}, timeout=1800)
            r.raise_for_status()
            ver = {"n": n, "preview_path": up["path"], "output_path": str(final), "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "duration_s": round(media.duration(final), 2), "render_s": round(time.time() - t0, 1)}
            versions = (list(ctx["prod"].get("versions") or []) + [ver])[-20:]
            self.api.call("save_production", production_id=ctx["prod"]["id"], fields={"preview_path": up["path"], "versions": versions})
            ctx["prod"]["versions"] = versions
            self.log(job, "vídeo enviado ao site", step="render")
        except Exception as e:  # o arquivo local continua válido
            self.log(job, f"falha ao enviar vídeo ao site: {e}", "warn", "render")

    def step_validate(self, job, ctx):
        final = ctx.get("final") or Path(ctx["prod"].get("output_path") or "")
        expected = sum(media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav") for sc in ctx["scenes"])
        rep = media.validate(Path(final), expected, ctx["w"], ctx["h"])
        imgs = [sc.get("asset_id") for sc in ctx["scenes"] if sc.get("asset_id")]
        if imgs and len(set(imgs)) < len(imgs) * 0.6:
            rep["issues"].append("imagens repetidas em excesso")
        rep["scenes"] = len(ctx["scenes"])
        if rep["ok"]:
            try:
                rep["audit"] = self._audit_and_repair(job, ctx)
                final = ctx.get("final") or final
            except Exception as err:  # auditoria nunca derruba um vídeo válido
                rep["audit_error"] = str(err)[:300]
                self.log(job, f"auditoria não concluída: {err}", "warn", "validate")
        self.api.call("save_production", production_id=ctx["prod"]["id"], fields={"validation": rep, "status": "done" if rep["ok"] else "needs_attention"})
        self.log(job, "validação OK" if rep["ok"] else "problemas: " + "; ".join(rep["issues"]), "info" if rep["ok"] else "warn", "validate")
        if not rep["ok"]:
            # Nunca marcar como concluído sem um MP4 válido confirmado.
            raise media.MediaError("vídeo final reprovado na validação: " + "; ".join(rep["issues"]))

    def _audit_and_repair(self, job, ctx, max_attempts: int = 2):
        """Fase 4: mede o MP4 final, compara com a referência/plano e re-renderiza SÓ as cenas com defeito
        (o cache de clipes reaproveita as demais). No máximo max_attempts; o resultado de cada tentativa é registrado."""
        import audit as au
        import forensics
        from style_apply import structured_of
        ref = structured_of(ctx["prod"].get("style_profiles"))
        durs = [media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav") for sc in ctx["scenes"]]
        words = sum(len((sc.get("narration") or "").split()) for sc in ctx["scenes"])
        repairs = []
        for attempt in range(max_attempts + 1):
            final = Path(ctx["final"])
            out = forensics.analyze(final)
            rep = au.audit(ref, out, self._plan(ctx), durs, ctx.get("split_log"), au.black_intervals(final), words)
            if not rep["failing_scenes"] or attempt == max_attempts:
                break
            bad = rep["failing_scenes"]
            self.log(job, f"auditoria: cena(s) {', '.join(str(i + 1) for i in bad)} com defeito — re-renderizando só elas (tentativa {attempt + 1})", "warn", "validate")
            for i in bad:
                (ctx["work"] / f"clip_{i:03d}.sig").unlink(missing_ok=True)
                (ctx["work"] / f"clip_{i:03d}.mp4").unlink(missing_ok=True)
            self.step_scenes(job, ctx)
            self.step_render(job, ctx)
            repairs.append({"attempt": attempt + 1, "scenes": bad})
        rep["repairs"] = repairs
        if repairs:
            rep["repair_result"] = "resolvido" if not rep["failing_scenes"] else "persistente"
        s = rep["summary"]
        self.log(job, f"aderência técnica: {s['pass']} dentro, {s['deviation']} fora, {s['not_verified']} não verificadas"
                 + (f"; cenas ainda com defeito: {[i + 1 for i in rep['failing_scenes']]}" if rep["failing_scenes"] else ""), step="validate")
        return rep


def cleanup(cfg: dict) -> None:
    """Faxina: apaga do PC o que tem mais de N horas (padrão 24). O vídeo continua salvo no site."""
    hours = float(cfg.get("cleanup_hours", 24) or 0)
    if hours <= 0:
        return
    limit = time.time() - hours * 3600
    dirs = [Path(cfg["work_dir"]), Path(cfg.get("cache_dir") or ROOT / "cache") / "base", Path(cfg["output_dir"])]
    freed = 0
    for d in dirs:
        if not d.exists():
            continue
        for p in d.iterdir():
            try:
                newest = max([p.stat().st_mtime] + ([f.stat().st_mtime for f in p.rglob("*")] if p.is_dir() else []))
                if newest >= limit:
                    continue
                size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size
                shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
                freed += size
            except OSError:
                pass
    if freed:
        print(f"  faxina: {freed / 1e6:.0f} MB de arquivos com mais de {hours:g}h apagados")


def pick_music(cfg: dict, mood: str) -> str | None:
    """Escolhe uma música da pasta music/<clima>/ (ou de qualquer subpasta em 'auto')."""
    if mood == "none":
        return None
    base = Path(cfg.get("music_dir") or ROOT / "music")
    exts = (".mp3", ".wav", ".m4a", ".ogg")
    folder = base / mood if mood != "auto" else base
    files = [p for p in folder.rglob("*") if p.suffix.lower() in exts] if folder.exists() else []
    if not files and mood != "auto" and base.exists():
        files = [p for p in base.rglob("*") if p.suffix.lower() in exts]
    return str(random.choice(files)) if files else cfg.get("music_path") or None


def check(cfg: dict) -> None:
    print("FFmpeg:", media.require_tools()["ffmpeg"])
    try:
        import piper  # noqa: F401
        print("Piper: instalado")
    except ImportError:
        print("Piper: NÃO instalado (pip install -r requirements.txt)")
    voices = sorted(p.name for p in Path(cfg["voices_dir"]).glob("*.onnx"))
    print("Vozes:", voices or "nenhuma — rode install_windows.bat")
    print("Pexels:", "configurado" if cfg.get("pexels_api_key") else "não configurado (usará arquivos enviados ou fundo neutro)")
    print("Pixabay:", "configurado" if cfg.get("pixabay_api_key") else "não configurado")
    r = Api(cfg["api_url"], cfg["token"]).call("heartbeat", info=info())
    print("Painel: conectado" if r.get("ok") else r)


def info() -> dict:
    return {"versao": VERSION, "sistema": f"{platform.system()} {platform.release()}", "python": platform.python_version()}


def main():
    cfg = load_config()
    if "--check" in sys.argv:
        return check(cfg)
    media.require_tools()
    api = Api(cfg["api_url"], cfg["token"])
    runner = Runner(api, cfg)
    print(f"Agente {VERSION} conectado a {cfg['api_url']}. Ctrl+C para parar.")
    last_beat = 0.0
    last_clean = 0.0
    while True:
        try:
            if time.time() - last_clean > 3600:
                cleanup(cfg)
                last_clean = time.time()
            if time.time() - last_beat > 30:
                api.call("heartbeat", info=info())
                last_beat = time.time()
            r = api.call("claim")
            if r.get("job"):
                job = r["job"]
                print(f"Trabalho {job['id']} ({job['type']})")
                runner.run(job, r)
                continue
        except SystemExit:
            raise
        except Exception as e:
            print("Erro de comunicação:", e)
        time.sleep(5)


if __name__ == "__main__":
    main()
