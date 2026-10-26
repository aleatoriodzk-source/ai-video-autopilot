"""Motor forense v2: mede a linha do tempo inteira de um MP4 localmente (FFmpeg + OpenCV), sem IA e sem custo.

Saída no formato do Perfil Estruturado v2 (src/lib/style-profile.ts): cada característica traz
value/basis/confidence/evidence. "measured" = calculado direto do arquivo; "inferred" = heurística
local (ex.: posição da legenda por contraste). Nada aqui é retenção de público: é ritmo de edição.
O vídeo NÃO é assistido quadro a quadro: os quadros amostrados ficam listados em `coverage`.
"""
from __future__ import annotations

import json
import re
import statistics
import subprocess
from pathlib import Path

VERSION = 2


def T(value, basis="measured", confidence=None, evidence=None):
    if value is None:
        return {"value": None, "basis": "not_analyzed", "confidence": "none", "evidence": evidence or []}
    conf = confidence or ("high" if basis == "measured" else "low")
    return {"value": value, "basis": basis, "confidence": conf, "evidence": evidence or []}


def _ff(args: list[str]) -> str:
    p = subprocess.run(["ffmpeg", "-hide_banner", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.stderr


def probe(video: Path) -> dict:
    p = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)],
                       capture_output=True, text=True)
    info = json.loads(p.stdout or "{}")
    v = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), {})
    has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    return {"w": int(v.get("width") or 0), "h": int(v.get("height") or 0), "fps": round(fps, 2),
            "duration": float(info.get("format", {}).get("duration") or 0), "has_audio": has_audio}


def aspect_label(w: int, h: int) -> str:
    if not w or not h:
        return "unknown"
    r = w / h
    for name, val in (("9:16", 9 / 16), ("3:4", 3 / 4), ("1:1", 1.0), ("4:3", 4 / 3), ("16:9", 16 / 9)):
        if abs(r - val) / val < 0.04:
            return name
    return f"{w}:{h}"


def scene_cuts(video: Path, threshold: float = 0.3) -> list[float]:
    err = _ff(["-i", str(video), "-vf", f"select='gt(scene,{threshold})',showinfo", "-an", "-f", "null", "-"])
    return sorted({round(float(m), 2) for m in re.findall(r"pts_time:([\d.]+)", err)})


def active_area(video: Path, w: int, h: int) -> dict:
    """Área útil pelo cropdetect no vídeo todo (moda das detecções)."""
    err = _ff(["-i", str(video), "-vf", "cropdetect=24:2:0", "-an", "-f", "null", "-"])
    crops = re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", err)
    if not crops:
        return {"framing": None}
    cw, ch, cx, cy = map(int, statistics.mode(crops))
    bars_v = (h - ch) / h if h else 0
    bars_h = (w - cw) / w if w else 0
    framing = "letterbox" if bars_v > 0.06 else "pillarbox" if bars_h > 0.06 else "full_frame"
    return {"framing": framing, "content_w": cw, "content_h": ch, "content_aspect": aspect_label(cw, ch),
            "bars_vertical_ratio": round(bars_v, 3), "bars_horizontal_ratio": round(bars_h, 3), "samples": len(crops)}


def audio_timeline(video: Path, dur: float) -> dict:
    err = _ff(["-i", str(video), "-af", "silencedetect=noise=-32dB:d=0.12,ebur128=metadata=1,ametadata=print:key=lavfi.r128.M",
               "-vn", "-f", "null", "-"])
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    silences = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else dur
        silences.append((max(0.0, s), min(dur, e)))
    loud = [(float(t), float(m)) for t, m in re.findall(r"pts_time:([\d.]+)[^\n]*\n[^\n]*lavfi.r128.M=(-?[\d.inf]+)", err) if m not in ("-inf", "inf")]
    hits, prev = [], None
    for t, m in loud:
        if prev is not None and m - prev > 7 and m > -20 and (not hits or t - hits[-1] > 0.8):
            hits.append(round(t, 2))
        prev = m
    # Trechos com som = complemento dos silêncios.
    sound, cur = [], 0.0
    for s, e in silences:
        if s - cur > 0.05:
            sound.append((round(cur, 2), round(s, 2)))
        cur = e
    if dur - cur > 0.05:
        sound.append((round(cur, 2), round(dur, 2)))
    vals = [m for _, m in loud if m > -70]
    return {"silences": [(round(a, 2), round(b, 2)) for a, b in silences], "sound_spans": sound, "hits": hits,
            "loudness_avg_lufs": round(sum(vals) / len(vals), 1) if vals else None, "measured": bool(loud or silences)}


