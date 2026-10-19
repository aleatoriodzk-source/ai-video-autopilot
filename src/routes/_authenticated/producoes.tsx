import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";
import { activeJob, setJobStatus, startProduction } from "@/lib/jobs";
import { generateScript } from "@/lib/ai.functions";
import { SceneEditor } from "@/components/app/SceneEditor";

export const Route = createFileRoute("/_authenticated/producoes")({
  head: () => ({
    meta: [
      { title: "Produções — Estúdio Automático" },
      { name: "description", content: "Crie vídeos, gere roteiros e controle a automação." },
      { property: "og:title", content: "Produções — Estúdio Automático" },
      { property: "og:description", content: "Crie vídeos, gere roteiros e controle a automação." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Producoes,
});

const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50";

function Producoes() {
  const qc = useQueryClient();
  const [topic, setTopic] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [mode, setMode] = useState("auto");
  const [minutes, setMinutes] = useState("1");
  const [scenes, setScenes] = useState("");
  const [refId, setRefId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const { data: refs } = useQuery({ queryKey: ["refs"], queryFn: async () => (await supabase.from("reference_sources").select("id,title,urls")).data ?? [] });
  const { data: prods } = useQuery({
    queryKey: ["prods"],
    queryFn: async () => (await supabase.from("productions").select("id,title,topic,aspect,mode,status,script,reference_id,created_at,settings,preview_path,output_path").order("created_at", { ascending: false })).data ?? [],
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["prods"] });

  async function create() {
    if (!topic.trim()) { toast.error("Informe um tema ou instrução"); return; }
    const min = Number(minutes.replace(",", "."));
    if (!(min >= 0.25 && min <= 30)) { toast.error("Duração entre 0,25 e 30 minutos"); return; }
    const sc = scenes ? Number(scenes) : null;
    if (sc !== null && !(sc >= 2 && sc <= 300)) { toast.error("Cenas entre 2 e 300"); return; }
    const { data: u } = await supabase.auth.getUser();
    const settings = { target_seconds: Math.round(min * 60), ...(sc ? { scene_count: sc } : {}) };
    const { error } = await supabase.from("productions").insert({ user_id: u.user!.id, title: topic.slice(0, 80), topic, aspect, mode, reference_id: refId || null, settings });
    if (error) { toast.error(error.message); return; }
    setTopic(""); toast.success("Produção criada"); refresh();
  }

  async function run(id: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(id);
    try { await fn(); toast.success(ok); refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  async function script(id: string) {
    await run(id, async () => {
      const r = await generateScript({ data: { productionId: id } });
      if (!r.ok) throw new Error(r.error);
      await qc.invalidateQueries({ queryKey: ["scenes", id] });
      setOpen(id);
    }, "Roteiro gerado");
  }

  async function control(id: string, status: "paused" | "queued" | "cancelled") {
    await run(id, async () => {
      const j = await activeJob(id);
      if (!j) throw new Error("Nenhuma tarefa ativa");
      await setJobStatus(j.id, status);
    }, "Atualizado");
  }

  return (
    <div>
      <PageHeader title="Produções" subtitle="Crie um vídeo a partir de um tema. No modo automático o agente local executa todas as etapas; no assistido ele para para você aprovar cada uma." />
      <div className="panel mb-6 grid gap-3 p-4 md:grid-cols-2">
        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={2} placeholder="Tema ou instrução, ex.: 5 curiosidades sobre o oceano profundo" className={input + " md:col-span-2"} />
        <select value={refId} onChange={(e) => setRefId(e.target.value)} className={input}>
          <option value="">Sem referência</option>
          {refs?.map((r) => <option key={r.id} value={r.id}>{r.title ?? r.urls[0]}</option>)}
        </select>
        <div className="flex gap-2">
          <select value={aspect} onChange={(e) => setAspect(e.target.value)} className={input}>
            <option value="9:16">9:16 vertical</option><option value="16:9">16:9 horizontal</option><option value="1:1">1:1 quadrado</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={input}>
            <option value="auto">Automático</option><option value="assisted">Assistido</option>
          </select>
        </div>
        <label className="text-xs text-muted-foreground">Duração (minutos)
          <input type="number" min={0.25} max={30} step={0.25} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={input + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground">Número de cenas (vazio = automático)
          <input type="number" min={2} max={300} value={scenes} onChange={(e) => setScenes(e.target.value)} placeholder="automático" className={input + " mt-1"} />
        </label>
        <button onClick={create} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground md:col-span-2">Criar produção</button>
      </div>

      {!prods?.length ? <Empty>Nenhuma produção ainda.</Empty> : (
        <div className="space-y-2">
          {prods.map((p) => {
            const s = p.script as { title?: string; scenes?: unknown[] } | null;
            const b = busy === p.id;
            return (
              <div key={p.id} className="panel space-y-3 p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium">{s?.title ?? p.title}</div>
                    <div className="text-xs text-muted-foreground">{p.aspect} · {p.mode === "auto" ? "automático" : "assistido"} · {(() => { const t = Number((p.settings as Record<string, unknown> | null)?.["target_seconds"] ?? 0); return t ? `${Math.round(t / 6) / 10} min · ` : ""; })()}{s?.scenes ? `roteiro com ${s.scenes.length} cenas` : "sem roteiro"}</div>
                  </div>
                  <StatusBadge status={p.status} />
                </div>
                {p.preview_path ? <VideoPlayer path={p.preview_path} /> : p.output_path ? <div className="text-xs text-muted-foreground">Salvo só no computador: {p.output_path}</div> : null}
                <div className="flex flex-wrap gap-2">
                  <button disabled={b} className={btn} onClick={() => script(p.id)}>{s ? "Refazer roteiro" : "Gerar roteiro"}</button>
                  <button disabled={b} className={btn} onClick={() => run(p.id, () => startProduction(p.id, { needsAnalysis: !!p.reference_id, referenceId: p.reference_id }), "Automação iniciada — aguardando o agente local")}>Iniciar automação</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "paused")}>Pausar</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "queued")}>Retomar</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "cancelled")}>Cancelar</button>
                  {s ? <button className={btn + (open === p.id ? " bg-accent" : "")} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Fechar cenas" : "Ver e editar cenas"}</button> : null}
                </div>
                {open === p.id ? <SceneEditor productionId={p.id} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VideoPlayer({ path }: { path: string }) {
  const { data: url, error } = useQuery({
    queryKey: ["video-url", path],
    queryFn: async () => {
      const { data, error } = await supabase.storage.from("media").createSignedUrl(path, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
    staleTime: 50 * 60_000,
  });
  if (error) return <div className="text-xs text-destructive">Não foi possível carregar o vídeo: {(error as Error).message}</div>;
  if (!url) return <div className="text-xs text-muted-foreground">Carregando vídeo…</div>;
  return (
    <div className="space-y-2">
      <video src={url} controls preload="metadata" className="max-h-[480px] w-full rounded-md bg-muted" />
      <a href={url} download className={btn + " inline-block"}>Baixar MP4</a>
    </div>
  );
}
