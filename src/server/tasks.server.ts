import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { aiJson as rawAiJson, type AiKeys, type Usage } from "./ai.server";
import { channelAnalysisSchema, ideasSchema, postKitSchema, scriptSchema, shortAnalysisSchema, type ScriptOut, type StyleProfile } from "./schemas";
import { evaluateBudget } from "@/lib/costs";
import { WORDS_PER_SECOND, countWords, effectiveTargetSeconds, isShortAspect, scriptIsShort } from "@/lib/duration";
import { mergeSettings, type AppSettings } from "@/lib/settings";
import { pickStructured, profileToSave } from "@/lib/style-link";

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
        : "Analise este canal/perfil a partir dos metadados públicos, transcrições e estatísticas de cortes coletadas pelo agente local. Foram baixados os vídeos mais recentes do canal, com a transcrição completa de cada um. Descubra o nicho REAL pelo que é falado nas transcrições e títulos, nunca pelo nome do canal. Preencha video_comparison com cada vídeo analisado, common_patterns com o que se repete em todos e winning_formula com o que os mais vistos fazem diferente dos menos vistos. Só classifique desempenho se houver visualizações; senão use sem_dados.") +
      "\n\nAlém disso, preencha format_dna como um especialista em formatos virais: descubra nicho e subnicho, público, a promessa do vídeo, o tipo exato de gancho e o molde da primeira frase (com 3 modelos reaproveitáveis com [TEMA]), a estrutura em partes com % do tempo, como a narração é escrita (pessoa, tom, palavras por segundo, tamanho das frases, recursos como perguntas, contrastes, números), técnicas de retenção e loops abertos, edição (cortes por minuto, zoom, transições, proporção de imagens de apoio), legendas, áudio, que tipo de imagem usar e em qual fonte (YouTube para cenas de filmes/clipes, web, Wikimedia, NASA, Pexels, Pixabay, Internet Archive), CTA, padrão de título, o que fazer e o que evitar, e 5 ideias de vídeos novos no mesmo formato. Descreva o FORMATO, nunca copie falas ou conteúdo protegido. Se algo não pode ser medido, diga que é estimativa." +
      "\n\nANÁLISE FORENSE: os dados trazem, por vídeo, 'transcript' (falas com tempo), 'audio' (pausas medidas na voz, sound_hits = impactos/efeitos sonoros) e 'edit' (cortes por minuto em cada terço, cortes e texto dos 3 primeiros segundos, palavras por segundo, impactos que coincidem com cortes). Use esses NÚMEROS reais. Preencha format_dna.replication para que o vídeo novo seja uma cópia exata do FORMATO: media_rule ('video_only' se os quadros mostram clipes/cenas de filme/gameplay em movimento — nichos de filmes, heróis, anime, futebol, games quase sempre são video_only); scene_seconds = média medida entre cortes; hook_anatomy (o que acontece em cada segundo dos 3 primeiros: fala, corte, impacto); voice_pace (palavras/segundo medidas e energia); voice_rate_percent (velocidade para a voz sintética: 0 normal, 10 a 25 se fala rápida, -10 se lenta); pause_style (pausas medidas: quantas, média, onde ficam); sfx_placement (onde caem os impactos: gancho, viradas, cada corte); caption_color pelo destaque visto nos quadros (verde=neon, amarelo=hormozi, vermelho=red, branco=clean); script_skeleton = a sequência de funções de cada frase da transcrição (ex.: 'pergunta chocante', 'fato 1 com número', 'virada', 'CTA'), sem copiar as palavras." +
      (isShort ? "" : "\n\nCLONAGEM DO CANAL: use o vídeo mais recente (ou o mais visto) como molde. frame_mix deve ter UMA proporção por tomada desse vídeo, em ordem (mínimo 8 itens), refletindo a alternância real vista nos quadros — não repita a mesma proporção em tudo se os quadros mostram faixas horizontais com fundo desfocado ou imagens quadradas. sfx_map e transitions_map com os tempos medidos desse vídeo.") +
      ("\n\nCLONAGEM: " + (isShort ? "preencha scenes com UMA entrada por tomada usando os tempos de corte medidos (motion e transition de cada uma). " : "") + "caption_clone = a legenda vista nos quadros: cor do texto, cor da palavra destacada e do contorno em hex (#RRGGBB), distância do rodapé em % da altura, palavras por bloco, se é caixa alta, peso da fonte, animação e qual tipo de palavra recebe destaque. sfx_map = cada impacto sonoro medido (audio.sound_hits_s) com o tipo provável e se cai num corte. transitions_map = cada corte medido com o tipo de transição (flash se edit.motion.flash_cuts indica, zoom/whip se há movimento brusco, senão cut). frame_mix = para cada tomada, em ordem, a proporção da imagem PRINCIPAL dentro da tela 9:16 vista nos quadros: '9:16' se ocupa a tela toda, '16:9' se é uma faixa horizontal com fundo desfocado, '1:1' se é quadrada, '3:4' se é um retrato quase cheio. color_grade = o filtro de cor visto nos quadros (dark_cinematic se escuro com vinheta, high_contrast, warm, cold, vintage, vivid ou none). music_mood = o clima da música de fundo (suspense, epico, calmo, alegre, triste ou none se não há música).") +
        "\n\nDADOS COLETADOS (JSON):\n" +
      JSON.stringify(args.collected).slice(0, 120_000),
    schemaName: isShort ? "short_analysis" : "channel_analysis",
    schema: isShort ? shortAnalysisSchema : channelAnalysisSchema,
    images: (args.frames ?? []).slice(0, 10),
  });
  await recordTextUsage(db, userId, s, usage, isShort ? "análise de vídeo curto" : "análise de canal", args.jobId, null);
  const measured = measureReference(args.collected);
  if (measured) (data as Record<string, unknown>)["measured"] = measured;
  await db.from("analyses").update({ status: "done", report: data as never, error: null }).eq("id", an.id);
  const ref = an.reference_sources as { title: string | null; urls: string[] } | null;
  // GAP 1: perfil forense v2 medido pelo agente vai junto do legado (withStructured), sem perder campos antigos.
  const structured = pickStructured(args.collected, { referenceId: an.reference_id, analysisId: an.id });
  const { data: style } = await db
    .from("style_profiles")
    .insert({
      user_id: userId,
      analysis_id: an.id,
      name: `Estilo — ${ref?.title ?? ref?.urls?.[0] ?? "referência"}`,
      profile: profileToSave(data.style_profile, structured) as never,
      edit_template: (isShort ? { scenes: (data as unknown as { scenes: unknown }).scenes } : {}) as never,
    })
    .select("id")
    .single();
  return { report: data, styleId: style?.id };
}

