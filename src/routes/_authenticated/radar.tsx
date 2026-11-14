import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/ui";
import { radarSearch, type RadarItem } from "@/lib/radar.functions";

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
      <PageHeader title="Radar de Virais" description="Shorts desta semana no seu nicho, do mais visto para o menos visto." />
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <input className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="Ex.: curiosidades Marvel, fortunas famosos, mistérios" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={busy || !q.trim()}>{busy ? "Buscando…" : "Espiar"}</button>
      </form>
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
