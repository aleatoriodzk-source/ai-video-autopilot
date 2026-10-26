"""Ponta a ponta (sem banco real): vídeo sintético → forense v2 → gravação com legado (TS) → associação à
produção (TS) → bundle → plano v2 no Runner real → MP4 → ffprobe + forense do resultado.
Os números esperados vêm dos tempos conhecidos do vídeo sintético; falhas são reportadas, não ajustadas."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

import forensics
import media
from agent import Runner
from test_forensics import make_reference

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("bun")), reason="FFmpeg/bun ausentes")
N, VOICE_S = 6, 3.5
VIDEO_SCENES = {0, 2, 4}


class FakeApi:
    """Responde como /api/public/agent, em memória. Registra tudo o que o agente envia."""
    def __init__(self, out_dir):
        self.calls, self.logs, self.out_dir = [], [], out_dir

    def call(self, action, **kw):
        self.calls.append((action, kw))
        if action == "heartbeat":
            return {"settings": {"export": {"resolution": "720p", "fps": 30, "crf": 23, "music_volume_db": -18, "voice_target_lufs": -14, "output_dir": str(self.out_dir)}}}
        if action == "update_job":
            return {"job": {"status": kw["patch"].get("status") or "running", **kw["patch"]}}
        if action == "log":
            self.logs.append(kw["message"])
        if action == "upload_url":
            raise RuntimeError("upload desligado no teste")
        return {"ok": True}


def _ff(*a):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *a], check=True)


@pytest.fixture(scope="module")
def e2e(tmp_path_factory):
    d = tmp_path_factory.mktemp("e2e")
    # 1) referência sintética + forense
    ref = forensics.analyze(make_reference(d / "ref.mp4"))
    scenes = [{"idx": i, "narration": f"frase numero {i} do teste", "duration_s": VOICE_S, "status": "ready", "motion": None, "transition": None, "sfx": ""} for i in range(N)]
    legacy = {"tone": "energético", "captions": {"position": "bottom", "color_hex": "#FFFFFF"}, "pacing": {"cuts_per_min": 30}}
    (d / "in.json").write_text(json.dumps({"collected": {"videos": [{"title": "ref", "structured": ref}]}, "legacy": legacy, "scenes": scenes}))
    # 2-4) gravação + associação + bundle (código TS do servidor)
    p = subprocess.run(["bun", "scripts/e2e-style-link.ts", str(d / "in.json"), str(d / "out.json")], cwd=ROOT, capture_output=True, text=True)
    assert p.returncode == 0, p.stderr
    ts = json.loads((d / "out.json").read_text())
    # 5) mídia pronta (pula TTS/busca, que dependem de rede): voz = tom, cenas de vídeo e de imagem
    prod = ts["bundle"]["production"]
    work = d / "work" / prod["id"]
    work.mkdir(parents=True)
    for i in range(N):
        _ff("-f", "lavfi", "-i", f"sine=frequency={300 + 40 * i}:duration={VOICE_S}", "-ar", "48000", "-ac", "1", str(work / f"voice_{i:03d}.wav"))
        if i in VIDEO_SCENES:
            _ff("-f", "lavfi", "-i", f"testsrc2=s=1280x720:r=30:d=8,hue=H=t*0.8", "-pix_fmt", "yuv420p", str(work / f"vid_{i:03d}.mp4"))
        else:
            _ff("-f", "lavfi", "-i", f"mandelbrot=s=1080x1920", "-frames:v", "1", str(work / f"img_{i:03d}.jpg"))
    api = FakeApi(d / "out")
    job = {"id": "job-e2e", "production_id": prod["id"], "completed_steps": ["analyze", "topic", "script", "narration", "visuals"]}
    runner = Runner(api, {"work_dir": str(d / "work"), "output_dir": str(d / "out"), "cache_dir": str(d / "cache")})
    runner.production(job, ts["bundle"])
    finals = list((d / "out").glob("*.mp4"))
    assert finals, "nenhum MP4 final"
    return {"ref": ref, "ts": ts, "api": api, "final": finals[0], "out": forensics.analyze(finals[0]), "probe": forensics.probe(finals[0]), "work": work}


def test_profile_persisted_with_legacy(e2e):
    c = e2e["ts"]["checks"]
    assert c["has_structured"] and c["legacy_kept"]


def test_link_only_same_user_same_reference(e2e):
    c = e2e["ts"]["checks"]
    assert c["link"] == {"styleId": "style-target", "reason": "matched"}
    assert c["ambiguous_reason"] == "ambiguous"


def test_agent_logged_v2_loaded_and_applied(e2e):
    logs = e2e["api"].logs
    assert any(l.startswith("perfil v2: carregado — style_id=style-target, associação=matched (gravada)") for l in logs), logs
    assert any(l.startswith("aplicado do perfil:") and "cut_seconds=2.25" in l for l in logs), logs
    assert not any("%" in l for l in logs if l.startswith(("perfil v2", "aplicado do perfil")))


def test_final_mp4_integrity(e2e):
    pr = e2e["probe"]
    assert (pr["w"], pr["h"]) == (720, 1280)
    assert pr["has_audio"]
    assert abs(pr["duration"] - N * VOICE_S) < 0.6, pr["duration"]
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(e2e["final"]), "-f", "null", "-"], capture_output=True, text=True)
    assert r.stderr.strip() == "", r.stderr[:500]


def test_no_black_frames(e2e):
    r = subprocess.run(["ffmpeg", "-i", str(e2e["final"]), "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"], capture_output=True, text=True)
    assert "black_start" not in r.stderr, [l for l in r.stderr.splitlines() if "black_start" in l]


def _shot_starts(e2e):
    return [e["start_s"] for e in e2e["out"]["timeline"] if e["kind"] == "shot"]


def test_param_received_vs_applied_in_mp4(e2e):
    """Recebido (log/plano) ≠ aplicado: confere os cortes MEDIDOS no MP4 final, cena a cena."""
    recv = [l for l in e2e["api"].logs if l.startswith("cena ") and "planos" in l]
    assert len(recv) == len(VIDEO_SCENES), e2e["api"].logs
    starts = _shot_starts(e2e)
    for i in VIDEO_SCENES:
        want = i * VOICE_S + 2.25
        assert any(abs(c - want) < 0.2 for c in starts), ("corte interno ausente no MP4", want, starts)
    for i in set(range(N)) - VIDEO_SCENES:  # cenas de imagem: sem corte interno
        inner = [c for c in starts if i * VOICE_S + 0.3 < c < (i + 1) * VOICE_S - 0.3]
        assert not inner, (i, inner)


def test_shot_durations_in_mp4(e2e):
    """Distribuição dos planos medida no MP4: vídeo = 2,25 + 1,25; imagem = 3,5; fronteiras de cena preservadas."""
    sh = [(e["start_s"], round(e["end_s"] - e["start_s"], 2)) for e in e2e["out"]["timeline"] if e["kind"] == "shot"]
    for i in range(N):
        t0 = i * VOICE_S
        assert any(abs(s - t0) < 0.2 for s, _ in sh), ("fronteira de cena perdida", t0, sh)
        got = [d for s, d in sh if t0 - 0.2 < s < t0 + VOICE_S - 0.2]
        want = [2.25, 1.25] if i in VIDEO_SCENES else [3.5]
        assert len(got) == len(want) and all(abs(g - w) < 0.2 for g, w in zip(got, want)), (i, got, want)


def _pcm(path, hp=None):
    import numpy as np
    af = ["-af", f"highpass=f={hp},highpass=f={hp}"] if hp else []
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), *af, "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.float32)


def _env_db(x, win=2400):
    import numpy as np
    n = len(x) // win
    return 20 * np.log10(np.sqrt((x[: n * win].reshape(n, win) ** 2).mean(1)) + 1e-9)  # 50 ms


def test_sfx_audible_in_final_mix(e2e):
    """Whoosh é gradual (sem pico brusco): mede energia acima de 1 kHz (a voz-tom de teste fica em 300–500 Hz; a
    faixa sfx.wav medida tem pico -22 dBFS acima de 1 kHz e só -30 dBFS acima de 3 kHz, então 3 kHz subestima)
    em janelas de 50 ms. Onde a faixa sfx.wav planejada tem som, o MP4 final deve ter agudos bem acima da base."""
    import numpy as np
    sfx = e2e["work"] / "sfx.wav"
    assert sfx.exists(), "faixa de SFX não foi gerada"
    plan = _env_db(_pcm(sfx))
    final = _env_db(_pcm(e2e["final"], hp=1000))
    n = min(len(plan), len(final))
    plan, final = plan[:n], final[:n]
    on = plan > plan.max() - 20
    assert on.any()
    base = np.median(final[~on])
    marks = []
    for k in np.flatnonzero(np.diff(np.r_[0, on.astype(int)]) == 1):
        seg = final[k: k + int(on[k:].argmin() or n - k)]
        marks.append({"t": round(k * 0.05, 2), "peak_db": round(float(seg.max()), 1), "rise_db": round(float(seg.max() - base), 1)})
        marks[-1]["t"] = float(marks[-1]["t"])
    print("\nSFX_AUDIO " + json.dumps({"base_hf_db": round(float(base), 1), "marks": marks}))
    assert marks and all(m["rise_db"] >= 12 and m["peak_db"] > -45 for m in marks), marks


def _frame(path, t):
    import numpy as np
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-ss", f"{t:.3f}", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True)
    return np.frombuffer(r.stdout, dtype=np.uint8).reshape(1280, 720, 3).astype(int)


def _cues(ass):
    import re
    out = []
    for l in ass.read_text(encoding="utf-8").splitlines():
        if l.startswith("Dialogue:"):
            f = l.split(",", 9)
            ts = lambda v: sum(float(x) * m for x, m in zip(v.split(":"), (3600, 60, 1)))
            out.append((ts(f[1]), ts(f[2]), re.sub(r"\{[^}]*\}", "", f[9]).strip()))
    return out


def test_captions_visible_positioned_legible(e2e):
    """Inspeção de quadros: compara o MP4 final com o vídeo antes da queima (video.mp4). A diferença localiza a
    legenda; mede posição vertical, contraste texto/contorno e lê o texto por OCR (tesseract, local)."""
    import numpy as np
    import pytesseract
    from PIL import Image
    pre, ass = e2e["work"] / "video.mp4", e2e["work"] / "subs.ass"
    assert pre.exists() and ass.exists()
    style = next(l for l in ass.read_text(encoding="utf-8").splitlines() if l.startswith("Style:")).split(",")
    align, margin_v = int(style[18]), int(style[21])
    cues = _cues(ass)
    rep, ok_ocr = [], 0
    for a, b, text in cues:
        t = (a + b) / 2
        f1, f0 = _frame(e2e["final"], t), _frame(pre, t)
        mask = np.abs(f1 - f0).sum(2) > 90
        rows = np.flatnonzero(mask.sum(1) > 6)
        assert rows.size, ("legenda não aparece no quadro", t, text)
        y0, y1 = rows.min(), rows.max()
        cols = np.flatnonzero(mask[y0:y1 + 1].sum(0) > 0)
        reg = f1[y0:y1 + 1, cols.min():cols.max() + 1]
        lum = reg.mean(2)
        bright, dark = (lum > 200).mean(), (lum < 50).mean()
        crop = Image.fromarray(np.where(lum > 180, 0, 255).astype(np.uint8)).resize((reg.shape[1] * 2, reg.shape[0] * 2))
        ocr = pytesseract.image_to_string(crop, config="--psm 7").upper()
        hit = any(w in ocr for w in text.upper().split() if len(w) > 3)
        ok_ocr += hit
        rep.append({"t": round(t, 2), "text": text, "y": [int(y0), int(y1)], "bright": round(float(bright), 2), "dark": round(float(dark), 2), "ocr": ocr.strip()})
    print("\nCAPTIONS " + json.dumps(rep, ensure_ascii=False))
    for r in rep:
        if align in (1, 2, 3):  # ancorada embaixo: base do texto perto de h - MarginV
            assert abs(r["y"][1] - (1280 - margin_v)) < 1280 * 0.08, (r, margin_v)
        assert r["y"][1] - r["y"][0] < 1280 * 0.25, ("legenda cobre a tela", r)
        assert r["bright"] > 0.05 and r["dark"] > 0.05, ("sem contraste texto/contorno", r)
    assert ok_ocr >= len(cues) * 0.6, (ok_ocr, len(cues))


def test_report_measured_output(e2e):
    """Não é asserção de fidelidade: imprime métricas medidas do MP4 final vs. referência."""
    o, r = e2e["out"], e2e["ref"]
    shots = [round(e["end_s"] - e["start_s"], 2) for e in o["timeline"] if e["kind"] == "shot"]
    rep = {"ref_avg_shot_s": r["metrics"]["avg_shot_s"]["value"], "out_avg_shot_s": o["metrics"]["avg_shot_s"]["value"], "out_shots_s": shots,
           "ref_cuts_per_min": r["metrics"]["cuts_per_min"]["value"], "out_cuts_per_min": o["metrics"]["cuts_per_min"]["value"],
           "out_motion": o["visual"]["motion_default"], "out_transitions": o["visual"]["transitions"],
           "out_caption_position": o["captions"]["position"], "out_sfx_hits": [e["start_s"] for e in o["timeline"] if e["kind"] == "sfx"],
           "probe": e2e["probe"]}
    print("\nE2E_REPORT " + json.dumps(rep, ensure_ascii=False, default=str))
    assert o["metrics"]["duration_s"]["basis"] == "measured"
