"""Seleção de imagens por cena: arquivos enviados → Pexels (se houver chave) → IA (se permitido) → fundo neutro."""
from __future__ import annotations

import base64
from pathlib import Path

import requests

import media


def _download(url: str, out: Path) -> None:
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    out.write_bytes(r.content)


def pexels_search(key: str, query: str, orientation: str) -> list[dict]:
    r = requests.get("https://api.pexels.com/v1/search", headers={"Authorization": key},
                     params={"query": query, "orientation": orientation, "per_page": 15}, timeout=30)
    if r.status_code == 429:
        raise RuntimeError("Pexels: limite de requisições atingido, tentando depois")
    r.raise_for_status()
    return r.json().get("photos", [])


def pick_visuals(runner, job, ctx) -> None:
    s, work, prod = ctx["settings"], ctx["work"], ctx["prod"]
    w, h = ctx["w"], ctx["h"]
    orientation = "portrait" if h > w else "landscape" if w > h else "square"
    key = runner.cfg.get("pexels_api_key")
    window = s["visuals"].get("avoid_repeat_window", 4)
    uploads = [a for a in ctx["assets"] if a["source"] == "upload" and a["kind"] == "image" and a.get("storage_path")]
    recent: list[str] = []
    ai_used = 0
    for sc in ctx["scenes"]:
        out = work / f"img_{sc['idx']:03d}.jpg"
        chosen = None
        for src in s["visuals"]["prefer"]:
            if src == "upload" and uploads:
                a = next((u for u in uploads if u["id"] not in recent[-window:]), None)
                if a:
                    url = runner.api.call("download_url", path=a["storage_path"])["url"]
                    _download(url, out)
                    chosen = {"id": a["id"]}
            elif src == "pexels" and key:
                q = sc.get("visual_query") or sc["narration"][:60]
                for ph in pexels_search(key, q, orientation):
                    pid = f"pexels:{ph['id']}"
                    if pid in recent[-window * 3:]:
                        continue
                    _download(ph["src"]["large2x"], out)
                    aid = runner.api.call("create_asset", asset={
                        "production_id": prod["id"], "kind": "image", "source": "pexels", "source_url": ph["url"],
                        "license": "Pexels License (uso gratuito, atribuição opcional)", "attribution": f"Foto de {ph['photographer']} no Pexels",
                        "local_path": str(out), "description": q})["id"]
                    chosen = {"id": aid, "key": pid}
                    break
            elif src == "ai_image" and s["ai"]["allow_ai_images"]:
                aspect = prod["aspect"]
                r = runner.api.call("ai_image", job_id=job["id"], prompt=sc.get("visual_description") or sc["narration"], aspect=aspect, used=ai_used)
                if r.get("b64"):
                    out.write_bytes(base64.b64decode(r["b64"]))
                    ai_used += 1
                    aid = runner.api.call("create_asset", asset={"production_id": prod["id"], "kind": "image", "source": "ai_image", "license": "Gerada por IA", "local_path": str(out), "description": sc.get("visual_description")})["id"]
                    chosen = {"id": aid}
            if chosen:
                break
        if not chosen:
            media.text_card(sc.get("caption") or "", w, h, out.with_suffix(".png"))
            out.with_suffix(".png").replace(out)
            runner.log(job, f"cena {sc['idx'] + 1}: nenhuma fonte de imagem disponível — usado fundo neutro. Configure a chave Pexels ou envie imagens.", "warn", "visuals")
            continue
        recent.append(chosen.get("key") or chosen["id"])
        runner.api.call("update_scene", scene_id=sc["id"], fields={"asset_id": chosen["id"], "status": "visual_ok"})
        sc["asset_id"] = chosen["id"]