def shot_stats(dur: float, cuts: list[float]) -> dict:
    bounds = [0.0] + [c for c in cuts if 0 < c < dur] + [dur]
    shots = [(round(a, 2), round(b, 2)) for a, b in zip(bounds, bounds[1:]) if b - a > 0.01]
    lens = [b - a for a, b in shots]
    third = dur / 3 if dur else 1
    by_third = [round(sum(1 for c in cuts if i * third <= c < (i + 1) * third) / (third / 60), 1) for i in range(3)]
    q = statistics.quantiles(lens, n=4) if len(lens) >= 2 else [lens[0]] * 3 if lens else [0, 0, 0]
    hist = {"<1s": 0, "1-2s": 0, "2-3s": 0, "3-5s": 0, ">5s": 0}
    for L in lens:
        k = "<1s" if L < 1 else "1-2s" if L < 2 else "2-3s" if L < 3 else "3-5s" if L < 5 else ">5s"
        hist[k] += 1
    return {"shots": shots, "lens": lens, "cuts_per_min": round(len(cuts) / (dur / 60), 2) if dur else 0,
            "by_third": by_third, "mean": round(statistics.mean(lens), 2) if lens else None,
            "median": round(statistics.median(lens), 2) if lens else None, "p25": round(q[0], 2), "p75": round(q[2], 2),
            "min": round(min(lens), 2) if lens else None, "max": round(max(lens), 2) if lens else None, "hist": hist}


def _hex(bgr) -> str:
    b, g, r = (int(max(0, min(255, x))) for x in bgr)
    return f"#{r:02X}{g:02X}{b:02X}"


