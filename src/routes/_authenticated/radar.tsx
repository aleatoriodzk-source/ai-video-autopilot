import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { pullChannels, pushChannels } from "@/lib/channels";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/ui";
import { radarSearch, radarInsight, type RadarItem, type RadarInsight } from "@/lib/radar.functions";

export const Route = createFileRoute("/_authenticated/radar")({
  head: () => ({
    meta: [
      { title: "Radar de Virais — Estúdio Automático" },
      { name: "description", content: "Veja os Shorts que mais cresceram nesta semana no seu nicho e transforme cada um em pauta com 1 clique." },
      { property: "og:title", content: "Radar de Virais — Estúdio Automático" },
      { property: "og:description", content: "Shorts em alta no seu nicho viram pauta com 1 clique." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Radar,
});

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n));

function Radar() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<RadarItem[]>([]);
  const nav = useNavigate();
  const [ins, setIns] = useState<RadarInsight | null>(null);
  const [busyIns, setBusyIns] = useState(false);
  const [channels, setChannels] = useState<{ name: string; niche: string }[]>([]);
  const [cur, setCur] = useState("");
  useEffect(() => {
    void pullChannels().finally(() => { try { setChannels(JSON.parse(localStorage.getItem("canais-dark") || "[]")); setCur(localStorage.getItem("canal-atual") || ""); } catch { /* vazio */ } });
  }, []);
  function pick(name: string) {
    setCur(name); localStorage.setItem("canal-atual", name); void pushChannels();
    const c = channels.find((x) => x.name === name); if (c) setQ(c.niche);
  }
  function addChannel() {
    const name = prompt("Nome do canal (ex.: Canal Marvel)")?.trim(); if (!name) return;
    const niche = prompt("Nicho do canal (ex.: curiosidades Marvel)", q)?.trim() || "";
    const next = [...channels.filter((x) => x.name !== name), { name, niche }];
    setChannels(next); localStorage.setItem("canais-dark", JSON.stringify(next)); pick(name); void pushChannels(); setQ(niche);
  }
  async function analisar() {
    setBusyIns(true);
    try {
      const r = await radarInsight({ data: { niche: q, items: items.slice(0, 6) } });
      if (r.ok) setIns(r.insight); else toast.error(r.error);
    } catch (e) { toast.error((e as Error).message); } finally { setBusyIns(false); }
  }
  async function go() {
    setBusy(true);
    try {
      const r = await radarSearch({ data: { q } });
      setItems(r.items);
      if (r.error) toast.error(r.error);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  function usar(it: RadarItem) {
    localStorage.setItem("radar-pauta", `${it.title} (inspirado em vídeo viral: ${it.url})`);
    nav({ to: "/producoes" });
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Radar de Virais" subtitle="Shorts desta semana no seu nicho, do mais visto para o menos visto." />
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <input className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="Ex.: curiosidades Marvel, fortunas famosos, mistérios" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={busy || !q.trim()}>{busy ? "Buscando…" : "Espiar"}</button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Canal:</span>
        {channels.map((c) => (
          <button key={c.name} onClick={() => pick(c.name)} className={`rounded-full border px-3 py-1 ${cur === c.name ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}>{c.name}</button>
        ))}
        <button onClick={addChannel} className="rounded-full border border-dashed border-border px-3 py-1 hover:bg-accent">+ Novo canal</button>
        {items.length ? <button onClick={() => void analisar()} disabled={busyIns} className="ml-auto rounded-md border border-border px-3 py-1.5 hover:bg-accent disabled:opacity-50">{busyIns ? "Analisando capas…" : "Analisar capas e títulos"}</button> : null}
      </div>
      {ins ? (
        <div className="grid gap-3 rounded-lg border border-border bg-card p-4 text-sm md:grid-cols-2">
          <div><p className="mb-1 font-semibold">Padrão das capas</p><ul className="list-disc pl-4 text-muted-foreground">{ins.thumb_patterns.map((t) => <li key={t}>{t}</li>)}</ul></div>
          <div><p className="mb-1 font-semibold">Padrão dos títulos</p><ul className="list-disc pl-4 text-muted-foreground">{ins.title_patterns.map((t) => <li key={t}>{t}</li>)}</ul></div>
          <div className="md:col-span-2"><p className="mb-1 font-semibold">Títulos para testar</p>
            {ins.titles.map((t) => (
              <div key={t.title} className="flex items-center gap-2 border-t border-border py-1.5">
                <span className="w-10 font-bold text-primary">{Math.round(t.score)}</span>
                <span className="flex-1">{t.title} <span className="text-muted-foreground">· {t.trigger}</span></span>
                <button className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent" onClick={() => { localStorage.setItem("radar-pauta", t.title); nav({ to: "/producoes" }); }}>Usar</button>
              </div>
            ))}
          </div>
          <div className="md:col-span-2"><p className="mb-1 font-semibold">Comentário para fixar</p>
            <p className="text-muted-foreground">{ins.pinned_comment} <button className="ml-2 underline" onClick={() => { void navigator.clipboard.writeText(ins.pinned_comment); toast.success("Copiado"); }}>copiar</button></p>
            <p className="mt-2 text-muted-foreground">{ins.hashtags.join(" ")}</p>
          </div>
          <div className="md:col-span-2"><p className="mb-1 font-semibold">Ideias de capa</p>
            <div className="grid gap-2 sm:grid-cols-3">
              {(ins.covers ?? []).map((c, k) => (
                <div key={k} className="rounded border border-border p-2"><p className="font-bold uppercase">{c.text}</p><p className="text-xs text-muted-foreground">{c.layout}</p><p className="text-xs text-muted-foreground">Cores: {c.colors}</p><div className="mt-2 flex gap-2"><button onClick={() => baixarCapa(c.text, true)} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">Baixar Short</button><button onClick={() => baixarCapa(c.text, false)} className="rounded border border-border px-2 py-1 text-xs hover:bg-accent">Baixar longo</button></div></div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((it, i) => (
          <div key={it.id} className="overflow-hidden rounded-lg border border-border bg-card">
            <a href={it.url} target="_blank" rel="noreferrer"><img src={it.thumb} alt={it.title} className="aspect-[3/4] w-full object-cover" loading="lazy" /></a>
            <div className="space-y-2 p-2 text-xs">
              <p className="line-clamp-2 font-medium text-foreground">{it.title}</p>
              <p className="text-muted-foreground">#{i + 1} · {fmt(it.views)} views nesta semana</p>
              <button className="w-full rounded-md border border-border px-2 py-1.5 hover:bg-accent" onClick={() => usar(it)}>Usar como pauta</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function baixarCapa(text: string, short: boolean) {
  const w = short ? 1080 : 1280, h = short ? 1920 : 720;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const g = cv.getContext("2d"); if (!g) return;
  const bg = g.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, "#111"); bg.addColorStop(1, "#000");
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const words = text.toUpperCase().split(/\s+/); const size = short ? 150 : 110;
  g.font = `${size}px "Bebas Neue", Anton, Impact, sans-serif`; g.textAlign = "center";
  const lines: string[] = []; let cur = "";
  for (const wd of words) { const t = cur ? cur + " " + wd : wd; if (g.measureText(t).width > w * 0.88 && cur) { lines.push(cur); cur = wd; } else cur = t; }
  if (cur) lines.push(cur);
  const y0 = h / 2 - ((lines.length - 1) * size * 1.05) / 2;
  lines.forEach((l, i) => { const y = y0 + i * size * 1.05; g.lineWidth = size / 8; g.strokeStyle = "#000"; g.shadowColor = "rgba(0,0,0,.8)"; g.shadowBlur = 20; g.strokeText(l, w / 2, y); g.shadowBlur = 0; g.fillStyle = i === lines.length - 1 ? "#FFD400" : "#FFF"; g.fillText(l, w / 2, y); });
  const a = document.createElement("a"); a.download = `capa-${short ? "short" : "longo"}.png`; a.href = cv.toDataURL("image/png"); a.click();
}
