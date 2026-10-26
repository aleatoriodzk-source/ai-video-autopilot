"""Fase 4 — auditoria de aderência técnica: compara medições do MP4 final (forensics) com a referência (perfil v2)
e com o plano aplicado. Sem nota/porcentagem de fidelidade: cada dimensão diz o que foi medido, a tolerância
e se ficou dentro, fora ou não verificada. Também aponta cenas com defeito para re-renderização isolada."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path


def _v(t):
    return t.get("value") if isinstance(t, dict) else None


def _basis(t):
    return t.get("basis") if isinstance(t, dict) else "not_analyzed"


def _dim(key, label, status, ref=None, out=None, tolerance=None, note=""):
    return {"key": key, "label": label, "status": status, "ref": ref, "out": out, "tolerance": tolerance, "note": note}


def _rel(a, b, tol):
    return "pass" if a and b is not None and abs(b - a) / a <= tol else "deviation"


def black_intervals(path: Path) -> list[tuple[float, float]]:
    r = subprocess.run(["ffmpeg", "-i", str(path), "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"],
                       capture_output=True, text=True, timeout=600)
    return [(float(a), float(b)) for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", r.stderr)]


def scene_checks(out: dict, durs: list[float], split_log: dict, black: list[tuple[float, float]], tol: float = 0.25) -> list[dict]:
    """Por cena: quantidade de planos medida vs planejada (split_log) e quadros pretos dentro do intervalo."""
    starts = [e["start_s"] for e in out.get("timeline") or [] if e.get("kind") == "shot"]
    res, t = [], 0.0
    for i, d in enumerate(durs):
        a, b = t, t + d
        issues = []
        want = len((split_log.get(i) or split_log.get(str(i)) or {}).get("pieces") or [1])
        got = 1 + sum(1 for s in starts if a + tol < s < b - tol)
        if got < want:
            issues.append(f"cortes internos: medido {got} plano(s), planejado {want}")
        bl = sum(max(0.0, min(b, y) - max(a, x)) for x, y in black)
        if bl >= 0.1:
            issues.append(f"quadros pretos: {bl:.2f}s")
        res.append({"idx": i, "start_s": round(a, 2), "end_s": round(b, 2), "planned_shots": want, "measured_shots": got, "issues": issues})
        t = b
    return res


def audit(ref: dict | None, out: dict, plan: dict | None, durs: list[float], split_log: dict | None = None,
          black: list[tuple[float, float]] | None = None, narration_words: int | None = None) -> dict:
    ref = ref or {}
    rm, om = ref.get("metrics") or {}, out.get("metrics") or {}
    rv, ov = ref.get("visual") or {}, out.get("visual") or {}
    dims = []
    has_ref = bool(ref)

    # 1. Ritmo de cortes (duração média dos planos e cortes/min por terço)
    ra, oa = _v(rm.get("avg_shot_s")), _v(om.get("avg_shot_s"))
    if has_ref and ra and oa is not None and _basis(rm.get("avg_shot_s")) == "measured":
        rt, ot = _v(rm.get("cuts_per_min_by_third")) or [], _v(om.get("cuts_per_min_by_third")) or []
        dims.append(_dim("cut_rhythm", "Ritmo de cortes", _rel(ra, oa, 0.25), {"avg_shot_s": ra, "by_third": rt}, {"avg_shot_s": oa, "by_third": ot}, "±25% na duração média do plano",
                         "Ritmo de edição, não retenção de público."))
    else:
        dims.append(_dim("cut_rhythm", "Ritmo de cortes", "not_verified", ra, oa, note="referência sem ritmo medido"))

    # 2. Movimento de câmera
    rmo, omo = _v(rv.get("motion_default")), _v(ov.get("motion_default"))
    if has_ref and rmo and _basis(rv.get("motion_default")) == "measured" and rv.get("motion_default", {}).get("confidence") in ("high", "medium"):
        dims.append(_dim("motion", "Movimento", "pass" if rmo == omo else "deviation", rmo, omo, "mesmo movimento predominante",
                         "Comparação do movimento predominante; cenas de vídeo de banco mantêm o movimento original."))
    else:
        dims.append(_dim("motion", "Movimento", "not_verified", rmo, omo, note="movimento da referência não medido com confiança"))

    # 3. Legendas (posição) — inferência na referência nunca vira aprovação
    rc, oc = (ref.get("captions") or {}).get("position"), (out.get("captions") or {}).get("position")
    if has_ref and _v(rc) and _v(oc):
        st = "pass" if _v(rc) == _v(oc) else "deviation"
        dims.append(_dim("captions", "Legendas (posição)", st, _v(rc), _v(oc), "mesma faixa vertical",
                         f"referência: {_basis(rc)}; resultado: {_basis(oc)} (heurística de contraste)"))
    else:
        dims.append(_dim("captions", "Legendas (posição)", "not_verified", _v(rc), _v(oc), note="posição não detectada em um dos vídeos; fonte, cor e animação não são analisadas"))

    # 4. Sincronia audiovisual: cortes caem nas fronteiras de cena (narração) ou nos cortes internos planejados
    shots = [e["start_s"] for e in out.get("timeline") or [] if e.get("kind") == "shot"][1:]
    bounds, t = [], 0.0
    for d in durs[:-1]:
        t += d
        bounds.append(t)
    miss = [round(b, 2) for b in bounds if not any(abs(s - b) <= 0.2 for s in shots)]
    dims.append(_dim("av_sync", "Sincronia corte × narração", "pass" if not miss else "deviation", len(bounds), len(bounds) - len(miss), "corte a ≤0,2s de cada troca de fala",
                     ("trocas de fala sem corte detectado: " + ", ".join(map(str, miss))) if miss else "SFX não auditados aqui (exige mixagem de controle)"))

    # 5. Enquadramento / formato
    rf, of = _v(rv.get("framing")), _v(ov.get("framing"))
    of_bars = of and of != "full_frame"
    dims.append(_dim("framing", "Enquadramento e barras", "deviation" if of_bars else "pass", rf, of, "sem barras pretas no resultado",
                     "regra fixa: tela cheia com fundo desfocado"))

    # 6. Adequação semântica da mídia: não medível por sinal
    dims.append(_dim("media_fit", "Adequação da mídia ao tema", "not_verified", note="exige avaliação semântica; não verificada automaticamente"))

    # 7. Densidade de locução
    rw = _v(rm.get("words_per_second"))
    total = sum(durs) or 0
    ow = round(narration_words / total, 2) if narration_words and total else None
    if rw and ow is not None:
        dims.append(_dim("speech_density", "Densidade de locução", _rel(rw, ow, 0.25), rw, ow, "±25% palavras/s", "roteiro ÷ duração; não é transcrição do MP4"))
    else:
        dims.append(_dim("speech_density", "Densidade de locução", "not_verified", rw, ow, note="referência sem transcrição medida"))

    scenes = scene_checks(out, durs, split_log or {}, black or [])
    bad = [s["idx"] for s in scenes if s["issues"]]
    return {"version": 1, "has_reference": has_ref, "profile_used": bool((plan or {}).get("profile_used")),
            "dimensions": dims, "scenes": scenes, "failing_scenes": bad,
            "summary": {k: sum(1 for d in dims if d["status"] == k) for k in ("pass", "deviation", "not_verified")},
            "note": "Sem pontuação de fidelidade: cada item mostra medida, tolerância e status."}
