import hashlib, zipfile
from pathlib import Path
import pytest
pytest.importorskip("requests")
from visuals import master_max_seconds, gold_score

ROOT = Path(__file__).resolve().parent
ZIP = ROOT.parent / "public/downloads/agente-estudio-windows.zip"

def test_short_master_capped_at_3min():
    assert master_max_seconds(60, False) == 182
    assert master_max_seconds(180, True) == 182

def test_long_video_not_capped_at_3min():
    assert master_max_seconds(600, True) == 900
    assert master_max_seconds(3600, True) == 1200

def test_dark_shot_loses_to_bright():
    assert gold_score(20, 150, 5) < gold_score(100, 150, 5)

def test_static_shot_loses_to_moving():
    assert gold_score(100, 150, 0) < gold_score(100, 150, 10)

def test_zip_matches_sources_without_duplicates():
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
        assert not any(n.startswith("agente/") for n in names)
        assert len(names) == len(set(names))
        for py in ROOT.glob("*.py"):
            assert hashlib.sha256(z.read(py.name)).digest() == hashlib.sha256(py.read_bytes()).digest(), py.name
        for f in ("fonts/Anton-Regular.ttf", "fonts/Montserrat-Variable.ttf", "run.bat", "install_windows.bat", "requirements.txt"):
            assert f in names
        assert "config.json" not in names
