import { Timeline } from "@/components/app/Timeline";
import { VoicePicker } from "@/components/app/VideoOptions";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, StatusBadge, Empty } from "@/components/app/ui";
import { activeJob, setJobStatus, startProduction } from "@/lib/jobs";
import { generateScript, postKit } from "@/lib/ai.functions";
import { SceneEditor } from "@/components/app/SceneEditor";
import { JobStatus } from "@/components/app/JobStatus";
import { ScriptView } from "@/components/app/ScriptView";
import { suggestedSeconds } from "@/lib/duration";

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
  const [style, setStyle] = useState("tiktok");
  const [aiProvider, setAiProvider] = useState("");
  const [refId, setRefId] = useState("");
  const [voice, setVoice] = useState("pt-BR-AntonioNeural");
  const [rate, setRate] = useState("+5%");
  const [mood, setMood] = useState("auto");
  const [scriptMode, setScriptMode] = useState<"ai" | "ready">("ai");
  const [readyScript, setReadyScript] = useState("");
  const [captionStyle, setCaptionStyle] = useState("auto");
  const [mediaRule, setMediaRule] = useState("auto");
  const [sfxOn, setSfxOn] = useState("off");
  const [baseCaps, setBaseCaps] = useState("hide");
  const [sourceMode, setSourceMode] = useState("search");
  const [voiceId, setVoiceId] = useState("");
  const [scenesRef, setScenesRef] = useState("");
  const [scenesUrl, setScenesUrl] = useState("");
  const [base1, setBase1] = useState("");
  const [base2, setBase2] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<string | null>(null);
  const [kit, setKit] = useState<string | null>(null);

  const { data: refs } = useQuery({ queryKey: ["refs"], queryFn: async () => (await supabase.from("reference_sources").select("id,title,urls")).data ?? [] });
  const { data: voices } = useQuery({ queryKey: ["voices"], queryFn: async () => (await supabase.from("voices").select("id,name,status")).data ?? [] });
  const { data: prods } = useQuery({
    queryKey: ["prods"],
    queryFn: async () => (await supabase.from("productions").select("id,title,topic,aspect,mode,status,script,reference_id,created_at,settings,preview_path,output_path,versions,validation").order("created_at", { ascending: false })).data ?? [],
    refetchInterval: 10_000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["prods"] });

  async function create() {
    if (!topic.trim()) { toast.error(scriptMode === "ready" ? "Dê um título para o vídeo" : "Informe um tema ou instrução"); return; }
    const link = scenesUrl.trim();
    const baseLinks = [base1, base2].map((x) => x.trim()).filter(Boolean);
    if (baseLinks.some((x) => !/^https?:\/\//.test(x))) { toast.error("Link de vídeo base inválido"); return; }
    if (sourceMode === "reference" && !scenesRef && !/^https?:\/\//.test(link)) { toast.error("Escolha ou cole o link do vídeo das cenas"); return; }
    if (scriptMode === "ready" && readyScript.trim().split(/\s+/).length < 10) { toast.error("Cole o roteiro pronto (pelo menos algumas frases)"); return; }
    const min = Number(minutes.replace(",", "."));
    if (!(min >= 0.25 && min <= 30)) { toast.error("Duração entre 0,25 e 30 minutos"); return; }
    const sc = scenes ? Number(scenes) : null;
    if (sc !== null && !(sc >= 2 && sc <= 300)) { toast.error("Cenas entre 2 e 300"); return; }
    const { data: u } = await supabase.auth.getUser();
    let srcId = scenesRef;
    if (sourceMode === "reference" && !srcId) {
      const { data: r, error: e } = await supabase.from("reference_sources").insert({ user_id: u.user!.id, urls: [link], platform: /tiktok\.com/.test(link) ? "tiktok" : "youtube", kind: "video", title: "Cenas: " + topic.trim().slice(0, 60) }).select("id").single();
      if (e) { toast.error(e.message); return; }
      srcId = r.id; qc.invalidateQueries({ queryKey: ["refs"] });
    }
    let lib: { color?: string } = {};
    try { lib = JSON.parse(localStorage.getItem("biblioteca-escolha") || "{}"); } catch { /* sem escolha */ }
    const settings = {
      ...(lib.color && lib.color !== "natural" ? { color_grade: lib.color } : {}),
      target_seconds: Math.round(min * 60), style, voice, voice_rate: rate, music_mood: mood, caption_style: captionStyle, media_rule: mediaRule, sfx: sfxOn, base_captions: baseCaps,
      source_mode: sourceMode, ...(voiceId ? { voice_id: voiceId } : {}),
      ...(sourceMode === "reference" && srcId ? { scenes_reference_id: srcId } : {}),
      ...(scriptMode === "ready" ? { ready_script: readyScript.trim() } : {}),
      ...(aiProvider ? { ai_provider: aiProvider } : {}), ...(sc ? { scene_count: sc } : {}),
      ...(baseLinks.length ? { source_urls: baseLinks } : {}),
    };
    const is34 = aspect === "3:4";
    const { error } = await supabase.from("productions").insert({ user_id: u.user!.id, title: topic.trim().slice(0, 80), topic: topic.trim(), aspect: is34 ? "9:16" : aspect, mode, reference_id: refId || null, settings: is34 ? { ...settings, aspect_override: "3:4" } : settings });
    if (error) { toast.error(error.message); return; }
    setTopic(""); setReadyScript(""); toast.success("Produção criada"); refresh();
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

  async function remove(id: string) {
    if (!window.confirm("Excluir esta produção? Isso apaga roteiro, cenas e histórico dela.")) return;
    await run(id, async () => {
      const { data: js } = await supabase.from("jobs").select("id").eq("production_id", id);
      const jids = (js ?? []).map((j) => j.id);
      if (jids.length) { await supabase.from("activity_logs").delete().in("job_id", jids); await supabase.from("usage_records").delete().in("job_id", jids); }
      await supabase.from("activity_logs").delete().eq("production_id", id);
      await supabase.from("usage_records").delete().eq("production_id", id);
      await supabase.from("jobs").delete().eq("production_id", id);
      await supabase.from("scenes").delete().eq("production_id", id);
      await supabase.from("assets").delete().eq("production_id", id);
      const { error } = await supabase.from("productions").delete().eq("id", id);
      if (error) throw error;
    }, "Produção excluída");
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
        <div className="flex gap-2 md:col-span-2">
          <button type="button" className={btn + (scriptMode === "ai" ? " bg-accent" : "")} onClick={() => setScriptMode("ai")}>IA cria o roteiro</button>
          <button type="button" className={btn + (scriptMode === "ready" ? " bg-accent" : "")} onClick={() => setScriptMode("ready")}>Tenho roteiro pronto</button>
        </div>
        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={scriptMode === "ready" ? 1 : 2} placeholder={scriptMode === "ready" ? "Título do vídeo, ex.: Curiosidades do Thor" : "Tema ou instrução, ex.: Curiosidades do Thor (o título fica exatamente como você escrever)"} className={input + " md:col-span-2"} />
        {scriptMode === "ready" && (
          <textarea value={readyScript} onChange={(e) => setReadyScript(e.target.value)} rows={8} placeholder="Cole aqui o seu roteiro. O sistema não muda nenhuma palavra: só divide em cenas, escolhe os clipes, narra e monta." className={input + " md:col-span-2"} />
        )}
        {scriptMode === "ready" && readyScript.trim() && (() => {
          const secs = suggestedSeconds(readyScript, rate);
          const mins = Math.max(0.25, Math.ceil((secs / 60) * 4) / 4);
          const words = readyScript.trim().split(/\s+/).length;
          return (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs md:col-span-2">
              <span>{words} palavras · tempo sugerido: ~{secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}min ${secs % 60}s`} {secs <= 90 ? "(ótimo para Shorts/TikTok)" : secs <= 180 ? "(Short longo / Reels)" : "(melhor como vídeo longo)"}</span>
              <button type="button" className={btn} onClick={() => setMinutes(String(mins))}>Ajustar duração para {String(mins).replace(".", ",")} min</button>
            </div>
          );
        })()}
        <label className="text-xs text-muted-foreground">Tipo de mídia
          <select value={mediaRule} onChange={(e) => setMediaRule(e.target.value)} className={input + " mt-1"}>
            <option value="auto">Automático (segue a referência)</option><option value="video_only">Somente vídeos (ex.: Marvel, filmes, games)</option><option value="image_only">Somente fotos (documentários, TV, histórias)</option><option value="mixed">Vídeos e fotos</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Estilo da legenda
          <select value={captionStyle} onChange={(e) => setCaptionStyle(e.target.value)} className={input + " mt-1"}>
            <option value="auto">Automático (cor da referência)</option><option value="neon">Verde neon (CapCut)</option><option value="hormozi">Amarelo forte (Hormozi)</option><option value="red">Vermelho impacto</option><option value="clean">Branco minimalista</option><option value="none">Sem legenda</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Efeitos sonoros
          <select value={sfxOn} onChange={(e) => setSfxOn(e.target.value)} className={input + " mt-1"}>
            <option value="off">Sem efeitos sonoros</option><option value="on">Com efeitos sonoros</option>
          </select>
        </label>
        {sourceMode === "reference" && (
          <label className="text-xs text-muted-foreground">Legenda que já vem no vídeo das cenas
            <select value={baseCaps} onChange={(e) => setBaseCaps(e.target.value)} className={input + " mt-1"}>
              <option value="hide">Esconder (desfoca a faixa de texto)</option><option value="keep">Manter como está</option>
            </select>
          </label>
        )}
        <label className="text-xs text-muted-foreground">Vídeo de estilo (o curto que ele copia: ritmo, legenda, gancho)
          <select value={refId} onChange={(e) => setRefId(e.target.value)} className={input + " mt-1"}>
            <option value="">Sem referência de estilo</option>
            {refs?.map((r) => <option key={r.id} value={r.id}>{r.title ?? r.urls[0]}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <select value={aspect} onChange={(e) => setAspect(e.target.value)} className={input}>
            <option value="9:16">9:16 vertical</option><option value="3:4">3:4 retrato</option><option value="16:9">16:9 horizontal</option><option value="1:1">1:1 quadrado</option>
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={input}>
            <option value="auto">Automático</option><option value="assisted">Assistido</option>
          </select>
          <select value={style} onChange={(e) => { setStyle(e.target.value); if (e.target.value === "youtube") { setAspect("16:9"); setMinutes("8"); } else { setAspect("9:16"); setMinutes("1"); } }} className={input}>
            <option value="tiktok">TikTok/Shorts (dopamina)</option><option value="youtube">YouTube longo</option>
          </select>
        </div>
        <label className="text-xs text-muted-foreground">Duração (minutos)
          <input type="number" min={0.25} max={30} step={0.25} value={minutes} onChange={(e) => setMinutes(e.target.value)} className={input + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground">Número de cenas (vazio = automático)
          <input type="number" min={2} max={300} value={scenes} onChange={(e) => setScenes(e.target.value)} placeholder="automático" className={input + " mt-1"} />
        </label>
        <label className="text-xs text-muted-foreground md:col-span-2">IA para o roteiro
          <select value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className={input + " mt-1"}>
            <option value="">Padrão (definida em Chaves de IA)</option><option value="gemini">Gemini</option><option value="openai">ChatGPT</option><option value="anthropic">Claude</option><option value="lovable">Créditos da plataforma</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground md:col-span-2">De onde vêm as cenas
          <select value={sourceMode} onChange={(e) => setSourceMode(e.target.value)} className={input + " mt-1"}>
            <option value="search">Buscar clipes e imagens (YouTube, web, bancos)</option>
            <option value="reference">Fatiar um vídeo com as cenas (ex.: compilação Marvel) — bem mais rápido</option>
          </select>
        </label>
        {sourceMode === "reference" && (
          <div className="grid gap-2 rounded-md border border-border p-3 md:col-span-2">
            <div className="text-xs text-muted-foreground">Vídeo das cenas (separado do vídeo de estilo acima). Escolha um salvo ou cole o link do YouTube/TikTok:</div>
            <select value={scenesRef} onChange={(e) => { setScenesRef(e.target.value); if (e.target.value) setScenesUrl(""); }} className={input}>
              <option value="">— colar link abaixo —</option>
              {refs?.map((r) => <option key={r.id} value={r.id}>{r.title ?? r.urls[0]}</option>)}
            </select>
            {!scenesRef && <input value={scenesUrl} onChange={(e) => setScenesUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=..." className={input} />}
          </div>
        )}
        <div className="grid gap-2 rounded-md border border-border p-3 md:col-span-2">
          <div className="text-xs text-muted-foreground">Vídeos base (opcional): cole 1 ou 2 links do YouTube/TikTok. O agente baixa uma vez e corta as cenas deles, sem buscar fora.</div>
          <input value={base1} onChange={(e) => setBase1(e.target.value)} placeholder="Vídeo base 1 — https://..." className={input} />
          <input value={base2} onChange={(e) => setBase2(e.target.value)} placeholder="Vídeo base 2 (opcional) — https://..." className={input} />
        </div>
        <label className="text-xs text-muted-foreground">Voz da narração
          <select value={voiceId ? `clone:${voiceId}` : voice} onChange={(e) => { const v = e.target.value; if (v.startsWith("clone:")) setVoiceId(v.slice(6)); else { setVoiceId(""); setVoice(v); } }} className={input + " mt-1"}>
            <option value="pt-BR-AntonioNeural">Antonio (masculina, firme)</option><option value="pt-BR-FranciscaNeural">Francisca (feminina, clara)</option><option value="pt-BR-ThalitaMultilingualNeural">Thalita (feminina, jovem)</option>
            {voices?.filter((v) => v.status === "ready").map((v) => <option key={v.id} value={`clone:${v.id}`}>Clonada: {v.name}</option>)}
          </select>
        </label>
        <div className="flex gap-2">
          <label className="flex-1 text-xs text-muted-foreground">Velocidade
            <select value={rate} onChange={(e) => setRate(e.target.value)} className={input + " mt-1"}>
              <option value="-10%">Mais lenta</option><option value="+0%">Normal</option><option value="+5%">Um pouco rápida</option><option value="+15%">Rápida (TikTok)</option>
            </select>
          </label>
          <label className="flex-1 text-xs text-muted-foreground">Música de fundo
            <select value={mood} onChange={(e) => setMood(e.target.value)} className={input + " mt-1"}>
              <option value="auto">Qualquer da minha pasta</option><option value="suspense">Suspense</option><option value="epico">Épica</option><option value="calmo">Calma</option><option value="alegre">Alegre</option><option value="triste">Triste</option><option value="none">Sem música</option>
            </select>
          </label>
        </div>
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
                {p.status !== "draft" && <JobStatus productionId={p.id} />}
                <details open><summary className="cursor-pointer text-sm font-semibold">Linha do tempo</summary><Timeline productionId={p.id} /></details>
                {(p.validation as { audit?: Audit } | null)?.audit ? <AuditReport audit={(p.validation as { audit: Audit }).audit} /> : null}
                {p.preview_path ? <Versions current={p.preview_path} versions={(p.versions as Version[] | null) ?? []} /> : p.output_path ? <div className="text-xs text-muted-foreground">Salvo só no computador: {p.output_path}</div> : null}
                <div className="flex flex-wrap gap-2">
                  <button disabled={b} className={btn} onClick={() => script(p.id)}>{s ? "Refazer roteiro" : "Gerar roteiro"}</button>
                  <button disabled={b} className={btn} onClick={() => run(p.id, () => startProduction(p.id, { needsAnalysis: !!p.reference_id, referenceId: p.reference_id }), "Automação iniciada — aguardando o agente local")}>Iniciar automação</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "paused")}>Pausar</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "queued")}>Retomar</button>
                  <button disabled={b} className={btn} onClick={() => control(p.id, "cancelled")}>Cancelar</button>
                  <button disabled={b} className={btn + " text-destructive"} onClick={() => remove(p.id)}>Excluir</button>
                  {s ? <button className={btn + (view === p.id ? " bg-accent" : "")} onClick={() => setView(view === p.id ? null : p.id)}>{view === p.id ? "Fechar roteiro" : "Ler roteiro"}</button> : null}
                  {s ? <button disabled={b} className={btn} onClick={() => run(p.id, async () => { const r = await postKit({ data: { productionId: p.id } }); if (!r.ok) throw new Error(r.error); setKit(p.id); }, "Kit de postagem pronto")}>{b ? "Gerando…" : (p.settings as Record<string, unknown> | null)?.["post_kit"] ? "Refazer kit de postagem" : "Kit de postagem"}</button> : null}
                  {(p.settings as Record<string, unknown> | null)?.["post_kit"] ? <button className={btn + (kit === p.id ? " bg-accent" : "")} onClick={() => setKit(kit === p.id ? null : p.id)}>{kit === p.id ? "Fechar kit" : "Ver kit"}</button> : null}
                  {s ? <button className={btn + (open === p.id ? " bg-accent" : "")} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Fechar cenas" : "Ver e editar cenas"}</button> : null}
                </div>
                {!["queued", "running", "rendering"].includes(p.status) ? <VoicePicker productionId={p.id} settings={p.settings as Record<string, unknown> | null} onSaved={() => qc.invalidateQueries()} /> : null}
                {view === p.id && s ? <ScriptView productionId={p.id} script={s} targetSeconds={Number((p.settings as Record<string, unknown> | null)?.["target_seconds"] ?? 0)} /> : null}
                {kit === p.id && (p.settings as Record<string, unknown> | null)?.["post_kit"] ? <PostKit kit={(p.settings as Record<string, unknown>)["post_kit"] as Kit} /> : null}
                {open === p.id ? <SceneEditor productionId={p.id} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type AuditDim = { key: string; label: string; status: "pass" | "deviation" | "not_verified"; ref: unknown; out: unknown; tolerance: string | null; note: string };
type Audit = { dimensions: AuditDim[]; failing_scenes: number[]; summary: { pass?: number; deviation?: number; not_verified?: number }; repairs?: { attempt: number; scenes: number[] }[]; repair_result?: string };

const STATUS_LABEL: Record<AuditDim["status"], string> = { pass: "dentro", deviation: "fora", not_verified: "não verificado" };
const fmt = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Relatório de aderência técnica (Fase 4): medido no MP4 final, sem nota de fidelidade. */
function AuditReport({ audit }: { audit: Audit }) {
  const [openR, setOpenR] = useState(false);
  const s = audit.summary ?? {};
  return (
    <div className="rounded-md border border-border p-2 text-xs">
      <button className="w-full text-left font-medium" onClick={() => setOpenR(!openR)}>
        Aderência técnica: {s.pass ?? 0} dentro · {s.deviation ?? 0} fora · {s.not_verified ?? 0} não verificados {openR ? "▲" : "▼"}
      </button>
      {openR ? (
        <div className="mt-2 space-y-1">
          {audit.dimensions.map((d) => (
            <div key={d.key} className="flex flex-wrap gap-x-2">
              <span className={d.status === "pass" ? "text-primary" : d.status === "deviation" ? "text-destructive" : "text-muted-foreground"}>[{STATUS_LABEL[d.status]}]</span>
              <span className="font-medium">{d.label}</span>
              <span className="text-muted-foreground">referência {fmt(d.ref)} · resultado {fmt(d.out)}{d.tolerance ? ` · tolerância ${d.tolerance}` : ""}</span>
              {d.note ? <span className="w-full text-muted-foreground">{d.note}</span> : null}
            </div>
          ))}
          {audit.repairs?.length ? <div>Correção por cena: {audit.repairs.map((r) => `tentativa ${r.attempt}: cena(s) ${r.scenes.map((i) => i + 1).join(", ")}`).join(" · ")} — {audit.repair_result}</div> : null}
          {audit.failing_scenes.length ? <div className="text-destructive">Cenas ainda com defeito: {audit.failing_scenes.map((i) => i + 1).join(", ")}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

type Version = { n: number; preview_path?: string; output_path: string; created_at: string; duration_s?: number; render_s?: number };

/** Vídeo atual + versões anteriores (cada renderização vira uma versão). */
function Versions({ current, versions }: { current: string; versions: Version[] }) {
  const [pick, setPick] = useState(current);
  const list = [...versions].reverse();
  return (
    <div className="space-y-2">
      {list.length > 1 && (
        <div className="flex flex-wrap gap-1 text-xs">
          {list.map((v) => v.preview_path && (
            <button key={v.n} onClick={() => setPick(v.preview_path!)} className={btn + (pick === v.preview_path ? " bg-accent" : "")}>
              Versão {v.n} · {new Date(v.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}{v.duration_s ? ` · ${Math.round(v.duration_s)}s` : ""}{v.render_s ? ` · montado em ${Math.round(v.render_s)}s` : ""}
            </button>
          ))}
        </div>
      )}
      <VideoPlayer path={pick} />
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

type Kit = { titles: string[]; description: string; hashtags: string[]; thumbnail_text: string[]; pinned_comment: string };

function Copy({ text }: { text: string }) {
  return <button className={btn} onClick={() => { navigator.clipboard.writeText(text); toast.success("Copiado"); }}>Copiar</button>;
}

/** Títulos, descrição, hashtags e texto da capa prontos para colar na hora de postar. */
function PostKit({ kit }: { kit: Kit }) {
  const tags = kit.hashtags.join(" ");
  const row = "flex items-start justify-between gap-3 rounded-md border border-border p-2";
  return (
    <div className="space-y-3 rounded-md bg-muted/40 p-3 text-xs">
      <div className="space-y-1"><div className="font-medium">Títulos</div>{kit.titles.map((t) => <div key={t} className={row}><span>{t}</span><Copy text={t} /></div>)}</div>
      <div className="space-y-1"><div className="font-medium">Descrição</div><div className={row}><span className="whitespace-pre-wrap">{kit.description}</span><Copy text={kit.description} /></div></div>
      <div className="space-y-1"><div className="font-medium">Hashtags</div><div className={row}><span>{tags}</span><Copy text={tags} /></div></div>
      <div className="space-y-1"><div className="font-medium">Texto para a capa</div>{kit.thumbnail_text.map((t) => <div key={t} className={row}><span className="font-semibold uppercase">{t}</span><Copy text={t} /></div>)}</div>
      <div className="space-y-1"><div className="font-medium">Comentário fixado</div><div className={row}><span>{kit.pinned_comment}</span><Copy text={kit.pinned_comment} /></div></div>
    </div>
  );
}
