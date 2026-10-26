"""Fase 3: transforma o Perfil Estruturado v2 (forensics.py / src/lib/style-profile.ts) em parâmetros de renderização.

Precedência (da maior para a menor):
  1. trava de custo/segurança — este módulo nunca chama rede, IA ou provedor; só decide parâmetros locais;
  2. instruções explícitas do usuário — cena com status "edited" (SceneEditor), sfx="off", estilo de legenda
     escolhido à mão, e chaves listadas em settings["user_overrides"];
  3. perfil v2 — apenas traits "measured" com confiança alta/média; "inferred" só com confiança média+ e
     sempre registrado como inferência; "low"/"not_analyzed" nunca são aplicados;
  4. DNA legado (kit_motion, kit_transitions, cut_seconds, caption_clone…) — comportamento anterior preservado;
  5. padrões seguros.
Cada decisão traz `source` e `basis` para auditoria. Sem perfil v2 o plano reproduz o comportamento antigo.
"""
from __future__ import annotations

RENDER_MOTIONS = {"zoom_in", "zoom_out", "pan_left", "pan_right"}
# rótulos medidos em forensics.visual_pass → chaves de fx.XFADE
TRANSITION_MAP = {"cut": "cut", "start": "cut", "flash": "flash", "dip_to_black": "fade"}
CAPTION_BOTTOM_PERCENT = {"bottom": 20, "center": 45, "top": 78}
OK_CONF = {"high", "medium"}


def _usable(trait, allow_inferred: bool = False):
    """Retorna (valor, basis) se o trait puder orientar a renderização; senão (None, motivo)."""
    if not isinstance(trait, dict) or trait.get("value") is None:
        return None, "not_analyzed"
    basis, conf = trait.get("basis"), trait.get("confidence")
    if basis == "measured" and conf in OK_CONF:
        return trait["value"], "measured"
    if basis == "inferred" and allow_inferred and conf in OK_CONF:
        return trait["value"], "inferred"
    return None, f"{basis}/{conf}: insuficiente"


def structured_of(profile_row) -> dict | None:
    """Aceita a linha style_profiles, o JSON `profile` ou o próprio perfil v2."""
    if not isinstance(profile_row, dict):
        return None
    for cand in (profile_row, profile_row.get("profile"), (profile_row.get("profile") or {}).get("structured") if isinstance(profile_row.get("profile"), dict) else None, profile_row.get("structured")):
        if isinstance(cand, dict) and cand.get("version") == 2 and isinstance(cand.get("metrics"), dict):
            return cand
    return None


def _d(value, source, basis, note=""):
    return {"value": value, "source": source, "basis": basis, "note": note}