def visual_pass(video: Path, shots: list[tuple[float, float]], cuts: list[float], max_shots: int = 300) -> dict:
    """Amostra 3 quadros por plano (início, meio, fim) + quadros vizinhos de cada corte. Retorna {} sem OpenCV."""
    try:
        import cv2
        import numpy as np
    except Exception:
        return {"available": False}
    cap = cv2.VideoCapture(str(video))
    sampled: list[float] = []

    def grab(t):
        cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, t) * 1000)
        ok, fr = cap.read()
        if not ok or fr is None:
            return None
        sampled.append(round(t, 2))
        return cv2.resize(fr, (320, max(2, int(320 * fr.shape[0] / fr.shape[1]))))

    motions, caption_hits, luma, sat, contrast = [], [], [], [], []
    band_votes = [0] * 10
    text_colors = []
    for a, b in shots[:max_shots]:
        L = b - a
        pts = [a + min(0.1, L * 0.2), a + L / 2, b - min(0.1, L * 0.2)]
        frs = [grab(t) for t in pts]
        if any(f is None for f in frs):
            continue
        f1, mid, f2 = frs
        hsv = cv2.cvtColor(mid, cv2.COLOR_BGR2HSV)
        luma.append(float(hsv[..., 2].mean()))
        sat.append(float(hsv[..., 1].mean()))
        gray = cv2.cvtColor(mid, cv2.COLOR_BGR2GRAY)
        contrast.append(float(gray.std()))
        # Legenda: faixa horizontal com texto claro contornado por escuro (heurística local).
        hb = gray.shape[0] // 10
        best, best_score = None, 0.0
        for i in range(10):
            band = gray[i * hb:(i + 1) * hb]
            bright = band > 215
            dark = band < 45
            edge = cv2.dilate(dark.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & bright
            score = float(edge.mean())
            if score > best_score:
                best, best_score = i, score
        if best is not None and best_score > 0.012:
            band_votes[best] += 1
            caption_hits.append({"t": round(a + L / 2, 2), "band": best})
            bm = gray[best * hb:(best + 1) * hb] > 215
            pix = mid[best * hb:(best + 1) * hb][bm]
            if len(pix):
                text_colors.append(pix.mean(axis=0))
        # Movimento: transformação afim entre início e fim do plano.
        # Par curto (0,3s) no meio do plano: deslocamento pequeno o bastante para o fluxo óptico seguir.
        gap = min(0.3, L * 0.5)
        fa, fb = grab(a + L / 2 - gap / 2), grab(a + L / 2 + gap / 2)
        if fa is None or fb is None:
            fa, fb, gap = f1, f2, L
        g1, g2 = cv2.cvtColor(fa, cv2.COLOR_BGR2GRAY), cv2.cvtColor(fb, cv2.COLOR_BGR2GRAY)
        kind, scale, tx = "unknown", None, None
        mask = np.full(g1.shape, 255, np.uint8)
        if best is not None and best_score > 0.012:  # ignora legenda/overlay fixo, que puxaria para 'parado'
            mask[max(0, (best - 1) * hb):(best + 2) * hb] = 0
        p1 = cv2.goodFeaturesToTrack(g1, 300, 0.01, 8, mask=mask)
        if p1 is not None and len(p1) >= 10 and L >= 0.4:
            p2, st, _ = cv2.calcOpticalFlowPyrLK(g1, g2, p1, None)
            ok = st.flatten() == 1
            if ok.sum() >= 8:
                m, inl = cv2.estimateAffinePartial2D(p1[ok], p2[ok])
                # Exige consenso: ruído/grão gera pontos sem movimento coerente.
                if m is not None and inl is not None and int(inl.sum()) >= 10 and inl.mean() >= 0.5:
                    scale = float(np.sqrt(m[0, 0] ** 2 + m[0, 1] ** 2))
                    tx = float(m[0, 2]) / g1.shape[1]
                    zr, pr = (scale - 1) / gap, tx / gap  # por segundo
                    kind = "zoom_in" if zr > 0.03 else "zoom_out" if zr < -0.03 else "pan_left" if pr < -0.04 else "pan_right" if pr > 0.04 else "static"
        motions.append({"start_s": a, "end_s": b, "kind": kind,
                        "zoom_per_s": round((scale - 1) / gap, 4) if scale else None, "pan_per_s": round(tx / gap, 4) if tx is not None else None})
    trans = []
    for c in cuts[:400]:
        before, at, after = grab(c - 0.25), grab(c + 0.02), grab(c + 0.3)
        if before is None or at is None or after is None:
            continue
        lb, la, lf = (float(cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).mean()) for x in (before, at, after))
        kind = "flash" if la > 215 and la - max(lb, lf) > 35 else "dip_to_black" if la < 20 and min(lb, lf) > 45 else "cut"
        trans.append({"at_s": c, "kind": kind})
    cap.release()
    n = len(motions)
    return {"available": True, "motions": motions, "transitions": trans, "caption_hits": caption_hits, "band_votes": band_votes,
            "shots_sampled": n, "text_color": _hex(np_mean(text_colors)) if text_colors else None,
            "luma_avg": round(statistics.mean(luma), 1) if luma else None, "sat_avg": round(statistics.mean(sat), 1) if sat else None,
            "contrast_avg": round(statistics.mean(contrast), 1) if contrast else None, "sampled_times": sampled}


def np_mean(rows):
    import numpy as np
    return np.mean(np.array(rows), axis=0)


