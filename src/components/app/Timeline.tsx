import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Scene = { id: string; idx: number; caption: string | null; narration: string; sfx: string | null; duration_s: number | null; audio_duration_s: number | null; asset_id: string | null; thumb?: string };

/** Linha do tempo multifaixa: vídeo (miniaturas), legenda, voz e SFX, com player e agulha. */
export function Timeline({ productionId }: { productionId: string }) {
  const { data: scenes = [] } = useQuery({
    queryKey: ["timeline", productionId],
    refetchInterval: 8000,
    queryFn: async () => {
      const { data } = await supabase.from("scenes").select("id, idx, caption, narration, sfx, duration_s, audio_duration_s, asset_id").eq("production_id", productionId).order("idx");
      const list = (data ?? []) as Scene[];
      const ids = list.map((s) => s.asset_id).filter(Boolean) as string[];
      if (ids.length) {
        const { data: assets } = await supabase.from("assets").select("id, meta").in("id", ids);
        const paths = new Map<string, string>();
        for (const a of assets ?? []) { const t = (a.meta as { thumb?: string } | null)?.thumb; if (t) paths.set(a.id, t); }
        const urls = paths.size ? (await supabase.storage.from("media").createSignedUrls([...paths.values()], 3600)).data ?? [] : [];
        const byPath = new Map(urls.map((u) => [u.path, u.signedUrl]));
        for (const s of list) { const p = s.asset_id && paths.get(s.asset_id); if (p) s.thumb = byPath.get(p) ?? undefined; }
      }
      return list;
    },
  });
  const durs = scenes.map((s) => Math.max(1, Number(s.duration_s ?? s.audio_duration_s ?? 4)));
  const total = durs.reduce((a, b) => a + b, 0) || 1;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number>(0);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      setT((v) => { const n = v + (now - last) / 1000; if (n >= total) { setPlaying(false); return total; } return n; });
      last = now; raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, total]);

  if (!scenes.length) return null;
  let acc = 0;
  const starts = durs.map((d) => { const s = acc; acc += d; return s; });
  const cur = Math.max(0, starts.findLastIndex((s) => s <= t));
  const s = scenes[cur];
  const pct = (x: number) => `${(x / total) * 100}%`;
  const track = "relative h-10 rounded bg-muted";
  const block = "absolute top-0 h-full overflow-hidden border-r border-background";

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      <div className="flex items-center gap-3">
        <div className="flex aspect-[9/16] h-40 items-center justify-center overflow-hidden rounded bg-muted">
          {s?.thumb ? <img src={s.thumb} alt={`Cena ${cur + 1}`} className="h-full w-full object-cover" /> : <span className="text-muted-foreground">Cena {cur + 1}</span>}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="font-medium">Cena {cur + 1} de {scenes.length} · {t.toFixed(1)}s / {total.toFixed(0)}s</div>
          <div className="line-clamp-3 text-muted-foreground">{s?.narration}</div>
          <button className="inline-flex items-center gap-1 rounded border px-2 py-1" onClick={() => { if (t >= total) setT(0); setPlaying(!playing); }}>
            {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}{playing ? "Pausar" : "Tocar"}
          </button>
        </div>
      </div>
      <div className="relative space-y-1" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setT(((e.clientX - r.left) / r.width) * total); }}>
        {(["Vídeo", "Legenda", "Voz", "SFX"] as const).map((name) => (
          <div key={name} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-muted-foreground">{name}</span>
            <div className={track + " flex-1"}>
              {scenes.map((sc, i) => (
                <div key={sc.id} className={block} style={{ left: pct(starts[i]), width: pct(durs[i]) }} title={`Cena ${i + 1}`}>
                  {name === "Vídeo" && (sc.thumb ? <img src={sc.thumb} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-secondary" />)}
                  {name === "Legenda" && <div className="truncate bg-accent px-1 leading-10 text-accent-foreground">{sc.caption || sc.narration}</div>}
                  {name === "Voz" && <div className="mx-px mt-3 h-4 rounded bg-primary/70" style={{ width: `${Math.min(100, ((sc.audio_duration_s ?? durs[i]) / durs[i]) * 100)}%` }} />}
                  {name === "SFX" && sc.sfx && <div className="truncate px-1 leading-10 text-foreground">♪ {sc.sfx}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="pointer-events-none absolute top-0 h-full w-0.5 bg-destructive" style={{ left: `calc(4rem + (100% - 4rem) * ${t / total})` }} />
      </div>
    </div>
  );
}
