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
            _ff("-f", "lavfi", "-i", f"testsrc2=s=1280x720:r=30:d=8", "-pix_fmt", "yuv420p", str(work / f"vid_{i:03d}.mp4"))
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


def test_internal_cuts_follow_profile(e2e):
    """Cenas de vídeo (3,5s) com cut_seconds=2,25 devem ter um corte interno ≈2,25s após o início da cena."""
    cuts = [e["start_s"] for e in e2e["out"]["timeline"] if e["kind"] == "shot"][1:]
    for i in VIDEO_SCENES:
        want = i * VOICE_S + 2.25
        assert any(abs(c - want) < 0.35 for c in cuts), (want, cuts)


def test_sfx_hits_present(e2e):
    plan_sfx = [l for l in e2e["api"].logs if "sfx" in l and "aplicado do perfil" in l]
    assert plan_sfx, "SFX do perfil não aplicado"
    assert e2e["out"]["timeline"] and any(e["kind"] == "sfx" for e in e2e["out"]["timeline"])
