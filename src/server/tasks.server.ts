// AI tasks shared by the web panel (server functions) and the local agent API.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { aiJson, TEXT_MODEL, type Usage } from "./ai.server";
import { channelAnalysisSchema, ideasSchema, scriptSchema, shortAnalysisSchema, type ScriptOut, type StyleProfile } from "./schemas";
import { evaluateBudget } from "@/lib/costs";
import { mergeSettings, type AppSettings } from "@/lib/settings";

type DB = SupabaseClient<Database>;

export async function loadSettings(db: DB, userId: string): Promise<AppSettings> {
  const { data } = await db.from("user_settings").select("data").eq("user_id", userId).maybeSingle();
  return mergeSettings(data?.data);
}

export async function guardBudget(db: DB, userId: string, jobId: string | null, nextCost: number | null) {
  const s = await loadSettings(db, userId);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: month } = await db.from("usage_records").select("cost_usd").eq("user_id", userId).gte("created_at", monthStart.toISOString());
  const spentMonth = (month ?? []).reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);
  let spentTask = 0;
  if (jobId) {
    const { data: t } = await db.from("usage_records").select("cost_usd").eq("job_id", jobId);
    spentTask = (t ?? []).reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);
  }
  const d = evaluateBudget({ limits: s.limits, spentTask, spentMonth, nextCost });
  if (!d.allowed) throw new Error(`ORÇAMENTO: ${d.reason}`);
  return s;
}

export async function recordTextUsage(db: DB, userId: string, s: AppSettings, usage: Usage, operation: string, jobId: string | null, productionId: string | null) {
  const p = s.prices.ai_text_per_mtok;
  await db.from("usage_records").insert({
    user_id: userId,
    job_id: jobId,
    production_id: productionId,
    provider: `Lovable AI (${TEXT_MODEL})`,
    operation,
    units: usage.total_tokens,
    unit_name: "tokens",
    cost_usd: p == null ? null : (usage.total_tokens / 1_000_000) * p,
  });
}

const ETHICS =
  "Você é um analista e roteirista de vídeos para criadores brasileiros. Escreva sempre em português do Brasil. " +
  "NUNCA invente métricas, visualizações, datas ou fatos. Use apenas os dados fornecidos. Em cada achado, marque basis='dados' se veio dos dados, 'estimativa' se for inferência, 'indisponivel' se não há informação. " +
  "Ao criar perfis de estilo, descreva características gerais reutilizáveis — nunca copie roteiros, marcas d'água, logotipos ou materiais protegidos.";

export async function runAnalysis(db: DB, userId: string, args: { analysisId: string; jobId: string | null; collected: unknown; frames?: string[] }) {
  const { data: an } = await db.from("analyses").select("*, reference_sources(*)").eq("id", args.analysisId).single();
  if (!an) throw new Error("Análise não encontrada");
  const s = await guardBudget(db, userId, args.jobId, null);
  const isShort = an.kind === "short";
  const { data, usage } = await aiJson<Record<string, unknown> & { style_profile: StyleProfile }>({
    system: ETHICS,
    user:
      (isShort
        ? "Analise a estrutura visual e temporal deste vídeo curto. Use as cenas detectadas automaticamente (tempos de corte do FFmpeg), a transcrição com tempos e os quadros-chave anexados (na ordem dos tempos indicados)."
        : "Analise este canal/perfil a partir dos metadados públicos, transcrições e estatísticas de cortes coletadas pelo agente local. Compare melhores e piores vídeos SOMENTE se houver visualizações nos dados.") +
      "\n\nDADOS COLETADOS (JSON):\n" +
      JSON.stringify(args.collected).slice(0, 120_000),
    schemaName: isShort ? "short_analysis" : "channel_analysis",
    schema: isShort ? shortAnalysisSchema : channelAnalysisSchema,
    images: (args.frames ?? []).slice(0, 10),
  });
  await recordTextUsage(db, userId, s, usage, isShort ? "análise de vídeo curto" : "análise de canal", args.jobId, null);
  await db.from("analyses").update({ status: "done", report: data as never, error: null }).eq("id", an.id);
  const ref = an.reference_sources as { title: string | null; urls: string[] } | null;
  const { data: style } = await db
    .from("style_profiles")
    .insert({
      user_id: userId,
      analysis_id: an.id,
      name: `Estilo — ${ref?.title ?? ref?.urls?.[0] ?? "referência"}`,
      profile: data.style_profile as never,
      edit_template: (isShort ? { scenes: (data as unknown as { scenes: unknown }).scenes } : {}) as never,
    })
    .select("id")
    .single();
  return { report: data, styleId: style?.id };
}