/** Real numbers from the downloaded reference videos: average length and words spoken (from transcripts). */
export function measureReference(collected: unknown): { avg_duration_s: number; avg_words: number | null; words_per_second: number | null; videos: number } | null {
  const vs = ((collected as { videos?: { duration_s?: number; transcript?: { text: string }[] }[] } | null)?.videos ?? []).filter((v) => Number(v.duration_s) > 0);
  if (!vs.length) return null;
  const avgDur = vs.reduce((a, v) => a + Number(v.duration_s), 0) / vs.length;
  const withText = vs.filter((v) => (v.transcript ?? []).length > 3);
  const words = withText.map((v) => (v.transcript ?? []).reduce((a, t) => a + t.text.split(/\s+/).filter(Boolean).length, 0));
  const avgWords = words.length ? words.reduce((a, b) => a + b, 0) / words.length : null;
  const wps = words.length ? words.reduce((a, b) => a + b, 0) / withText.reduce((a, v) => a + Number(v.duration_s), 0) : null;
  return { avg_duration_s: Math.round(avgDur), avg_words: avgWords ? Math.round(avgWords) : null, words_per_second: wps ? Math.round(wps * 100) / 100 : null, videos: vs.length };
}

function dnaOf(report: unknown): unknown {
  return report && typeof report === "object" ? (report as Record<string, unknown>)["format_dna"] ?? null : null;
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
      `Sugira 6 temas originais de vídeo ${(p.aspect === "9:16" || p.aspect === "3:4") ? "curto vertical" : "para YouTube"} alinhados ao nicho.` +
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

/** Ideias de vídeo novas a partir do DNA de um canal já analisado (sem produção ainda). */
export async function runChannelIdeas(db: DB, userId: string, referenceId: string, wish: string) {
  const { data: r } = await db.from("reference_sources").select("id,title,urls,platform").eq("id", referenceId).eq("user_id", userId).maybeSingle();
  if (!r) throw new Error("Referência não encontrada");
  const { data: a } = await db.from("analyses").select("report").eq("reference_id", r.id).eq("status", "done").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!a?.report) throw new Error("Analise o canal primeiro (botão Analisar) para a IA aprender o formato.");
  const s = await guardBudget(db, userId, null, null);
  const ai = makeAi(userId, s);
  const { data, usage } = await ai<{ ideas: { title: string; hook: string; angle: string; why_fits: string; factual: boolean }[] }>({
    system: ETHICS,
    user:
      "Você estudou o canal abaixo. Sugira 8 temas NOVOS e originais que esse criador faria e que têm potencial de viralizar no mesmo formato. " +
      "Não repita temas de vídeos que ele já fez. Em 'hook' escreva a primeira frase do vídeo no molde de gancho do canal; em 'why_fits' explique em 1 frase por que funciona nesse formato. Marque factual=true se depende de fatos verificáveis." +
      (wish ? `\nPreferência do usuário: ${wish}` : "") +
      `\nCanal: ${r.title ?? r.urls[0]} (${r.platform})` +
      `\nRelatório/DNA do canal: ${JSON.stringify(a.report).slice(0, 30000)}`,
    schemaName: "ideas",
    schema: ideasSchema,
  });
  await recordTextUsage(db, userId, s, usage, "ideias do canal", null, null);
  return data.ideas;
}

