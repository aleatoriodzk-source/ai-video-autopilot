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
            if job["type"] == "analyze_reference":
                self.analyze_reference(job, bundle)
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

    # ---------- análise de referência ----------
    def analyze_reference(self, job, bundle):
        from analyzer import collect_reference
        ref = bundle["reference"]
        kind = (bundle.get("analysis") or {}).get("kind", "channel")
        self.update(job, status="waiting_download", step="analyze", progress=10, wait_reason="baixando referência")
        work = Path(self.cfg["work_dir"]) / f"ref_{ref['id']}"
        collected, frames = collect_reference(ref["urls"], kind, work, lambda m: self.log(job, m, step="analyze"),
                                             resolve=lambda path: self.api.call("download_url", path=path)["url"])
        self.api.call("save_collected", job_id=job["id"], collected=collected, title=collected.get("title"))
        self.update(job, status="waiting_api", progress=70, wait_reason="IA analisando estilo")
        self.api.call("ai_analyze", job_id=job["id"], collected=collected, frames=frames)
        self.update(job, status="done", progress=100, wait_reason=None, completed_steps=["analyze"])

    # ---------- produção ----------
    def production(self, job, bundle):
        settings = self.api.call("heartbeat", info=None)["settings"]
        prod, scenes = bundle["production"], bundle.get("scenes") or []
        done = list(job.get("completed_steps") or [])
        w, h = media.size_for(prod["aspect"], settings["export"]["resolution"])
        work = Path(self.cfg["work_dir"]) / prod["id"]
        work.mkdir(parents=True, exist_ok=True)
        ctx = {"settings": settings, "prod": prod, "scenes": scenes, "w": w, "h": h, "work": work, "assets": bundle.get("assets") or []}

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
        for n, sc in enumerate(ctx["scenes"]):
            if not sc["narration"].strip():
                raise RuntimeError(f"cena {sc['idx'] + 1} sem narração")
            raw, wav = ctx["work"] / f"raw_{sc['idx']:03d}.wav", ctx["work"] / f"voice_{sc['idx']:03d}.wav"
            done = False
            if use_edge:
                try:
                    media.edge_tts(sc["narration"], edge_voice, raw, edge_rate)
                    done = True
                except media.MediaError as e:
                    self.log(job, f"Voz Edge falhou ({e}); usando Piper", "warn", step="narration")
            if not done:
                media.piper_tts(sc["narration"], voice, raw, v["length_scale"], v["noise_scale"], v["sentence_silence"])
            speech = media.duration(raw)
            total = media.scene_audio(raw, wav, sc.get("pause_after_ms") or 0)
            timings = media.word_timings(media.clean_tts(sc["narration"]), speech)
            self.api.call("update_scene", scene_id=sc["id"], fields={"audio_path": str(wav), "audio_duration_s": round(speech, 3), "duration_s": round(total, 3), "word_timings": timings, "status": "narrated"})
            sc.update(audio_path=str(wav), audio_duration_s=speech, duration_s=total, word_timings=timings)
            self.update(job, progress=30 + int(10 * (n + 1) / len(ctx["scenes"])))
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
        for sc in ctx["scenes"]:
            img, vid = ctx["work"] / f"img_{sc['idx']:03d}.jpg", ctx["work"] / f"vid_{sc['idx']:03d}.mp4"
            src = vid if vid.exists() else img
            dur = float(sc.get("duration_s") or 0)
            sig = hashlib.md5(f"{src.name}|{src.stat().st_size if src.exists() else 0}|{src.read_bytes()[:65536] if src.exists() else b''}|{dur:.3f}|{sc.get('motion')}|{ctx['w']}x{ctx['h']}|{fps}|{crf}".encode()).hexdigest()
            out, mark = ctx["work"] / f"clip_{sc['idx']:03d}.mp4", ctx["work"] / f"clip_{sc['idx']:03d}.sig"
            if out.exists() and mark.exists() and mark.read_text() == sig:
                reused += 1
                continue
            todo.append((sc, mark, sig))
        workers = int(self.cfg.get("render_threads") or 3)
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(lambda t: (self._clip(ctx, t[0], fps, crf), t[1].write_text(t[2])), todo))
        self.log(job, f"{len(todo)} clipes montados, {reused} reaproveitados", step="scenes")

    def _clip(self, ctx, sc, fps, crf):
        img = Path(ctx["work"] / f"img_{sc['idx']:03d}.jpg")
        vid = Path(ctx["work"] / f"vid_{sc['idx']:03d}.mp4")
        dur = float(sc.get("duration_s") or media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav"))
        out = ctx["work"] / f"clip_{sc['idx']:03d}.mp4"
        if vid.exists():
            media.video_clip(vid, dur, ctx["w"], ctx["h"], fps, out, crf)
            return
        if not img.exists():
            raise media.MediaError(f"imagem da cena {sc['idx'] + 1} ausente")
        media.scene_clip(img, dur, ctx["w"], ctx["h"], fps, sc.get("motion") or "zoom_in", out, crf)

    def step_captions(self, job, ctx):
        cues, t = [], 0.0
        for sc in ctx["scenes"]:
            wav = ctx["work"] / f"voice_{sc['idx']:03d}.wav"
            total = media.duration(wav)
            speech = float(sc.get("audio_duration_s") or total)
            cues += media.word_timings(media.clean_tts(sc["narration"]), speech, start=t)
            t += total
        ps = ctx["prod"].get("settings") or {}
        media.write_ass(cues, ctx["w"], ctx["h"], ctx["work"] / "subs.ass", style=ps.get("caption_resolved") or ps.get("caption_style") or "hormozi")

    def step_audio(self, job, ctx):
        files = [ctx["work"] / f"voice_{sc['idx']:03d}.wav" for sc in ctx["scenes"]]
        media.concat(files, ctx["work"] / "voice.wav", ctx["work"], audio=True)

    def step_render(self, job, ctx):
        self.update(job, status="rendering", wait_reason="FFmpeg renderizando")
        t0 = time.time()
        clips = [ctx["work"] / f"clip_{sc['idx']:03d}.mp4" for sc in ctx["scenes"]]
        import fx
        durs = [media.duration(ctx["work"] / f"voice_{sc['idx']:03d}.wav") for sc in ctx["scenes"]]
        trans = [sc.get("transition") or "cut" for sc in ctx["scenes"]]
        fx.transitions(clips, durs, trans, ctx["work"] / "video.mp4", ctx["settings"]["export"]["fps"], ctx["settings"]["export"]["crf"])
        cache = Path(self.cfg.get("cache_dir") or ROOT / "cache")
        sfx = None
        try:
            sfx = fx.sfx_track(ctx["scenes"], durs, cache / "sfx", ctx["work"] / "sfx.wav", sum(durs))
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
        music = None if mood == "none" else (pick_music(self.cfg, mood) if any((Path(self.cfg.get("music_dir") or ROOT / "music") / mood).glob("*.*")) else None)
        if mood != "none" and not music:
            m = fx.online_music(mood, cache / "music", lambda t: self.log(job, t, step="render"))
            music = str(m) if m else pick_music(self.cfg, mood)
        if music:
            self.log(job, f"música: {Path(music).name}", step="render")
        e = ctx["settings"]["export"]
        media.final_mix(ctx["work"] / "video.mp4", ctx["work"] / "voice.wav", "subs.ass", tmp, ctx["work"], Path(music) if music else None, e["music_volume_db"], e["voice_target_lufs"], e["crf"], sfx)
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
        self.api.call("save_production", production_id=ctx["prod"]["id"], fields={"validation": rep, "status": "done" if rep["ok"] else "needs_attention"})
        self.log(job, "validação OK" if rep["ok"] else "problemas: " + "; ".join(rep["issues"]), "info" if rep["ok"] else "warn", "validate")
        if not rep["ok"]:
            # Nunca marcar como concluído sem um MP4 válido confirmado.
            raise media.MediaError("vídeo final reprovado na validação: " + "; ".join(rep["issues"]))


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
    while True:
        try:
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
