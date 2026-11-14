import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rerenderProduction } from "@/lib/jobs";
import { rewriteScene } from "@/lib/ai.functions";
import { CAPTIONS, COLORS } from "@/lib/library-presets";
import { StudioStatus } from "./StudioStatus";
import { download, toDraft, toSrt } from "@/lib/capcut-export";

type Draft = {
  id?: string;
  narration: string;
  caption: string;
  visual_query: string;
  visual_description: string;
  pause_after_ms: number;
  duration_s: number | null;
  motion: string;
  transition: string;
  asset_id: string | null;
};
const MOTIONS: [string, string][] = [["zoom_in", "Zoom aproximando"], ["zoom_out", "Zoom afastando"], ["pan_left", "Deslizar à esquerda"], ["pan_right", "Deslizar à direita"], ["static", "Parada"]];
const TRANS: [string, string][] = [["cut", "Corte seco"], ["fade", "Esmaecer"], ["slideleft", "Deslizar ←"], ["slideright", "Deslizar →"], ["zoomin", "Zoom"], ["circleopen", "Círculo"]];

const PAUSES: [number, string][] = [[0, "Nenhum"], [150, "Curto"], [400, "Médio"], [800, "Longo"]];
const field = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

/** Estimated seconds of speech for a scene (≈2.5 words/s) when it was not narrated yet. */
const est = (d: Draft) => d.duration_s ?? Math.max(1.5, d.narration.split(/\s+/).filter(Boolean).length / 2.5 + d.pause_after_ms / 1000);

