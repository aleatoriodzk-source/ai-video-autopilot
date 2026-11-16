"""Regressão do limiar de corte: pega fronteira fraca, ignora zoom/luz/movimento."""
import shutil, subprocess
from pathlib import Path
import pytest
import forensics as f

pytestmark = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg ausente")

def _mk(tmp, name, src, vf=None, d=4):
    out = tmp / f"{name}.mp4"
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src, "-t", str(d)]
    if vf: cmd += ["-vf", vf]
    subprocess.run(cmd + ["-pix_fmt", "yuv420p", str(out)], check=True)
    return out

def test_threshold_is_shared():
    assert f.CUT_THRESHOLD == 0.25
    assert "scene_cuts(base)" in (Path(__file__).parent / "slicer.py").read_text()

@pytest.mark.parametrize("name,src,vf", [
    ("zoom", "testsrc2=s=360x640:r=30", "zoompan=z='1+0.004*on':d=1:s=360x640:fps=30"),
    ("light", "testsrc2=s=360x640:r=30", "eq=brightness='-0.4+0.2*t'"),
    ("motion", "mandelbrot=s=360x640:r=30", None),
    ("life", "life=s=360x640:r=30:mold=10:ratio=0.1", None),
])
def test_no_false_cuts(tmp_path, name, src, vf):
    assert f.scene_cuts(_mk(tmp_path, name, src, vf)) == []

def test_real_cut_detected(tmp_path):
    a = _mk(tmp_path, "a", "testsrc2=s=360x640:r=30", d=2)
    b = _mk(tmp_path, "b", "mandelbrot=s=360x640:r=30", d=2)
    out = tmp_path / "ab.mp4"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(a), "-i", str(b), "-filter_complex",
                    "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", str(out)], check=True)
    cuts = f.scene_cuts(out)
    assert len(cuts) == 1 and abs(cuts[0] - 2.0) < 0.1