/** Kit de postagem: títulos, descrição, hashtags e texto da capa a partir do roteiro pronto. */
export async function runPostKit(db: DB, userId: string, productionId: string) {
  const { p, report } = await productionContext(db, productionId);
  const script = p.script as { title?: string; hook?: string; scenes?: { narration: string }[] } | null;
  if (!script?.scenes?.length) throw new Error("Gere o roteiro antes do kit de postagem");
  const s = await guardBudget(db, userId, null, null);
  const ai = makeAi(userId, s, (p.settings as Record<string, unknown> | null)?.["ai_provider"]);
  const short = (p.aspect === "9:16" || p.aspect === "3:4");
  const { data, usage } = await ai<{ titles: string[]; description: string; hashtags: string[]; thumbnail_text: string[]; pinned_comment: string }>({
    system: ETHICS,
    user:
      `Crie o kit de postagem deste vídeo ${short ? "curto (TikTok/Shorts/Reels)" : "do YouTube"}. ` +
      `titles: 5 títulos com curiosidade, sem clickbait mentiroso (${short ? "até 60" : "até 70"} caracteres), no padrão de título do canal de referência se houver. ` +
      `description: ${short ? "2 a 3 linhas" : "1 parágrafo forte + 3 tópicos do que o vídeo mostra + chamada para inscrever"}. ` +
      "hashtags: 8 a 12, com #, misturando amplas e do nicho. thumbnail_text: 3 opções de texto curto (2 a 4 palavras) para a capa. pinned_comment: um comentário fixado que puxe conversa." +
      `\nRoteiro: ${JSON.stringify({ title: script.title, hook: script.hook, narration: script.scenes.map((x) => x.narration).join(" ") }).slice(0, 15000)}` +
      `\nDNA do canal de referência: ${JSON.stringify((report as Record<string, unknown> | null)?.["format_dna"] ?? "não disponível").slice(0, 8000)}`,
    schemaName: "post_kit",
    schema: postKitSchema,
  });
  await recordTextUsage(db, userId, s, usage, "kit de postagem", null, productionId);
  await db.from("productions").update({ settings: { ...((p.settings ?? {}) as Record<string, unknown>), post_kit: data } as never }).eq("id", productionId);
  return data;
}

