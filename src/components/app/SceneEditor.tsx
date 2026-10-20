import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { rerenderProduction } from "@/lib/jobs";
import { rewriteScene } from "@/lib/ai.functions";

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

const field = "w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

/** Estimated seconds of speech for a scene (≈2.5 words/s) when it was not narrated yet. */
const est = (d: Draft) => d.duration_s ?? Math.max(1.5, d.narration.split(/\s+/).filter(Boolean).length / 2.5 + d.pause_after_ms / 1000);

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
  const [ask, setAsk] = useState("");
  const [pick, setPick] = useState(false);

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

      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">Movimento da imagem
          <select value={cur.motion} onChange={(e) => edit({ motion: e.target.value })} className={field + " mt-1"}>{MOTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="text-xs text-muted-foreground">Transição para a próxima
          <select value={cur.transition} onChange={(e) => edit({ transition: e.target.value })} className={field + " mt-1"}>{TRANS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <div className="text-xs text-muted-foreground">Mídia da cena
          <SceneMedia assetId={cur.asset_id} />
          <div className="mt-1 flex flex-wrap gap-2">
            <label className={btn + " cursor-pointer"}>Trocar por arquivo meu<input type="file" accept="image/*,video/*" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) swapMedia(f); }} /></label>
            <button className={btn} onClick={() => setPick((p) => !p)}>Usar do acervo</button>
            {cur.asset_id && <button className={btn} onClick={() => edit({ asset_id: null })}>Buscar automática</button>}
          </div>
          {pick && <LibraryPicker onPick={(id) => { edit({ asset_id: id }); setPick(false); toast.success(`Mídia do acervo na cena ${sel + 1}. Salve e renderize para aplicar.`); }} />}
        </div>
      </div>
      <CaptionPreview text={cur.caption || cur.narration} />

      <div className="flex flex-wrap gap-2">
        <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Pedido para a IA (opcional), ex.: mais suspense" className={field + " min-w-0 flex-1"} />
        <button className={btn} disabled={busy} onClick={rewrite}>{busy ? "Aguarde…" : "Refazer esta cena com IA"}</button>
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

/** Lista o acervo do usuário para escolher a mídia de uma cena. */
function LibraryPicker({ onPick }: { onPick: (assetId: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["acervo"],
    queryFn: async () => (await supabase.from("assets").select("id, kind, storage_path, description, production_id").is("production_id", null).eq("source", "upload").in("kind", ["image", "video"]).order("created_at", { ascending: false })).data ?? [],
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

function LibraryThumb({ asset, onPick }: { asset: { id: string; kind: string; storage_path: string; description: string | null }; onPick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useQuery({
    queryKey: ["acervo-url", asset.id],
    queryFn: async () => {
      const { data } = await supabase.storage.from("media").createSignedUrl(asset.storage_path, 3600);
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
function SceneMedia({ assetId }: { assetId: string | null }) {
  const { data } = useQuery({
    queryKey: ["asset-preview", assetId],
    enabled: !!assetId,
    queryFn: async () => {
      const { data: a } = await supabase.from("assets").select("kind, source, storage_path, attribution, meta").eq("id", assetId!).maybeSingle();
      if (!a) return null;
      const url = a.storage_path ? (await supabase.storage.from("media").createSignedUrl(a.storage_path, 3600)).data?.signedUrl ?? null : null;
      return { ...a, url };
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

/** Prévia de como a legenda aparece palavra por palavra (estilo CapCut). */
function CaptionPreview({ text }: { text: string }) {
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
  return (
    <div className="rounded-md bg-foreground/90 p-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-background/60">Prévia da legenda palavra por palavra</div>
      <div className="text-lg font-black uppercase text-background">
        {words.slice(start, start + 3).map((w, k) => <span key={k} className={start + k === i ? "text-primary" : ""}>{w} </span>)}
      </div>
    </div>
  );
}