async function productionContext(db: DB, productionId: string) {
  const { data: p } = await db.from("productions").select("*, style_profiles(*), reference_sources(*)").eq("id", productionId).single();
  if (!p) throw new Error("Produção não encontrada");
  let report: unknown = null;
  if (p.reference_id) {
    const { data: a } = await db.from("analyses").select("report").eq("reference_id", p.reference_id).eq("status", "done").order("created_at", { ascending: false }).limit(1).maybeSingle();
    report = a?.report ?? null;
  }
  return { p, report };
}

export async function runIdeas(db: DB, userId: string, productionId: string, jobId: string | null) {
  const { p, report } = await productionContext(db, productionId);
  const s = await guardBudget(db, userId, jobId, null);
  const { data, usage } = await aiJson<{ ideas: unknown[] }>({
    system: ETHICS,
    user:
      `Sugira 6 temas originais de vídeo ${p.aspect === "9:16" ? "curto vertical" : "para YouTube"} alinhados ao nicho.` +
      `\nTema/instrução do usuário: ${p.topic ?? "(livre)"}` +
      `\nRelatório do canal de referência: ${JSON.stringify(report ?? "não disponível").slice(0, 20000)}` +
      `\nPerfil de estilo: ${JSON.stringify(p.style_profiles?.profile ?? "não definido")}` +
      "\nMarque factual=true se o tema depende de fatos verificáveis.",
    schemaName: "ideas",
    schema: ideasSchema,
  });
  await recordTextUsage(db, userId, s, usage, "ideias", jobId, productionId);
  await db.from("productions").update({ ideas: data.ideas as never }).eq("id", productionId);
  return data.ideas;
}

export async function runScript(db: DB, userId: string, productionId: string, jobId: string | null, chosenTopic?: string) {
  const { p, report } = await productionContext(db, productionId);
  const s = await guardBudget(db, userId, jobId, null);
  const topic = chosenTopic ?? p.topic ?? "";
  if (!topic.trim()) throw new Error("Defina ou escolha um tema antes de gerar o roteiro");
  const style = p.style_profiles?.profile as StyleProfile | undefined;
  const target = Number((p.settings as Record<string, unknown>)?.["target_seconds"] ?? (p.aspect === "9:16" ? 45 : 240));
  const { data, usage } = await aiJson<ScriptOut>({
    system: ETHICS + " Roteiros devem ser originais, naturais, sem repetições, sem frases genéricas e sem fatos inventados.",
    user:
      `Escreva um roteiro completo para narração em PT-BR sobre: "${topic}".` +
      `\nDuração alvo: ~${target}s (≈ ${Math.round(target * 2.5)} palavras). Formato ${p.aspect}.` +
      `\nDivida em cenas de ${style?.pacing?.avg_scene_s ?? 3}-${(style?.pacing?.avg_scene_s ?? 3) + 2}s cada (uma ou duas frases por cena).` +
      "\nPara cada cena: narração, legenda curta (pode ser a própria fala), descrição visual CONTEXTUAL do que deve aparecer (significado da frase, não só palavras-chave), visual_query em inglês com 3-6 termos concretos para busca em bancos de imagens, pausa após (ms), efeito sonoro sugerido ou '' e movimento/transição." +
      "\nA primeira cena é o gancho forte. Termine com CTA se apropriado." +
      "\nEm references, liste cada afirmação factual e como verificá-la (fonte primária sugerida). Não invente URLs." +
      `\nPerfil de estilo: ${JSON.stringify(style ?? "não definido")}` +
      `\nResumo do canal: ${JSON.stringify(report ?? "não disponível").slice(0, 12000)}`,
    schemaName: "script",
    schema: scriptSchema,
  });
  await recordTextUsage(db, userId, s, usage, "roteiro", jobId, productionId);
  await db.from("scenes").delete().eq("production_id", productionId);
  const rows = data.scenes.map((sc, idx) => ({
    user_id: userId,
    production_id: productionId,
    idx,
    narration: sc.narration,
    caption: sc.caption,
    visual_description: sc.visual_description,
    visual_query: sc.visual_query,
    pause_after_ms: Math.max(0, Math.round(sc.pause_after_ms)),
    sfx: sc.sfx || null,
    pacing: sc.pacing,
    motion: sc.motion,
    transition: sc.transition,
  }));
  if (rows.length) await db.from("scenes").insert(rows);
  await db.from("productions").update({ script: data as never, title: data.title, topic }).eq("id", productionId);
  return data;
}