export async function runScript(db: DB, userId: string, productionId: string, jobId: string | null, chosenTopic?: string) {
  const { p, report } = await productionContext(db, productionId);
  const s = await guardBudget(db, userId, jobId, null);
  const ai = makeAi(userId, s, (p.settings as Record<string, unknown> | null)?.["ai_provider"]);
  const topic = chosenTopic ?? p.topic ?? "";
  if (!topic.trim()) throw new Error("Defina ou escolha um tema antes de gerar o roteiro");
  const style = p.style_profiles?.profile as StyleProfile | undefined;
  const ps = (p.settings ?? {}) as Record<string, unknown>;
  const meas = (report as { measured?: { avg_duration_s?: number; words_per_second?: number | null } } | null)?.measured;
  // No length chosen by the user: copy the real average length of the reference videos.
  const target = effectiveTargetSeconds(p.aspect, ps["target_seconds"] ?? meas?.avg_duration_s);
  const dna = (dnaOf(report) ?? {}) as { replication?: { media_rule?: string; scene_seconds?: number; voice_rate_percent?: number; caption_color?: string; script_skeleton?: string[]; hook_anatomy?: string } };
  const rep = dna.replication ?? {};
  const measured = Number(rep.scene_seconds) > 0 ? Number(rep.scene_seconds) : null;
  // Reference pacing wins: a 0.9s-per-cut reference means ~1.5-2s narrated micro-scenes (one clip can carry 1-2 cuts).
  const refScene = measured ? Math.min(6, Math.max(1.5, measured * 1.6)) : ps["style"] === "tiktok" ? 2.2 : null;
  // Speed cap: at most 1 narrated scene per 4s (60s => 15 scenes); the agent adds the reference cut rhythm inside each clip (cut_seconds).
  const autoCap = Math.max(4, Math.round(target / 4));
  const sceneCount = ps["scene_count"] ? Math.min(300, Math.max(2, Number(ps["scene_count"]))) : refScene ? Math.min(autoCap, Math.max(4, Math.round(target / refScene))) : null;
  const wps = meas?.words_per_second && meas.words_per_second > 1 && meas.words_per_second < 4.5 ? meas.words_per_second : WORDS_PER_SECOND;
  // Fixed rule: shorts never under 60s => at least 200 words, at most 230 (fast voices + tight cuts).
  const short = isShortAspect(p.aspect);
  const words = short ? Math.min(230, Math.max(200, Math.round(target * wps))) : Math.round(target * wps);
  const ready = String(ps["ready_script"] ?? "").trim();
  const dnaText = JSON.stringify(dnaOf(report) ?? "").toLowerCase();
  const videoOnly = ps["media_rule"] === "video_only" || (ps["media_rule"] !== "mixed" && (rep.media_rule === "video_only" || /(somente|apenas|só) (v[ií]deos|clipes)|video_only|sem fotos|cenas de filme|clipes de filme|trailer|gameplay/.test(dnaText)));
  // Canal de fotos (Ken Burns, arquivo, jornais): segue a referência e não busca vídeo/TikTok.
  const imageOnly = !videoOnly && (ps["media_rule"] === "image_only" || ps["media_rule"] === "images_only" || (ps["media_rule"] !== "mixed" && (rep.media_rule === "image_only" || rep.media_rule === "images_only" || /ken ?burns|fotos? de arquivo|imagens? de arquivo|(somente|apenas|só|maioria|majoritariamente) (de )?(fotos|imagens)|imagens est[áa]ticas|fotos est[áa]ticas|recortes de jornal/.test(dnaText))));
  const { data: refRow } = p.reference_id ? await db.from("reference_sources").select("platform,urls").eq("id", p.reference_id).maybeSingle() : { data: null };
  const refPlatform = refRow ? (refRow.platform === "tiktok" || /tiktok/.test(refRow.urls?.[0] ?? "") ? "tiktok" : refRow.platform === "youtube" || /youtu/.test(refRow.urls?.[0] ?? "") ? "youtube" : "other") : null;
  let { data, usage } = await ai<ScriptOut>({
    system:
      ETHICS +
      " Você é um roteirista profissional de canais virais do YouTube brasileiro. Escreve como gente fala: frases curtas, ritmo, curiosidade, viradas e exemplos concretos. Proibido: clichês ('você sabia que', 'neste vídeo', 'fique até o final', 'incrível', 'nos dias de hoje'), frases vazias, repetição de ideias, enrolação, fatos inventados ou números sem base. Cada cena precisa entregar uma informação nova ou avançar a história.",
    user:
      (ready
        ? `O usuário JÁ ESCREVEU o roteiro abaixo. Sua tarefa é só DIVIDIR em cenas e planejar o visual. Copie a narração PALAVRA POR PALAVRA, na mesma ordem, sem resumir, cortar, reescrever ou acrescentar nada (apenas escreva números por extenso e remova emojis/símbolos para a voz). O title deve ser exatamente: "${topic}". Formato ${p.aspect}.\nROTEIRO DO USUÁRIO:\n${ready.slice(0, 40000)}\n`
        : `Escreva um roteiro completo para narração em PT-BR sobre: "${topic}". Mantenha o tema exatamente como o usuário pediu (não troque o ângulo, ex.: 'curiosidades' continua sendo curiosidades).` +
          `\nDuração alvo: ${Math.round(target / 60 * 10) / 10} min (~${target}s), com aproximadamente ${words} palavras no total. Respeite essa extensão — não encurte.${short ? " OBRIGATÓRIO: entre 200 e 230 palavras de narração no total (o vídeo nunca pode ter menos de 60 segundos)." : ""} Formato ${p.aspect}.`) +
      (imageOnly ? "\nREGRA DE MÍDIA: o canal de referência usa FOTOS e IMAGENS DE ARQUIVO com zoom suave. Cada visual_query deve pedir uma FOTO real e específica do que a frase cita (pessoa, objeto, jornal, lugar), ex.: 'Getúlio Vargas foto 1950', nunca cena de filme ou clipe." : "") +
      (videoOnly ? "\nREGRA DE MÍDIA: este nicho usa SOMENTE VÍDEOS em movimento (cenas de filmes, trailers, gameplay, clipes). Cada visual_query deve descrever uma CENA EM MOVIMENTO do assunto, ex.: 'Thor Ragnarok lightning fight scene', 'Thor hammer Mjolnir summon scene'. Nunca peça foto, pôster ou imagem parada." : "") +
      (sceneCount
        ? `\nO roteiro deve ter EXATAMENTE ${sceneCount} cenas (≈ ${Math.round(words / sceneCount)} palavras de narração por cena).`
        : `\nDivida em cenas de ${style?.pacing?.avg_scene_s ?? 4}-${(style?.pacing?.avg_scene_s ?? 4) + 3}s cada.`) +
      "\nHISTÓRIA ÚNICA E LINEAR (obrigatório): o vídeo inteiro conta UM único fato/caso com nomes reais (pessoas, times, lugares, ano). Proibido pular entre vários casos, seleções, épocas ou personagens diferentes — o espectador nunca pode se perder. Cada cena continua a cena anterior (causa → consequência), e todas as visual_query mostram o MESMO evento/protagonista." + "\nEstrutura: 1) gancho forte nos primeiros 5s (promessa ou pergunta intrigante específica); 2) contexto rápido; 3) desenvolvimento em blocos com mini-ganchos para manter retenção; 4) clímax/revelação; 5) fechamento com CTA natural." +
      (target > 180 ? "\nComo é um vídeo longo, organize em capítulos claros e use transições faladas entre eles." : "") +
      (ps["style"] === "youtube"
        ? "\nESTILO YOUTUBE LONGO (documentário): narrativa envolvente com começo, meio e fim, cenas de 5 a 9 segundos, explicações com exemplos, curiosidade construída aos poucos, loops abertos que só fecham mais adiante, transições suaves (fade), movimentos de câmera lentos."
        : ps["style"] === "tiktok"
          ? "\nESTILO TIKTOK/SHORTS (dopamina): gancho brutal na primeira frase (até 8 palavras), frases curtíssimas, cenas de 1,5 a 3 segundos, uma virada surpreendente a cada 2 ou 3 cenas, zero introdução, legendas de impacto, sugira efeitos sonoros (whoosh, impacto, riser) nos cortes." +
            (ready ? "" : "\nLOOP INFINITO (obrigatório): a última cena NÃO tem CTA nem despedida e termina com uma frase incompleta que se completa com a PRIMEIRA frase do roteiro (ex.: última 'E é exatamente por isso que...' + primeira 'ninguém consegue sair dessa ilha.'). Lida em sequência, última → primeira deve soar como uma frase só, para o vídeo recomeçar sem a pessoa perceber. Na última cena use pause_after_ms 0 e transition 'cut'.")
          : "") +
      "\nPara cada cena: narração; legenda curta (até 6 palavras, o essencial da fala); descrição visual CONTEXTUAL do que deve aparecer; visual_query com 2-5 termos concretos (em INGLÊS para assuntos internacionais; em PORTUGUÊS com os nomes reais quando o assunto for brasileiro — novelas, TV, famosos, política, futebol do Brasil, ex.: 'Faustão Domingão Globo 1995', 'Regina Duarte novela Roque Santeiro'); pausa após (ms); efeito sonoro sugerido ou ''; movimento e transição." +
      "\nREGRA DA visual_query: SEMPRE use o NOME PRÓPRIO do assunto real (personagem, filme, pessoa, marca, lugar, evento, ano) — ex.: 'Spider-Man 2002 movie scene', 'Iron Man 2008 suit up', 'Wolverine Deadpool fight', 'Stan Lee interview', 'Marvel comics 1990s'. NUNCA metáforas genéricas de banco de imagem (escritório, dinheiro, cofre, calculadora, pessoas andando). Se a fala é abstrata (dívida, crise, risco), mostre o personagem/filme/pessoa de que ela fala. A descrição visual também deve citar esse assunto, sem detalhes exigentes. FIDELIDADE À FALA: quando a narração cita um OBJETO, LUGAR ou MOMENTO específico (uma placa, um memorial, uma cena pós-créditos, um contrato, uma entrevista), a visual_query daquela cena deve buscar EXATAMENTE isso junto do nome próprio (ex.: 'Avengers Endgame Tony Stark memorial plaque'), nunca uma cena genérica do personagem." +
      "\nREGRAS DA NARRAÇÃO (será lida por voz sintética): só texto corrido falado. PROIBIDO emojis, símbolos (§ ¶ * # _ / % & + =), markdown, aspas decorativas, rubricas entre parênteses ou colchetes como (pausa) ou [música], e siglas soletradas. Escreva números, porcentagens e valores por extenso (ex.: 'vinte e cinco por cento', 'mil e quinhentos'). Evite palavras em inglês na narração." +
      "\nEm references, liste cada afirmação factual e como verificá-la (fonte primária sugerida). Não invente URLs." +
      (rep.script_skeleton?.length && !ready ? `\nESQUELETO DA REFERÊNCIA (siga esta sequência de funções das frases, com conteúdo novo): ${rep.script_skeleton.join(" → ")}` : "") +
      (rep.hook_anatomy ? `\nANATOMIA DO GANCHO DA REFERÊNCIA (replique a mecânica nos 3 primeiros segundos): ${rep.hook_anatomy}` : "") +
      (measured ? `\nRITMO MEDIDO NA REFERÊNCIA: um corte a cada ${measured}s. Cenas curtas, uma ideia por cena, sem pausas longas (pause_after_ms entre 0 e 150).` : "") +
      (dnaOf(report) ? `\nDNA DO FORMATO DE REFERÊNCIA (siga o gancho, a estrutura com as porcentagens, o jeito de narrar, a retenção e o CTA — com conteúdo 100% novo, sem copiar falas): ${JSON.stringify(dnaOf(report)).slice(0, 8000)}` : "") +
      `\nPerfil de estilo: ${JSON.stringify(style ?? "não definido")}` +
      `\nResumo do canal: ${JSON.stringify(report ?? "não disponível").slice(0, 12000)}`,
    schemaName: "script",
    schema: scriptSchema,
  });
  await recordTextUsage(db, userId, s, usage, "roteiro", jobId, productionId);
  // The AI often writes less than asked (e.g. 39s instead of 60s): ask it to extend until it reaches the word target.
  for (let round = 0; !ready && round < 3 && (scriptIsShort(data.scenes, target) || (short && countWords(data.scenes) < 200)); round++) {
    const have = countWords(data.scenes);
    const r = await ai<ScriptOut>({
      system: ETHICS + " Você é um roteirista profissional. Mantém o tom, o gancho e a estrutura, e só acrescenta conteúdo novo, concreto e verdadeiro.",
      user:
        `Este roteiro ficou CURTO: tem ${have} palavras de narração, mas precisa ter cerca de ${words} palavras (~${target}s de fala). ` +
        `Reescreva-o completo com essa extensão: aprofunde as cenas existentes${sceneCount ? ` mantendo EXATAMENTE ${sceneCount} cenas` : " e adicione cenas novas com informações novas"}. ` +
        "Mantenha todas as regras de narração (sem emojis, símbolos, rubricas; números por extenso), visual_query concreta (inglês para assunto internacional, português com nomes reais para assunto brasileiro) e o mesmo formato.\n\nROTEIRO ATUAL (JSON):\n" +
        JSON.stringify(data).slice(0, 60000),
      schemaName: "script",
      schema: scriptSchema,
    });
    await recordTextUsage(db, userId, s, r.usage, "roteiro (ampliação)", jobId, productionId);
    if (countWords(r.data.scenes) > have) data = r.data;
    usage = r.usage;
  }
  // Nunca deixa a última cena repetir o gancho da primeira (erro comum do "loop infinito").
  if (data.scenes.length > 2) {
    const words = (t: string) => new Set(t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]{3,}/g) ?? []);
    const a = words(data.scenes[0]!.narration), last = data.scenes[data.scenes.length - 1]!;
    const b = words(last.narration);
    const common = [...b].filter((w) => a.has(w)).length;
    if (b.size && common / b.size > 0.5) data.scenes.pop();
  }
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
  // Keep the user's own title/topic: the AI must never rename the production.
  data.title = p.title || topic;
  // Reference DNA is mandatory: every production tied to a reference inherits all measured editing layers it has not set itself.
  const R = (report ?? {}) as Record<string, any>;
  const inherit: Record<string, unknown> = {};
  if (p.reference_id) {
    if (R["caption_clone"] && (!ps["caption_style"] || ps["caption_style"] === "auto")) { inherit["caption_style"] = "clone"; inherit["caption_clone"] = R["caption_clone"]; }
    if (R["frame_mix"]?.length && !ps["frame_mix"]) inherit["frame_mix"] = R["frame_mix"];
    if (R["sfx_map"]?.length && !ps["kit_sfx"]) { inherit["kit_sfx"] = R["sfx_map"]; inherit["kit_sfx_ref_s"] = R["videos"]?.[0]?.duration_s ?? R["measured"]?.avg_duration_s ?? null; if (!ps["sfx"]) inherit["sfx"] = "on"; }
    if (R["transitions_map"]?.length && !ps["kit_transitions"]) inherit["kit_transitions"] = R["transitions_map"];
    if (R["videos"]?.[0]?.edit?.motion && !ps["kit_motion"]) inherit["kit_motion"] = R["videos"][0].edit.motion;
    if (R["color_grade"] && !ps["color_grade"]) inherit["color_grade"] = R["color_grade"];
    if (R["music_mood"] && (!ps["music_mood"] || ps["music_mood"] === "auto")) inherit["music_mood"] = R["music_mood"];
  }
  await db.from("productions").update({ script: data as never, topic, settings: { ...ps, ...inherit, video_only: videoOnly, image_only: imageOnly, ...(refPlatform ? { ref_platform: refPlatform } : {}), ...(imageOnly && !inherit["kit_motion"] && !ps["kit_motion"] ? { kit_motion: "zoom_in" } : {}), ...(measured || ps["style"] === "tiktok" ? { cut_seconds: Math.min(6, Math.max(0.8, measured ?? 2.2)) } : {}), ...(rep.voice_rate_percent != null && !ps["voice_rate"] ? { voice_rate: `${Math.round(Math.max(-20, Math.min(30, rep.voice_rate_percent))) >= 0 ? "+" : ""}${Math.round(Math.max(-20, Math.min(30, rep.voice_rate_percent)))}%` } : {}), caption_resolved: inherit["caption_style"] ? "clone" : ps["caption_style"] && ps["caption_style"] !== "auto" ? ps["caption_style"] : rep.caption_color ? rep.caption_color : /verde|green|neon/.test(dnaText) ? "neon" : /vermelh|\bred\b/.test(dnaText) ? "red" : /amarel|yellow/.test(dnaText) ? "hormozi" : "hormozi" } as never }).eq("id", productionId);
  return data;
}

