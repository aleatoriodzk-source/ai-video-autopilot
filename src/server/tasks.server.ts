// AI tasks shared by the web panel (server functions) and the local agent API.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { aiJson as rawAiJson, type AiKeys, type Usage } from "./ai.server";
import { channelAnalysisSchema, ideasSchema, scriptSchema, shortAnalysisSchema, type ScriptOut, type StyleProfile } from "./schemas";
import { evaluateBudget } from "@/lib/costs";
import { mergeSettings, type AppSettings } from "@/lib/settings";

type DB = SupabaseClient<Database>;

const LABEL: Record<string, string> = { gemini: "Gemini (chave própria)", openai: "ChatGPT (chave própria)", anthropic: "Claude (chave própria)", lovable: "Créditos da plataforma" };

/** User's own API keys (server-only table, read with admin access after the caller is identified). */
export async function loadKeys(userId: string): Promise<AiKeys> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_api_keys").select("provider,api_key").eq("user_id", userId);
  return Object.fromEntries((data ?? []).map((r) => [r.provider, r.api_key])) as AiKeys;
}

const lastProvider: Record<string, string> = {};
function makeAi(userId: string, s: AppSettings, override?: unknown) {
  const provider = typeof override === "string" && override ? override : s.ai.text_provider;
  return async <T,>(opts: Parameters<typeof rawAiJson>[0]) => {
    const r = await rawAiJson<T>({ ...opts, keys: await loadKeys(userId), provider });
    lastProvider[userId] = r.provider;
    return r;
  };
}

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
    provider: LABEL[lastProvider[userId] ?? "lovable"] ?? "IA",
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
  const ai = makeAi(userId, s);
  const isShort = an.kind === "short";
  const { data, usage } = await ai<Record<string, unknown> & { style_profile: StyleProfile }>({
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
  const ai = makeAi(userId, s, (p.settings as Record<string, unknown> | null)?.["ai_provider"]);
  const { data, usage } = await ai<{ ideas: unknown[] }>({
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
  const ai = makeAi(userId, s, (p.settings as Record<string, unknown> | null)?.["ai_provider"]);
  const topic = chosenTopic ?? p.topic ?? "";
  if (!topic.trim()) throw new Error("Defina ou escolha um tema antes de gerar o roteiro");
  const style = p.style_profiles?.profile as StyleProfile | undefined;
  const ps = (p.settings ?? {}) as Record<string, unknown>;
  const target = Math.min(1800, Math.max(15, Number(ps["target_seconds"] ?? (p.aspect === "9:16" ? 45 : 240))));
  const sceneCount = ps["scene_count"] ? Math.min(300, Math.max(2, Number(ps["scene_count"]))) : null;
  const words = Math.round(target * 2.4);
  const { data, usage } = await ai<ScriptOut>({
    system:
      ETHICS +
      " Você é um roteirista profissional de canais virais do YouTube brasileiro. Escreve como gente fala: frases curtas, ritmo, curiosidade, viradas e exemplos concretos. Proibido: clichês ('você sabia que', 'neste vídeo', 'fique até o final', 'incrível', 'nos dias de hoje'), frases vazias, repetição de ideias, enrolação, fatos inventados ou números sem base. Cada cena precisa entregar uma informação nova ou avançar a história.",
    user:
      `Escreva um roteiro completo para narração em PT-BR sobre: "${topic}".` +
      `\nDuração alvo: ${Math.round(target / 60 * 10) / 10} min (~${target}s), com aproximadamente ${words} palavras no total. Respeite essa extensão — não encurte. Formato ${p.aspect}.` +
      (sceneCount
        ? `\nO roteiro deve ter EXATAMENTE ${sceneCount} cenas (≈ ${Math.round(words / sceneCount)} palavras de narração por cena).`
        : `\nDivida em cenas de ${style?.pacing?.avg_scene_s ?? 4}-${(style?.pacing?.avg_scene_s ?? 4) + 3}s cada.`) +
      "\nEstrutura: 1) gancho forte nos primeiros 5s (promessa ou pergunta intrigante específica); 2) contexto rápido; 3) desenvolvimento em blocos com mini-ganchos para manter retenção; 4) clímax/revelação; 5) fechamento com CTA natural." +
      (target > 180 ? "\nComo é um vídeo longo, organize em capítulos claros e use transições faladas entre eles." : "") +
      (ps["style"] === "youtube"
        ? "\nESTILO YOUTUBE LONGO (documentário): narrativa envolvente com começo, meio e fim, cenas de 5 a 9 segundos, explicações com exemplos, curiosidade construída aos poucos, loops abertos que só fecham mais adiante, transições suaves (fade), movimentos de câmera lentos."
        : ps["style"] === "tiktok"
          ? "\nESTILO TIKTOK/SHORTS (dopamina): gancho brutal na primeira frase (até 8 palavras), frases curtíssimas, cenas de 1,5 a 3 segundos, uma virada surpreendente a cada 2 ou 3 cenas, zero introdução, legendas de impacto, sugira efeitos sonoros (whoosh, impacto, riser) nos cortes, final que puxa para assistir de novo."
          : "") +
      "\nPara cada cena: narração; legenda curta (até 6 palavras, o essencial da fala); descrição visual CONTEXTUAL do que deve aparecer; visual_query em INGLÊS com 2-4 termos concretos e filmáveis (ex.: 'astronaut floating space station', nunca termos abstratos) para busca em banco de vídeos/fotos; pausa após (ms); efeito sonoro sugerido ou ''; movimento e transição." +
      "\nREGRAS DA NARRAÇÃO (será lida por voz sintética): só texto corrido falado. PROIBIDO emojis, símbolos (§ ¶ * # _ / % & + =), markdown, aspas decorativas, rubricas entre parênteses ou colchetes como (pausa) ou [música], e siglas soletradas. Escreva números, porcentagens e valores por extenso (ex.: 'vinte e cinco por cento', 'mil e quinhentos'). Evite palavras em inglês na narração." +
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