def analyze(video: Path, words: list[dict] | None = None) -> dict:
    """Perfil v2 com medições locais da linha do tempo completa + cobertura e limitações explícitas."""
    video = Path(video)
    info = probe(video)
    dur, w, h = info["duration"], info["w"], info["h"]
    cuts = scene_cuts(video)
    st = shot_stats(dur, cuts)
    area = active_area(video, w, h)
    aud = audio_timeline(video, dur) if info["has_audio"] else {"measured": False, "hits": [], "silences": [], "sound_spans": []}
    vis = visual_pass(video, st["shots"], cuts)
    limits = [{"feature": "retenção de audiência", "reason": "no_data", "note": "O arquivo mostra ritmo de edição, não quanto o público assistiu."},
              {"feature": "quadros contínuos", "reason": "sampling_insufficient", "note": "Análise visual por amostragem (5 quadros por plano + vizinhos dos cortes), não quadro a quadro."},
              {"feature": "música vs. voz", "reason": "no_data", "note": "Separar trilha musical da locução exige separação de fontes; não feito."},
              {"feature": "fonte da legenda", "reason": "no_data", "note": "Família tipográfica não é reconhecida localmente."},
              {"feature": "transições suaves", "reason": "sampling_insufficient", "note": "Dissolves/fades lentos podem não disparar o detector de cortes."}]
    if not vis.get("available"):
        limits.append({"feature": "visual", "reason": "no_data", "note": "OpenCV indisponível: movimento, transições e legenda não analisados."})
    if not info["has_audio"]:
        limits.append({"feature": "áudio", "reason": "no_data", "note": "Vídeo sem trilha de áudio."})

    ev_cut = [f"ffmpeg select=gt(scene,0.3) em {dur:.1f}s ({len(cuts)} cortes)"]
    hits = aud.get("hits") or []
    on_cut = sum(1 for x in hits if any(abs(x - c) < 0.25 for c in cuts))
    speech = sum(b - a for a, b in aud.get("sound_spans") or [])
    n_words = sum(len(str(x.get("text", "")).split()) for x in (words or []))

    motions = vis.get("motions") or []
    known = [m for m in motions if m["kind"] != "unknown"]
    mcount: dict[str, int] = {}
    for m in known:
        mcount[m["kind"]] = mcount.get(m["kind"], 0) + 1
    motion_dom = max(mcount, key=mcount.get) if mcount else None
    zooms = [abs(m["zoom_per_s"]) for m in known if m["zoom_per_s"] is not None and m["kind"].startswith("zoom")]
    tcount: dict[str, int] = {}
    for t in vis.get("transitions") or []:
        tcount[t["kind"]] = tcount.get(t["kind"], 0) + 1

    votes = vis.get("band_votes") or [0] * 10
    sampled = vis.get("shots_sampled") or 0
    cap_band = max(range(10), key=lambda i: votes[i]) if any(votes) else None
    agree = votes[cap_band] / sampled if cap_band is not None and sampled else 0
    cap_conf = "high" if agree >= 0.6 and sampled >= 5 else "medium" if agree >= 0.35 else "low"
    cap_pos = None
    if cap_band is not None and agree >= 0.2:
        cap_pos = "top" if cap_band <= 2 else "center" if cap_band <= 6 else "bottom"
    cap_ev = [f"faixa {cap_band} de 10 em {votes[cap_band]}/{sampled} planos amostrados"] if cap_band is not None else []
    grade = None
    if vis.get("luma_avg") is not None:
        la, sa, co = vis["luma_avg"], vis["sat_avg"], vis["contrast_avg"]
        grade = "dark_cinematic" if la < 80 else "high_contrast" if co > 70 else "vivid" if sa > 120 else "neutral"

    timeline = [{"start_s": a, "end_s": b, "kind": "shot", "data": {"index": i, "len_s": round(b - a, 2)}, "basis": "measured"} for i, (a, b) in enumerate(st["shots"])]
    timeline += [{"start_s": t["at_s"], "end_s": t["at_s"], "kind": "transition", "data": {"type": t["kind"]}, "basis": "measured"} for t in vis.get("transitions") or []]
    timeline += [{"start_s": m["start_s"], "end_s": m["end_s"], "kind": "motion", "data": {"type": m["kind"], "zoom_per_s": m["zoom_per_s"]}, "basis": "measured"} for m in known]
    timeline += [{"start_s": x, "end_s": x, "kind": "sfx", "data": {"loudness_jump": True, "on_cut": any(abs(x - c) < 0.25 for c in cuts)}, "basis": "measured"} for x in hits]
    timeline += [{"start_s": a, "end_s": b, "kind": "speech", "data": {"note": "som acima de -32dB (voz ou música)"}, "basis": "measured"} for a, b in aud.get("sound_spans") or []]
    timeline += [{"start_s": c["t"], "end_s": c["t"], "kind": "caption", "data": {"band": c["band"]}, "basis": "inferred"} for c in vis.get("caption_hits") or []]
    timeline.sort(key=lambda e: (e["start_s"], e["kind"]))

    scene_rules = []
    mot_by = {(m["start_s"], m["end_s"]): m for m in motions}
    trans_by = {t["at_s"]: t["kind"] for t in vis.get("transitions") or []}
    cap_by = {c["t"] for c in vis.get("caption_hits") or []}
    for i, (a, b) in enumerate(st["shots"]):
        m = mot_by.get((a, b))
        mid = round(a + (b - a) / 2, 2)
        sfx = [x for x in hits if abs(x - a) < 0.25]
        scene_rules.append({
            "index": i,
            "duration_s": T(round(b - a, 2), evidence=["entre cortes medidos"]),
            "aspect": T(area.get("content_aspect") or aspect_label(w, h), evidence=["cropdetect global"]),
            "motion": T(m["kind"], evidence=["fluxo óptico início→fim do plano"]) if m and m["kind"] != "unknown" else T(None),
            "transition_in": T(trans_by.get(a, "cut") if i else "start", evidence=["luminância antes/no/depois do corte"]) if vis.get("available") else T(None),
            "caption_style": T("present", "inferred", "medium", ["contraste claro/escuro no quadro do meio"]) if mid in cap_by else T(None),
            "sfx": T("hit", evidence=["salto de loudness ±0,25s do início"]) if sfx else T(None),
            "media_kind": T(None),
        })

    sampled_times = vis.get("sampled_times") or []
    coverage = {
        "duration_s": round(dur, 2), "fps": info["fps"],
        "estimated_total_frames": int(dur * info["fps"]) if info["fps"] else None,
        "visual_frames_sampled": len(sampled_times),
        "shots_total": len(st["shots"]), "shots_visually_sampled": sampled,
        "full_pass_ffmpeg": ["scene_cuts", "cropdetect", "silencedetect", "ebur128"],
        "sampled_intervals_s": [[a, b] for a, b in st["shots"][:sampled]],
        "first_sample_s": min(sampled_times) if sampled_times else None,
        "last_sample_s": max(sampled_times) if sampled_times else None,
        "transcript_words": n_words,
    }

    return {
        "version": VERSION,
        "source": {"reference_id": None, "analysis_id": None, "migrated_from_legacy": False},
        "metrics": {
            "duration_s": T(round(dur, 2), evidence=["ffprobe"]),
            "cuts_per_min": T(st["cuts_per_min"], evidence=ev_cut),
            "cuts_per_min_by_third": T(st["by_third"], evidence=["cortes contados em cada terço da duração"]),
            "avg_shot_s": T(st["mean"], evidence=ev_cut),
            "words_per_second": T(round(n_words / dur, 2), evidence=[f"{n_words} palavras da transcrição / {dur:.1f}s de duração total"]) if n_words and dur else T(None),
            "sound_hits_on_cuts_ratio": T(round(on_cut / len(hits), 2), evidence=[f"{on_cut}/{len(hits)} picos a ±0,25s de um corte"]) if hits else T(None),
        },
        "visual": {
            "aspect_mix": T([aspect_label(w, h)], evidence=[f"ffprobe {w}x{h}"]),
            "framing": T(area.get("framing"), evidence=[f"cropdetect ({area.get('samples', 0)} leituras)"]) if area.get("framing") else T(None),
            "motion_default": T(motion_dom, evidence=[f"{mcount}"]) if motion_dom else T(None),
            "motion_intensity": T(round(statistics.mean(zooms), 4), evidence=["média |zoom|/s nos planos com zoom"]) if zooms else T(None),
            "transitions": T(sorted(tcount, key=tcount.get, reverse=True), evidence=[f"{tcount}"]) if tcount else T(None),
            "color_grade": T(grade, "inferred", "low", [f"luma {vis.get('luma_avg')}, sat {vis.get('sat_avg')}, contraste {vis.get('contrast_avg')}"]) if grade else T(None),
            "media_rule": T(None),
        },
        "captions": {
            "font": T(None), "text_hex": T(vis.get("text_color"), "inferred", cap_conf, cap_ev) if cap_pos else T(None),
            "highlight_hex": T(None), "outline_hex": T(None),
            "position": T(cap_pos, "inferred", cap_conf, cap_ev) if cap_pos else T(None),
            "animation": T(None), "words_per_line": T(None), "uppercase": T(None), "font_size": T(None),
        },
        "audio": {"music_mood": T(None), "music_volume_db": T(None),
                  "sfx_kinds": T(["loudness_hit"], evidence=[f"{len(hits)} saltos de loudness"]) if hits else T(None)},
        "narrative": {"tone": T(None), "hook_patterns": T(None), "structure": T(None), "cta_style": T(None)},
        "timeline": timeline,
        "scene_rules": scene_rules,
        "limitations": limits,
        "forensics": {"shots": {k: st[k] for k in ("mean", "median", "p25", "p75", "min", "max", "hist", "by_third")},
                      "area": area, "audio": {"loudness_avg_lufs": aud.get("loudness_avg_lufs"), "hits": hits,
                                              "speech_ratio": round(speech / dur, 3) if dur and aud.get("measured") else None},
                      "coverage": coverage},
    }
