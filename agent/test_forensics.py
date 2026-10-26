"""Testes do motor forense v2 com vídeos controlados gerados pelo FFmpeg (tempos conhecidos)."""
import shutil
import subprocess
from pathlib import Path

import pytest

import forensics

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg ausente")
W, H = 720, 1280
CUTS = [2.0, 5.0, 6.5]  # planos: 2s, 3s, 1.5s, 2.5s  (total 9s)


def _caption(chain: str) -> str:
    boxes = ",".join(f"drawbox=x={80 + i * 115}:y=1095:w=70:h=50:color=white:t=fill" for i in range(5))
    return f"{chain},drawbox=x=40:y=1070:w=640:h=100:color=black:t=fill,{boxes}"


def make_reference(path: Path) -> Path:
    v = (
        f"testsrc2=s={W}x{H}:r=30:d=2[a];"
        f"testsrc=s=1440x2560:r=30:d=3,zoompan=z='1+0.004*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps=30[b];"
        f"color=c=0xB02020:s={W}x{H}:r=30:d=1.5,noise=alls=40:allf=t[c];"
        f"mandelbrot=s={W}x{H}:r=30,trim=duration=2.5,setpts=PTS-STARTPTS[d];"
        f"[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p,{_caption('null')}[v]"
    )
    beeps = "+".join(f"0.9*sin(2*PI*880*t)*between(t,{c},{c + 0.15})" for c in (2.0, 5.0))
    a = f"aevalsrc='0.02*sin(2*PI*220*t)*between(t,0.3,8.7)+{beeps}':s=48000:d=9[au]"
    subprocess.run(["ffmpeg", "-y", "-filter_complex", f"{v};{a}", "-map", "[v]", "-map", "[au]",
                    "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-t", "9", str(path)], check=True, capture_output=True)
    return path


def make_letterbox(path: Path) -> Path:
    subprocess.run(["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=s=720x405:r=30:d=3",
                    "-vf", f"pad={W}:{H}:0:(oh-ih)/2:black,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", str(path)],
                   check=True, capture_output=True)
    return path


@pytest.fixture(scope="module")
def ref(tmp_path_factory):
    return forensics.analyze(make_reference(tmp_path_factory.mktemp("f") / "ref.mp4"),
                             words=[{"t": 0.5, "text": "um dois tres quatro"}, {"t": 4, "text": "cinco seis sete oito nove dez"}])


def test_cuts_found_at_known_times(ref):
    shots = [e for e in ref["timeline"] if e["kind"] == "shot"]
    starts = [e["start_s"] for e in shots][1:]
    assert len(starts) == 3
    for got, want in zip(starts, CUTS):
        assert abs(got - want) < 0.1


def test_shot_durations_and_rhythm_are_measured(ref):
    m = ref["metrics"]
    assert m["duration_s"]["basis"] == "measured" and abs(m["duration_s"]["value"] - 9) < 0.15
    assert abs(m["avg_shot_s"]["value"] - 2.25) < 0.1
    assert abs(m["cuts_per_min"]["value"] - 20) < 1
    assert m["cuts_per_min_by_third"]["value"] == [20.0, 20.0, 20.0]  # 1 corte em cada terço de 3s
    lens = [r["duration_s"]["value"] for r in ref["scene_rules"]]
    assert [round(x, 1) for x in lens] == [2.0, 3.0, 1.5, 2.5]


def test_zoom_detected_only_in_zoom_shot(ref):
    motions = {r["index"]: r["motion"]["value"] for r in ref["scene_rules"]}
    assert motions[1] == "zoom_in"
    assert motions[0] == "static"
    assert motions[2] is None  # ruído sem movimento coerente: não analisado, não chutado


def test_sound_hits_on_cuts(ref):
    sfx = [e["start_s"] for e in ref["timeline"] if e["kind"] == "sfx"]
    assert any(abs(x - 2.0) < 0.3 for x in sfx) and any(abs(x - 5.0) < 0.3 for x in sfx)
    assert ref["metrics"]["sound_hits_on_cuts_ratio"]["value"] == 1.0


def test_caption_position_is_inferred_not_measured(ref):
    pos = ref["captions"]["position"]
    assert pos["value"] == "bottom"
    assert pos["basis"] == "inferred"


def test_aspect_and_framing(ref):
    assert ref["visual"]["aspect_mix"]["value"] == ["9:16"]
    assert ref["visual"]["framing"]["value"] == "full_frame"


def test_speech_density_uses_transcript(ref):
    wps = ref["metrics"]["words_per_second"]
    assert wps["basis"] == "measured" and wps["value"] > 0


def test_coverage_and_honesty(ref):
    cov = ref["forensics"]["coverage"]
    assert cov["shots_visually_sampled"] == cov["shots_total"] == 4
    assert cov["visual_frames_sampled"] < cov["estimated_total_frames"]  # amostragem, não todos os quadros
    assert cov["first_sample_s"] < 0.5 and cov["last_sample_s"] > 8.0  # início ao fim
    feats = {l["feature"] for l in ref["limitations"]}
    assert {"retenção de audiência", "quadros contínuos"} <= feats
    # nada que não foi analisado aparece como medido
    for sec in ("captions", "audio", "narrative"):
        for t in ref[sec].values():
            if t["value"] is None:
                assert t["basis"] == "not_analyzed" and t["confidence"] == "none"
    assert ref["captions"]["font"]["basis"] == "not_analyzed"


def test_letterbox_detected(tmp_path):
    p = forensics.analyze(make_letterbox(tmp_path / "lb.mp4"))
    assert p["visual"]["framing"]["value"] == "letterbox"
    assert p["forensics"]["area"]["content_aspect"] == "16:9"


def test_no_audio_is_declared(tmp_path):
    p = forensics.analyze(make_letterbox(tmp_path / "lb.mp4"))
    assert p["metrics"]["sound_hits_on_cuts_ratio"]["basis"] == "not_analyzed"
    assert any(l["feature"] == "áudio" for l in p["limitations"])