/** Rewrites a single scene with AI, keeping the rest of the script as context. */
export async function runRewriteScene(db: DB, userId: string, sceneId: string, instruction: string) {
  const { data: sc } = await db.from("scenes").select("*").eq("id", sceneId).single();
  if (!sc) throw new Error("Cena não encontrada");
  const { p } = await productionContext(db, sc.production_id);
  const s = await guardBudget(db, userId, null, null);
  const ai = makeAi(userId, s, (p.settings as Record<string, unknown> | null)?.["ai_provider"]);
  const { data: all } = await db.from("scenes").select("idx,narration").eq("production_id", sc.production_id).order("idx");
  const sceneSchema = (scriptSchema as unknown as { properties: { scenes: { items: Record<string, unknown> } } }).properties.scenes.items;
  const { data, usage } = await ai<ScriptOut["scenes"][number]>({
    system: ETHICS + " Você é um roteirista profissional de vídeos virais. Reescreve uma única cena mantendo o fio da história.",
    user:
      `Tema do vídeo: "${p.topic ?? p.title}". Formato ${p.aspect}.` +
      `\nRoteiro completo (para contexto):\n${(all ?? []).map((x) => `${x.idx + 1}. ${x.narration}`).join("\n").slice(0, 20000)}` +
      `\n\nReescreva SOMENTE a cena ${sc.idx + 1}. Fala atual: "${sc.narration}".` +
      `\nPedido do usuário: ${instruction.trim() || "deixe mais envolvente, concreta e com ritmo, mantendo o tamanho parecido"}.` +
      "\nNarração só com texto falado (sem emojis, símbolos ou rubricas; números por extenso). visual_query em inglês com 2-4 termos concretos que mostrem exatamente o assunto da cena.",
    schemaName: "scene",
    schema: sceneSchema,
  });
  await recordTextUsage(db, userId, s, usage, "reescrever cena", null, sc.production_id);
  await db.from("scenes").update({ narration: data.narration, caption: data.caption, visual_description: data.visual_description, visual_query: data.visual_query, sfx: data.sfx || null, motion: data.motion, transition: data.transition, status: "edited", audio_path: null, duration_s: null }).eq("id", sceneId);
  return data;
}

