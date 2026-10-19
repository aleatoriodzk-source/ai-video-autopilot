import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rerenderProduction } from "@/lib/jobs";

type Draft = {
  id?: string;
  narration: string;
  caption: string;
  visual_query: string;
  visual_description: string;
  pause_after_ms: number;
  duration_s: number | null;
};

const field = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

/** Estimated seconds of speech for a scene (≈2.4 words/s) when it was not narrated yet. */
const est = (d: Draft) => d.duration_s ?? Math.max(1.5, d.narration.split(/\s+/).filter(Boolean).length / 2.4 + d.pause_after_ms / 1000);

export function SceneEditor({ productionId }: { productionId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["scenes", productionId],
    queryFn: async () => (await supabase.from("scenes").select("*").eq("production_id", productionId).order("idx")).data ?? [],
  });
  const [draft, setDraft] = useState<Draft[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data || dirty) return;
    setDraft(data.map((s) => ({ id: s.id, narration: s.narration, caption: s.caption ?? "", visual_query: s.visual_query ?? "", visual_description: s.visual_description ?? "", pause_after_ms: s.pause_after_ms, duration_s: s.duration_s })));
    setRemoved([]);
  }, [data, dirty]);

  if (isLoading) return <div className="text-xs text-muted-foreground">Carregando cenas…</div>;
  if (!draft.length) return <div className="text-xs text-muted-foreground">Ainda não há cenas. Clique em "Gerar roteiro" primeiro.</div>;

  const cur = draft[Math.min(sel, draft.length - 1)]!;
  const total = draft.reduce((a, d) => a + est(d), 0);
  const edit = (patch: Partial<Draft>) => { setDirty(true); setDraft((d) => d.map((x, i) => (i === sel ? { ...x, ...patch } : x))); };
  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (j < 0 || j >= draft.length) return;
    setDirty(true);
    setDraft((d) => { const n = [...d]; [n[sel], n[j]] = [n[j]!, n[sel]!]; return n; });
    setSel(j);
  };
  const addAfter = () => {
    setDirty(true);
    setDraft((d) => [...d.slice(0, sel + 1), { narration: "", caption: "", visual_query: "", visual_description: "", pause_after_ms: 300, duration_s: null }, ...d.slice(sel + 1)]);
    setSel(sel + 1);
  };
  const remove = () => {
    if (draft.length <= 1) { toast.error("O vídeo precisa de pelo menos uma cena"); return; }
    setDirty(true);
    if (cur.id) setRemoved((r) => [...r, cur.id!]);
    setDraft((d) => d.filter((_, i) => i !== sel));
    setSel(Math.max(0, sel - 1));
  };

  async function save(): Promise<boolean> {
    const empty = draft.findIndex((d) => !d.narration.trim());
    if (empty >= 0) { toast.error(`A cena ${empty + 1} está sem narração`); setSel(empty); return false; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (removed.length) {
        const { error } = await supabase.from("scenes").delete().in("id", removed);
        if (error) throw error;
      }
      // Two passes on idx avoid collisions while reordering.
      for (const [i, d] of draft.entries()) {
        if (!d.id) continue;
        const { error } = await supabase.from("scenes").update({ idx: 10000 + i }).eq("id", d.id);
        if (error) throw error;
      }
      for (const [i, d] of draft.entries()) {
        const row = { idx: i, narration: d.narration.trim(), caption: d.caption || null, visual_query: d.visual_query || null, visual_description: d.visual_description || null, pause_after_ms: Math.max(0, Math.round(d.pause_after_ms)) };
        const { error } = d.id
          ? await supabase.from("scenes").update({ ...row, status: "edited", audio_path: null, duration_s: null }).eq("id", d.id)
          : await supabase.from("scenes").insert({ ...row, user_id: u.user!.id, production_id: productionId });
        if (error) throw error;
      }
      setDirty(false);
      await qc.invalidateQueries({ queryKey: ["scenes", productionId] });
      toast.success("Cenas salvas");
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally { setBusy(false); }
  }

  async function rerender() {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      await rerenderProduction(productionId);
      qc.invalidateQueries({ queryKey: ["prods"] });
      toast.success("Enviado ao agente: ele vai regravar a voz, buscar as mídias e montar o vídeo de novo");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{draft.length} cenas · ~{Math.round(total)}s</span>
        {dirty && <span className="text-warning">Alterações não salvas</span>}
      </div>

      {/* Timeline */}
      <div className="flex gap-1 overflow-x-auto pb-2">
        {draft.map((d, i) => (
          <button
            key={d.id ?? `new-${i}`}
            onClick={() => setSel(i)}
            style={{ minWidth: `${Math.max(88, est(d) * 22)}px` }}
            className={"flex h-20 flex-col justify-between rounded-md border p-1.5 text-left text-[10px] leading-tight transition-colors " + (i === sel ? "border-primary bg-primary/15" : "border-border bg-background hover:bg-accent")}
          >
            <span className="flex justify-between font-medium"><span>#{i + 1}</span><span className="text-muted-foreground">{est(d).toFixed(1)}s</span></span>
            <span className="line-clamp-2 text-muted-foreground">{d.narration || "(sem fala)"}</span>
            <span className="truncate font-mono text-primary">{d.visual_query || "—"}</span>
          </button>
        ))}
      </div>

      {/* Inspector */}
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-xs text-muted-foreground md:col-span-2">Narração da cena {sel + 1} (o que a voz vai falar)
          <textarea rows={3} value={cur.narration} onChange={(e) => edit({ narration: e.target.value })} className={field + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground">Legenda curta
          <input value={cur.caption} onChange={(e) => edit({ caption: e.target.value })} className={field + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground">Pausa depois (ms)
          <input type="number" min={0} max={5000} step={100} value={cur.pause_after_ms} onChange={(e) => edit({ pause_after_ms: Number(e.target.value) })} className={field + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground">Busca de vídeo/foto (em inglês, ex.: deep ocean submarine)
          <input value={cur.visual_query} onChange={(e) => edit({ visual_query: e.target.value })} className={field + " mt-1 font-mono"} />
        </label>
        <label className="text-xs text-muted-foreground">O que deve aparecer (descrição)
          <input value={cur.visual_description} onChange={(e) => edit({ visual_description: e.target.value })} className={field + " mt-1"} />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button className={btn} disabled={sel === 0} onClick={() => move(-1)}>← Mover</button>
        <button className={btn} disabled={sel === draft.length - 1} onClick={() => move(1)}>Mover →</button>
        <button className={btn} onClick={addAfter}>+ Cena depois</button>
        <button className={btn + " text-destructive"} onClick={remove}>Excluir cena</button>
        <span className="flex-1" />
        <button className={btn} disabled={busy || !dirty} onClick={save}>Salvar cenas</button>
        <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy} onClick={rerender}>Renderizar novamente</button>
      </div>
    </div>
  );
}