export function SceneEditor({ productionId }: { productionId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["scenes", productionId],
    queryFn: async () => (await supabase.from("scenes").select("*").eq("production_id", productionId).order("idx")).data ?? [],
    refetchInterval: 6000,
  });
  const [draft, setDraft] = useState<Draft[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState("");
  const [pick, setPick] = useState(false);
  const { data: prod } = useQuery({
    queryKey: ["prod-aspect", productionId],
    queryFn: async () => (await supabase.from("productions").select("aspect, settings").eq("id", productionId).maybeSingle()).data,
  });
  const wide = prod?.aspect === "16:9";
  const [panel, setPanel] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [trims, setTrims] = useState<Record<string, { in: number }>>({});
  const trackRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setTrims(((prod?.settings as Record<string, unknown> | null)?.["scene_trim"] as Record<string, { in: number }>) ?? {}); }, [prod]);
  // Reprodução: avança a agulha e troca a cena sozinha.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setT((x) => x + 0.1), 100);
    return () => clearInterval(id);
  }, [playing]);

  useEffect(() => {
    if (!data || dirty) return;
    setDraft(data.map((s) => ({ id: s.id, narration: s.narration, caption: s.caption ?? "", visual_query: s.visual_query ?? "", visual_description: s.visual_description ?? "", pause_after_ms: s.pause_after_ms, duration_s: s.duration_s, motion: s.motion ?? "zoom_in", transition: s.transition ?? "cut", asset_id: s.asset_id })));
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
    setDraft((d) => [...d.slice(0, sel + 1), { narration: "", caption: "", visual_query: "", visual_description: "", pause_after_ms: 300, duration_s: null, motion: "zoom_in", transition: "cut", asset_id: null }, ...d.slice(sel + 1)]);
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
        const row = { idx: i, narration: d.narration.trim(), caption: d.caption || null, visual_query: d.visual_query || null, visual_description: d.visual_description || null, pause_after_ms: Math.max(0, Math.round(d.pause_after_ms)), motion: d.motion, transition: d.transition, asset_id: d.asset_id };
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

  async function swapMedia(file: File) {
    if (!/^(image|video)\//.test(file.type)) { toast.error("Envie uma foto ou um vídeo"); return; }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${u.user!.id}/scenes/${productionId}/${Date.now()}.${ext}`;
      const up = await supabase.storage.from("media").upload(path, file, { contentType: file.type });
      if (up.error) throw up.error;
      const kind = file.type.startsWith("video") ? "video" : "image";
      const { data: a, error } = await supabase.from("assets").insert({ user_id: u.user!.id, production_id: productionId, kind, source: "upload", storage_path: path, license: "Enviada pelo usuário", description: file.name, meta: { locked: true } }).select("id").single();
      if (error) throw error;
      edit({ asset_id: a.id });
      toast.success(`Mídia trocada na cena ${sel + 1}. Salve e renderize para aplicar.`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  async function rewrite() {
    if (!cur.id) { toast.error("Salve as cenas antes"); return; }
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const r = await rewriteScene({ data: { sceneId: cur.id, instruction: ask } });
      if (!r.ok) throw new Error(r.error);
      setAsk("");
      await qc.invalidateQueries({ queryKey: ["scenes", productionId] });
      toast.success(`Cena ${sel + 1} reescrita`);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  function exportCapcut() {
    const sc = draft.map((d) => ({ narration: d.narration, caption: d.caption, duration: est(d), media: d.asset_id }));
    download("legendas.srt", toSrt(sc));
    download("rascunho-capcut.json", JSON.stringify(toDraft(sc, prod?.aspect ?? "9:16", "Estúdio"), null, 2), "application/json");
    toast.success("Baixados: legendas.srt e o rascunho. No CapCut: Texto → Legendas → Importar o .srt; depois arraste o vídeo final.");
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

  const starts = draft.reduce<number[]>((a, d, i) => [...a, i ? a[i - 1]! + est(draft[i - 1]!) : 0], []);
  const PX = 34; // pixels por segundo na linha do tempo
  if (playing) {
    const i = starts.findIndex((st, k) => t >= st && t < st + est(draft[k]!));
    if (i === -1) { setPlaying(false); setT(0); }
    else if (i !== sel) setSel(i);
  }
  const seek = (x: number) => {
    const sec = Math.max(0, Math.min(total - 0.01, x / PX));
    setT(sec);
    const i = starts.findIndex((st, k) => sec >= st && sec < st + est(draft[k]!));
    if (i >= 0) setSel(i);
  };
  const trimIn = trims[String(sel)]?.in ?? 0;
  async function saveTrim(v: number) {
    const next = { ...trims, [String(sel)]: { in: Math.max(0, Math.round(v * 10) / 10) } };
    setTrims(next);
    const st = { ...((prod?.settings as Record<string, unknown> | null) ?? {}), scene_trim: next };
    const { error } = await supabase.from("productions").update({ settings: st as never }).eq("id", productionId);
    if (error) toast.error(error.message);
    else qc.invalidateQueries({ queryKey: ["prod-aspect", productionId] });
  }
  async function saveLook(key: "color_grade" | "caption_resolved", v: string) {
    const st = { ...((prod?.settings as Record<string, unknown> | null) ?? {}), [key]: v };
    const { error } = await supabase.from("productions").update({ settings: st as never }).eq("id", productionId);
    if (error) toast.error(error.message);
    else { toast.success("Estilo salvo — vale no próximo render"); qc.invalidateQueries({ queryKey: ["prod-aspect", productionId] }); }
  }
  const look = (prod?.settings as Record<string, string> | null) ?? {};
  const [audit, setAudit] = useState<null | { score: number; hook: string; issues: { i: number; msg: string }[] }>(null);
  function runAudit() {
    const issues: { i: number; msg: string }[] = [];
    let score = 100;
    const h = draft[0];
    const hookTxt = (h?.narration ?? "").toLowerCase();
    let hook = "Gancho forte";
    if (!h || est(h) > 3.5) { score -= 15; hook = "Gancho lento: a 1ª cena passa de 3s"; issues.push({ i: 0, msg: "Encurte a 1ª fala para caber em 3 segundos" }); }
    if (h && !/[?!]|\d|nunca|ninguém|segredo|verdade|por que|como/.test(hookTxt)) { score -= 10; issues.push({ i: 0, msg: "Gancho sem curiosidade: use pergunta, número ou revelação" }); }
    draft.forEach((d, i) => {
      if (est(d) > 4.5) { score -= 4; issues.push({ i, msg: `Cena longa (${est(d).toFixed(1)}s) — risco de rolagem, divida em 2` }); }
      if (!d.asset_id) { score -= 3; issues.push({ i, msg: "Sem mídia escolhida" }); }
      if (i > 0 && d.motion === "static" && draft[i - 1]!.motion === "static") { score -= 3; issues.push({ i, msg: "Duas cenas paradas seguidas — adicione movimento" }); }
    });
    setAudit({ score: Math.max(0, Math.min(100, score)), hook, issues });
  }
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* Barra superior */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-semibold text-foreground">Estúdio</span>
        <span className="text-muted-foreground">{draft.length} cenas · {fmt(total)}</span>
        {dirty && <span className="text-warning">Alterações não salvas</span>}
        <StudioStatus productionId={productionId} />
        <span className="flex-1" />
        <select aria-label="Filtro de cor" className="rounded-md border border-border bg-background px-2 py-1.5 text-xs" value={look["color_grade"] ?? "natural"} onChange={(e) => saveLook("color_grade", e.target.value)}>
          {COLORS.map((c) => <option key={c.id} value={c.id}>Cor: {c.name}</option>)}
        </select>
        <select aria-label="Estilo da legenda" className="rounded-md border border-border bg-background px-2 py-1.5 text-xs" value={look["caption_resolved"] ?? "hormozi"} onChange={(e) => saveLook("caption_resolved", e.target.value)}>
          {CAPTIONS.map((c) => <option key={c.id} value={c.id}>Legenda: {c.name}</option>)}
        </select>
        <button className={btn} onClick={() => setPanel((v) => !v)}>{panel ? "Esconder painel" : "Mostrar painel"}</button>
        <button className={btn} disabled={busy || !dirty} onClick={save}>Salvar</button>
        <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy} onClick={rerender}>Renderizar vídeo</button>
        <button className={btn} onClick={runAudit}>Auditar viralidade</button>
        <button className={btn} onClick={exportCapcut}>Exportar para CapCut</button>
      </div>
      {audit && (
        <div className="border-b border-border px-3 py-2 text-xs">
          <div className="flex items-center gap-3">
            <span className={"text-lg font-bold " + (audit.score >= 80 ? "text-primary" : audit.score >= 60 ? "text-warning" : "text-destructive")}>{audit.score}/100</span>
            <span className="text-muted-foreground">{audit.hook} · {audit.issues.length} pontos de fuga</span>
            <span className="flex-1" />
            <button className={btn} onClick={() => setAudit(null)}>Fechar</button>
          </div>
          <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto">
            {audit.issues.map((x, k) => <li key={k}><button className="text-left hover:underline" onClick={() => { setSel(x.i); setT(starts[x.i] ?? 0); }}><span className="text-destructive">● Cena {x.i + 1}:</span> {x.msg}</button></li>)}
          </ul>
        </div>
      )}

      <div className={"grid gap-0 " + (panel ? "lg:grid-cols-[1fr_340px]" : "")}>
        {/* Player central */}
        <div className="flex flex-col items-center justify-center gap-3 bg-muted/40 p-4">
          <div className={wide ? "w-full max-w-3xl" : "w-full max-w-[300px]"}>
            <PhonePreview assetId={cur.asset_id} text={cur.caption || cur.narration} wide={wide} big />
          </div>
          <div className="flex items-center gap-2 text-xs">
            <button className={btn} disabled={sel === 0} onClick={() => { setSel(sel - 1); setT(starts[sel - 1] ?? 0); }}>⏮</button>
            <button className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground" onClick={() => { if (!playing && t >= total - 0.1) setT(0); setPlaying((v) => !v); }}>{playing ? "❚❚ Pausar" : "▶ Assistir"}</button>
            <button className={btn} disabled={sel === draft.length - 1} onClick={() => { setSel(sel + 1); setT(starts[sel + 1] ?? 0); }}>⏭</button>
            <span className="tabular-nums text-muted-foreground">{fmt(t)} / {fmt(total)}</span>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">Prévia sem voz: a narração e a música entram no vídeo renderizado.</p>
        </div>

        {/* Painel lateral retrátil */}
        {panel && (
          <div className="max-h-[640px] space-y-3 overflow-y-auto border-l border-border p-3 text-xs">
            <div className="flex items-center justify-between font-semibold text-foreground"><span>Cena {sel + 1}</span><span className="text-muted-foreground">{est(cur).toFixed(1)}s</span></div>
            <div className="space-y-2">
              <div className="font-medium text-foreground">Mídia</div>
              <SceneMedia assetId={cur.asset_id} />
              <div className="flex flex-wrap gap-2">
                <label className={btn + " cursor-pointer"}>Trocar mídia<input type="file" accept="image/*,video/*" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) swapMedia(f); }} /></label>
                <button className={btn} onClick={() => setPick((p) => !p)}>Do acervo</button>
                <button className={btn} onClick={() => window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(cur.visual_query || cur.visual_description || cur.narration.slice(0, 60))}`, "_blank")}>YouTube</button>
                {cur.asset_id && <button className={btn} onClick={() => edit({ asset_id: null })}>Automática</button>}
              </div>
              {pick && <LibraryPicker onPick={(id) => { edit({ asset_id: id }); setPick(false); toast.success(`Mídia do acervo na cena ${sel + 1}. Salve e renderize para aplicar.`); }} />}
            </div>
            <label className="block text-muted-foreground">Cortar início do clipe: <b className="text-foreground">{trimIn.toFixed(1)}s</b>
              <input type="range" min={0} max={20} step={0.5} value={trimIn} onChange={(e) => setTrims((m) => ({ ...m, [String(sel)]: { in: Number(e.target.value) } }))} onMouseUp={(e) => saveTrim(Number((e.target as HTMLInputElement).value))} onTouchEnd={(e) => saveTrim(Number((e.target as HTMLInputElement).value))} className="mt-1 w-full accent-primary" />
            </label>
            <label className="block text-muted-foreground">
              <span className="flex justify-between"><span>Fala</span><span>{cur.narration.split(/\s+/).filter(Boolean).length} palavras</span></span>
              <textarea rows={3} value={cur.narration} onChange={(e) => edit({ narration: e.target.value })} className={field + " mt-1"} />
            </label>
            <label className="block text-muted-foreground">Legenda em destaque
              <input value={cur.caption} onChange={(e) => edit({ caption: e.target.value })} className={field + " mt-1"} />
            </label>
            <label className="block text-muted-foreground">Busca da mídia (nome da pessoa primeiro)
              <input value={cur.visual_query} onChange={(e) => edit({ visual_query: e.target.value })} className={field + " mt-1"} />
            </label>
            <label className="block text-muted-foreground">O que aparece na tela
              <textarea rows={2} value={cur.visual_description} onChange={(e) => edit({ visual_description: e.target.value })} className={field + " mt-1"} />
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-muted-foreground">Câmera<select value={cur.motion} onChange={(e) => edit({ motion: e.target.value })} className={field + " mt-1"}>{MOTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="text-muted-foreground">Passagem<select value={cur.transition} onChange={(e) => edit({ transition: e.target.value })} className={field + " mt-1"}>{TRANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="text-muted-foreground">Respiro<select value={PAUSES.reduce((b, p) => (Math.abs(p[0] - cur.pause_after_ms) < Math.abs(b[0] - cur.pause_after_ms) ? p : b))[0]} onChange={(e) => edit({ pause_after_ms: Number(e.target.value) })} className={field + " mt-1"}>{PAUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            </div>
            <div className="flex gap-2">
              <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Pedido à IA, ex.: mais suspense" className={field + " min-w-0 flex-1"} />
              <button className={btn} disabled={busy} onClick={rewrite}>{busy ? "…" : "Refazer"}</button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button className={btn} disabled={sel === 0} onClick={() => move(-1)}>← Mover</button>
              <button className={btn} disabled={sel === draft.length - 1} onClick={() => move(1)}>Mover →</button>
              <button className={btn} onClick={addAfter}>+ Cena</button>
              <button className={btn + " text-destructive"} onClick={remove}>Excluir</button>
            </div>
          </div>
        )}
      </div>

      {/* Linha do tempo multifaixa */}
      <div className="border-t border-border bg-background p-2">
        <div ref={trackRef} className="relative overflow-x-auto pb-1" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(e.clientX - r.left + e.currentTarget.scrollLeft - 56); }}>
          <div className="relative space-y-1" style={{ width: total * PX + 64 }}>
            {/* régua */}
            <div className="ml-14 flex h-4 text-[9px] text-muted-foreground">
              {Array.from({ length: Math.ceil(total / 5) + 1 }, (_, k) => <span key={k} style={{ width: 5 * PX }} className="shrink-0 border-l border-border pl-0.5">{fmt(k * 5)}</span>)}
            </div>
            <Track label="Vídeo">
              {draft.map((d, i) => (
                <button key={d.id ?? `v-${i}`} onClick={(e) => { e.stopPropagation(); setSel(i); setT(starts[i]!); }} style={{ width: est(d) * PX }} className={"relative h-14 shrink-0 overflow-hidden rounded border-2 " + (i === sel ? "border-primary" : "border-transparent")}>
                  <SceneThumb assetId={d.asset_id} tall />
                  <span className="absolute left-0.5 top-0.5 rounded bg-background/80 px-1 text-[9px]">{i + 1}</span>
                  {(trims[String(i)]?.in ?? 0) > 0 && <span className="absolute bottom-0.5 right-0.5 rounded bg-primary px-1 text-[9px] text-primary-foreground">✂ {trims[String(i)]!.in}s</span>}
                  {i === sel && <><span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-primary" /><span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-primary" /></>}
                </button>
              ))}
            </Track>
            <Track label="Legenda">
              {draft.map((d, i) => <div key={d.id ?? `c-${i}`} style={{ width: est(d) * PX }} className={"h-6 shrink-0 truncate rounded px-1 text-[9px] leading-6 " + (i === sel ? "bg-primary/30 text-foreground" : "bg-accent text-muted-foreground")}>{d.caption || d.narration}</div>)}
            </Track>
            <Track label="Voz">
              {draft.map((d, i) => <div key={d.id ?? `a-${i}`} style={{ width: est(d) * PX }} className="h-5 shrink-0 rounded bg-secondary [background-image:repeating-linear-gradient(90deg,hsl(var(--primary)/.35)_0_2px,transparent_2px_5px)]" />)}
            </Track>
            {/* agulha */}
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive" style={{ left: 56 + t * PX }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Track({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5">
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Lista o acervo do usuário para escolher a mídia de uma cena. */
function LibraryPicker({ onPick }: { onPick: (assetId: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["acervo"],
    queryFn: async () => (await supabase.from("assets").select("id, kind, storage_path, description, production_id").is("production_id", null).eq("source", "upload").in("kind", ["image", "video"]).not("storage_path", "is", null).order("created_at", { ascending: false })).data ?? [],
  });
  if (isLoading) return <div className="mt-2 text-xs text-muted-foreground">Abrindo acervo…</div>;
  if (!data?.length) return (
    <div className="mt-2 rounded border border-dashed border-border p-2 text-xs text-muted-foreground">
      Seu acervo está vazio. Envie fotos e vídeos na aba <b>Acervo</b> e eles aparecem aqui.
    </div>
  );
  return (
    <div className="mt-2 grid max-h-64 grid-cols-3 gap-2 overflow-y-auto rounded border border-border p-2 sm:grid-cols-4">
      {data.map((a) => <LibraryThumb key={a.id} asset={a} onPick={() => onPick(a.id)} />)}
    </div>
  );
}

function LibraryThumb({ asset, onPick }: { asset: { id: string; kind: string; storage_path: string | null; description: string | null }; onPick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const path = asset.storage_path;
  useQuery({
    queryKey: ["acervo-url", asset.id],
    queryFn: async () => {
      if (!path) return null;
      const { data } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      setUrl(data?.signedUrl ?? null);
      return data?.signedUrl ?? null;
    },
  });
  return (
    <button onClick={onPick} title={asset.description ?? ""} className="group relative overflow-hidden rounded border border-border hover:border-primary">
      {url ? (
        asset.kind === "video" ? <video src={url} muted playsInline className="aspect-video w-full object-cover" /> : <img src={url} alt="" className="aspect-video w-full object-cover" />
      ) : <div className="aspect-video w-full bg-muted" />}
      <span className="absolute inset-x-0 bottom-0 line-clamp-1 bg-background/80 px-1 text-[9px] text-muted-foreground">{asset.description || "sem descrição"}</span>
    </button>
  );
}
/** Miniatura da mídia da cena na linha do tempo (mesma consulta da prévia). */
function SceneThumb({ assetId, tall }: { assetId: string | null; tall?: boolean }) {
  const { data } = useQuery({
    queryKey: ["asset-preview", assetId],
    enabled: !!assetId,
    refetchInterval: (q) => (q.state.data?.url ? false : 6000),
    queryFn: async () => {
      const { data: a } = await supabase.from("assets").select("kind, source, storage_path, attribution, meta").eq("id", assetId!).maybeSingle();
      if (!a) return null;
      const thumb = (a.meta as { thumb?: string } | null)?.thumb;
      const p = a.storage_path ?? thumb ?? null;
      const url = p ? (await supabase.storage.from("media").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;
      return { ...a, kind: a.storage_path ? a.kind : "image", url };
    },
  });
  const h = tall ? "h-full" : "h-10";
  if (!assetId || !data?.url) return <div className={h + " flex w-full items-center justify-center rounded bg-muted text-[9px] text-muted-foreground"}>{assetId ? "…" : "auto"}</div>;
  return data.kind === "video" ? <video src={data.url + "#t=0.5"} muted preload="metadata" className={h + " w-full rounded object-cover"} /> : <img src={data.url} alt="" className={h + " w-full rounded object-cover"} />;
}

function SceneMedia({ assetId }: { assetId: string | null }) {
  const { data } = useQuery({
    queryKey: ["asset-preview", assetId],
    enabled: !!assetId,
    refetchInterval: (q) => (q.state.data?.url ? false : 6000),
    queryFn: async () => {
      const { data: a } = await supabase.from("assets").select("kind, source, storage_path, attribution, meta").eq("id", assetId!).maybeSingle();
      if (!a) return null;
      const thumb = (a.meta as { thumb?: string } | null)?.thumb;
      const p = a.storage_path ?? thumb ?? null;
      const url = p ? (await supabase.storage.from("media").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;
      return { ...a, kind: a.storage_path ? a.kind : "image", url };
    },
  });
  if (!assetId) return <div className="mt-1 rounded border border-dashed border-border p-2">Automática (o agente busca pela descrição)</div>;
  if (!data) return <div className="mt-1">…</div>;
  return (
    <div className="mt-1 space-y-1">
      {data.url ? (data.kind === "video" ? <video src={data.url} muted controls className="h-24 rounded" /> : <img src={data.url} alt="" className="h-24 rounded object-cover" />) : null}
      <div>{(data.meta as { locked?: boolean } | null)?.locked ? "Escolhida por você" : `Fonte: ${data.source}`}{data.attribution ? ` · ${data.attribution}` : ""}</div>
    </div>
  );
}

/** Prévia vertical 9:16: mídia sobre fundo desfocado + legenda animada. */
function PhonePreview({ assetId, text, wide, big }: { assetId: string | null; text: string; wide?: boolean; big?: boolean }) {
  const { data } = useQuery({
    queryKey: ["asset-preview", assetId],
    enabled: !!assetId,
    refetchInterval: (q) => (q.state.data?.url ? false : 6000),
    queryFn: async () => {
      const { data: a } = await supabase.from("assets").select("kind, source, storage_path, attribution, meta").eq("id", assetId!).maybeSingle();
      if (!a) return null;
      const thumb = (a.meta as { thumb?: string } | null)?.thumb;
      const p = a.storage_path ?? thumb ?? null;
      const url = p ? (await supabase.storage.from("media").createSignedUrl(p, 3600)).data?.signedUrl ?? null : null;
      return { ...a, kind: a.storage_path ? a.kind : "image", url };
    },
  });
  const url = assetId ? data?.url : null;
  const isVid = data?.kind === "video";
  return (
    <div className={"relative shrink-0 overflow-hidden rounded-lg border border-border bg-muted " + (wide ? "aspect-video w-full" : big ? "aspect-[9/16] w-full" : "aspect-[9/16] w-40")}>
      {url ? (
        <>
          {isVid ? <video src={url} muted autoPlay loop playsInline className="absolute inset-0 h-full w-full scale-125 object-cover blur-lg" /> : <img src={url} alt="" className="absolute inset-0 h-full w-full scale-125 object-cover blur-lg" />}
          {isVid ? <video src={url} muted autoPlay loop playsInline className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 object-contain" /> : <img src={url} alt="" className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2 object-contain" />}
        </>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-2 text-center text-[10px] text-muted-foreground">Mídia automática</div>
      )}
      <div className={"absolute inset-x-1 " + (wide ? "bottom-[8%]" : "bottom-[22%]")}><CaptionPreview text={text} compact big={!!big} /></div>
    </div>
  );
}

/** Prévia de como a legenda aparece palavra por palavra (estilo CapCut). */
function CaptionPreview({ text, compact, big }: { text: string; compact?: boolean; big?: boolean }) {
  const words = text.split(/\s+/).filter(Boolean);
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    if (!words.length) return;
    const t = setInterval(() => setI((x) => (x + 1) % words.length), 400);
    return () => clearInterval(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!words.length) return null;
  const start = Math.floor(i / 3) * 3;
  if (compact) return (
    <div className={"text-center font-black uppercase " + (big ? "text-2xl" : "text-sm") + " leading-tight text-background [text-shadow:0_0_3px_hsl(0_0%_0%),0_0_3px_hsl(0_0%_0%)]"}>
      {words.slice(start, start + 3).map((w, k) => <span key={k} className={start + k === i ? "text-primary" : ""}>{w} </span>)}
    </div>
  );
  return (
    <div className="rounded-md bg-foreground/90 p-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-background/60">Prévia da legenda palavra por palavra</div>
      <div className="text-lg font-black uppercase text-background">
        {words.slice(start, start + 3).map((w, k) => <span key={k} className={start + k === i ? "text-primary" : ""}>{w} </span>)}
      </div>
    </div>
  );
}