/** Vision check: does this image really show what the scene needs? Cheap call, low detail thumbnail. */
export async function runCheckImage(db: DB, userId: string, jobId: string, productionId: string | null, image: string, description: string, topic: string, characters = "") {
  const s = await guardBudget(db, userId, jobId, null);
  let override: unknown;
  if (productionId) {
    const { data: p } = await db.from("productions").select("settings").eq("id", productionId).maybeSingle();
    override = (p?.settings as Record<string, unknown> | null)?.["ai_provider"];
  }
  const ai = makeAi(userId, s, override);
  const schema = { type: "object", properties: { match: { type: "boolean" }, reason: { type: "string" } }, required: ["match", "reason"], additionalProperties: false };
  const strict = characters.trim()
    ? ` REGRA ESTRITA DE PERSONAGEM: a cena exige ver "${characters}". Aprove SOMENTE se esse personagem/pessoa específico estiver visível e reconhecível na imagem (rosto, traje ou visual característico). Ser do mesmo filme, série ou franquia NÃO basta: se aparece outro personagem (ex.: Thor no lugar de Loki), só cenário, logotipo ou multidão sem ele, REPROVE. Aqui, na dúvida, reprove.`
    : " Reprove SOMENTE se for algo sem relação (outro bicho, paisagem aleatória, botão de inscreva-se, tela preta, marca d'água grande). Na dúvida, aprove.";
  const { data, usage } = await ai<{ match: boolean; reason: string }>({
    system: "Você confere se uma imagem serve para uma cena de vídeo. Detalhes (ângulo, quantidade, cor, se é à mão ou máquina, silhueta, carimbo) NUNCA reprovam. Mas quando a cena cita um personagem ou pessoa pelo nome, ele precisa estar na imagem.",
    user: `Tema do vídeo: "${topic}". A cena fala de: "${description}". A imagem anexada mostra o que a cena descreve?${strict} Responda match e um motivo curto em português.`,
    schemaName: "image_check",
    schema,
    images: [image],
  });
  await recordTextUsage(db, userId, s, usage, "conferir imagem", jobId, productionId);
  return data;
}