def resolve_plan(structured: dict | None, settings: dict | None, scenes: list[dict]) -> dict:
    s = settings or {}
    p = structured or {}
    overrides = set(s.get("user_overrides") or [])
    metrics, visual, caps = p.get("metrics") or {}, p.get("visual") or {}, p.get("captions") or {}
    rules = [r for r in (p.get("scene_rules") or []) if isinstance(r, dict)]
    limits: list[str] = []
    has = bool(structured)
    if not has:
        limits.append("sem perfil v2: usando DNA legado/padrões (comportamento anterior)")

    # ---- ritmo / duração dos planos (dentro de cena com vídeo) ----
    avg, b = _usable(metrics.get("avg_shot_s"))
    if "cut_seconds" in overrides and s.get("cut_seconds"):
        cut = _d(float(s["cut_seconds"]), "user", "explicit")
    elif avg is not None:
        cut = _d(round(min(6.0, max(0.8, float(avg))), 2), "profile", b, "média medida entre cortes, limitada a 0,8–6s")
    elif s.get("cut_seconds"):
        cut = _d(float(s["cut_seconds"]), "legacy", "legacy")
    else:
        cut = _d(0.0, "default", "default")
        if has:
            limits.append(f"duração dos planos não aplicada ({b})")

    # ---- movimento padrão ----
    mdef, mb = _usable(visual.get("motion_default"))
    km = s.get("kit_motion") or {}
    legacy_motion = km.get("main_move") if km.get("main_move") in RENDER_MOTIONS and (km.get("moving_share") or 0) >= 0.4 else None
    if mdef == "static":
        limits.append("movimento 'static' medido, mas o motor de imagem não tem câmera parada: usando padrão")
        mdef = None

    # ---- transições globais ----
    tlist, tb = _usable(visual.get("transitions"))

    # ---- legenda (posição/cor são inferências) ----
    if s.get("caption_style") == "none":
        caption = _d({"style": "none"}, "user", "explicit")
    elif s.get("caption_style") not in (None, "", "auto", "clone"):
        caption = _d({"style": s["caption_style"]}, "user", "explicit")
    else:
        pos, pb = _usable(caps.get("position"), allow_inferred=True)
        color, _ = _usable(caps.get("text_hex"), allow_inferred=True)
        if pos in CAPTION_BOTTOM_PERCENT:
            clone = dict(s.get("caption_clone") or {})
            clone["bottom_percent"] = CAPTION_BOTTOM_PERCENT[pos]
            if color and not clone.get("text_hex"):
                clone["text_hex"] = color
            caption = _d({"style": "clone", "clone": clone}, "profile", pb, "posição estimada por contraste — inferência, não fato")
        else:
            st = s.get("caption_resolved") or s.get("caption_style") or "hormozi"
            caption = _d({"style": st, "clone": s.get("caption_clone") if s.get("caption_style") == "clone" else None},
                         "legacy" if s.get("caption_resolved") or s.get("caption_style") else "default",
                         "legacy" if s.get("caption_resolved") or s.get("caption_style") else "default")
            if has:
                limits.append(f"posição da legenda não aplicada ({pb})")

    # ---- SFX ----
    ratio, rb = _usable(metrics.get("sound_hits_on_cuts_ratio"))
    if (s.get("sfx") or "on") == "off":
        sfx = _d({"mode": "off"}, "user", "explicit")
    elif ratio is not None:
        hits = [e for e in (p.get("timeline") or []) if e.get("kind") == "sfx" and e.get("basis") == "measured"]
        dur = (metrics.get("duration_s") or {}).get("value")
        kit = [{"at_s": e["start_s"], "kind": "whoosh" if (e.get("data") or {}).get("on_cut") else "impact",
                "on_cut": bool((e.get("data") or {}).get("on_cut"))} for e in hits]
        sfx = _d({"mode": "kit", "kit": kit, "ref_s": dur}, "profile", rb,
                 f"{len(kit)} saltos de loudness medidos; tipo do som não é identificado (whoosh no corte, impacto fora)")
    elif s.get("kit_sfx"):
        sfx = _d({"mode": "kit", "kit": s["kit_sfx"], "ref_s": s.get("kit_sfx_ref_s")}, "legacy", "legacy")
    else:
        sfx = _d({"mode": "script"}, "default", "default")
        if has:
            limits.append(f"sincronização de SFX não aplicada ({rb})")

    # ---- por cena ----
    out_scenes = []
    legacy_trans = None
    if s.get("kit_transitions"):
        seq = [t.get("kind") or "cut" for t in sorted(s["kit_transitions"], key=lambda t: float(t.get("at_s") or 0))] or ["cut"]
        legacy_trans = seq
    for i, sc in enumerate(scenes):
        edited = sc.get("status") == "edited"
        r = rules[i % len(rules)] if rules else {}
        # movimento
        rm, rmb = _usable(r.get("motion"))
        if edited and sc.get("motion"):
            mv = _d(sc["motion"], "user", "explicit")
        elif "motion" in overrides and sc.get("motion"):
            mv = _d(sc["motion"], "user", "explicit")
        elif rm in RENDER_MOTIONS:
            mv = _d(rm, "profile", rmb, f"regra da cena {r.get('index')} da referência")
        elif mdef in RENDER_MOTIONS:
            mv = _d(mdef, "profile", mb, "movimento dominante medido")
        elif legacy_motion:
            mv = _d(legacy_motion, "legacy", "legacy")
        else:
            mv = _d(sc.get("motion") or "zoom_in", "scene" if sc.get("motion") else "default", "default")
        # transição de saída desta cena = transition_in da regra seguinte
        nxt = rules[(i + 1) % len(rules)] if rules else {}
        rt, rtb = _usable(nxt.get("transition_in"))
        if edited and sc.get("transition"):
            tr = _d(sc["transition"], "user", "explicit")
        elif rt in TRANSITION_MAP:
            tr = _d(TRANSITION_MAP[rt], "profile", rtb, f"medido: {rt}")
        elif legacy_trans:
            tr = _d(legacy_trans[i % len(legacy_trans)], "legacy", "legacy")
        else:
            tr = _d(sc.get("transition") or "cut", "scene" if sc.get("transition") else "default", "default")
        out_scenes.append({"idx": sc.get("idx", i), "motion": mv, "transition": tr})

    if has:
        if not tlist:
            limits.append(f"transições globais não analisadas ({tb})")
        limits += [f"{l.get('feature')}: {l.get('note')}" for l in (p.get("limitations") or []) if isinstance(l, dict)]
        limits.append("duração de cada cena segue a narração; o perfil orienta cortes internos só em cenas com vídeo")
    return {"profile_used": has, "cut_seconds": cut, "caption": caption, "sfx": sfx, "scenes": out_scenes, "limitations": limits}


def summary(plan: dict) -> str:
    srcs = {}
    for sc in plan["scenes"]:
        for k in ("motion", "transition"):
            srcs.setdefault(k, set()).add(sc[k]["source"])
    parts = [f"cortes {plan['cut_seconds']['value']}s ({plan['cut_seconds']['source']})",
             f"legenda {plan['caption']['value'].get('style')} ({plan['caption']['source']}/{plan['caption']['basis']})",
             f"sfx {plan['sfx']['value']['mode']} ({plan['sfx']['source']})"]
    parts += [f"{k}: {'/'.join(sorted(v))}" for k, v in srcs.items()]
    return "plano de estilo — " + "; ".join(parts)