// Modo fatiador: a IA "assiste" um quadro de cada tomada do vídeo base e escolhe a melhor tomada para cada cena do roteiro.
export async function runMatchShots(db: DB, userId: string, jobId: string, productionId: string | null, frames: string[], scenes: string[], notes: string[] = []) {
  const s = await guardBudget(db, userId, jobId, null);
  let override: unknown;
  if (productionId) {
    const { data: p } = await db.from("productions").select("settings").eq("id", productionId).maybeSingle();
    override = (p?.settings as Record<string, unknown> | null)?.["ai_provider"];
  }
  const ai = makeAi(userId, s, override);
  const schema = {
    type: "object",
    properties: {
      shots: { type: "array", items: { type: "object", properties: { i: { type: "integer" }, who: { type: "string" }, what: { type: "string" }, energy: { type: "integer" } }, required: ["i", "who", "what", "energy"], additionalProperties: false } },
      pick: { type: "array", items: { type: "array", items: { type: "integer" } } },
      text_band: { type: "object", properties: { has: { type: "boolean" }, y0: { type: "number" }, y1: { type: "number" } }, required: ["has", "y0", "y1"], additionalProperties: false },
    },
    required: ["shots", "pick", "text_band"],
    additionalProperties: false,
  };
  const list = scenes.map((t, i) => `${i}: ${t.slice(0, 1500)}`).join("\n");
  const per = Math.max(1, Math.round(frames.length / Math.max(1, notes.length || frames.length)));
  const said = notes.map((t, i) => (t ? `tomada ${i} (narração original nesse trecho): ${t.slice(0, 1500)}` : "")).filter(Boolean).join("\n");
  const { data, usage } = await ai<{ shots: { i: number; who: string; what: string; energy: number }[]; pick: number[][]; text_band: { has: boolean; y0: number; y1: number } }>({
    system: "Você é um editor de vídeo profissional. Assiste as tomadas como uma pessoa: reconhece personagens, ações e emoção, e escolhe a tomada que melhor ilustra cada fala.",
    user: `As imagens anexadas são quadros de um vídeo base, ${per} por tomada, em ordem (as ${per} primeiras são da tomada 0, as seguintes da tomada 1, etc.). Para cada tomada diga quem aparece (who, pelo nome do personagem/pessoa/objeto quando reconhecível), o que acontece (what) e energia de 1 a 5.
${said ? "O que a narração original dizia em cada tomada (forte pista de quem aparece):\n" + said + "\n" : ""}
Depois, para cada cena do roteiro, devolva em "pick" 1 a 3 tomadas, em ordem de preferência, que MOSTRAM EXATAMENTE o personagem/assunto que a fala cita. Regras: 1) o assunto da fala manda — nunca escolha uma tomada de outro personagem só porque é bonita; 2) se o roteiro segue a mesma ordem do vídeo base, mantenha essa ordem; 3) evite repetir tomadas entre cenas próximas, mas repetir é melhor que mostrar o assunto errado; 4) gancho (cena 0) com a tomada mais forte do assunto principal.
Por fim, em "text_band", diga se os quadros têm legenda/texto queimado na imagem (has) e a faixa vertical onde ele costuma ficar, como fração da altura (y0 topo, y1 base, ex.: 0.62 e 0.80). Se não houver, has=false, y0=0, y1=0.
Cenas:\n${list}`,
    schemaName: "shot_match",
    schema,
    images: frames,
  });
  await recordTextUsage(db, userId, s, usage, "casar tomadas com o roteiro", jobId, productionId);
  return data;
}
