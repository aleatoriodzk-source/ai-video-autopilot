import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type XrayScene = { start: number; end: number; shot: string; action: string; energy: number; sfx: string; transition: string; caption: string };
export type Xray = {
  hook: { score: number; visual: string; spoken_style: string; trigger: string; verdict: string; fix: string };
  scenes: XrayScene[];
  retention: { second: number; attention: number; risk: string }[];
  dna: { cuts_per_min: number; avg_scene_s: number; content_mix: string; music: string; sfx_pattern: string; caption_style: string; pacing: string };
  formula: string[];
  virality: number;
  weak_points: string[];
};

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const obj = (p: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const schema = obj({
  hook: obj({ score: N, visual: S, spoken_style: S, trigger: S, verdict: S, fix: S }),
  scenes: { type: "array", items: obj({ start: N, end: N, shot: S, action: S, energy: N, sfx: S, transition: S, caption: S }) },
  retention: { type: "array", items: obj({ second: N, attention: N, risk: S }) },
  dna: obj({ cuts_per_min: N, avg_scene_s: N, content_mix: S, music: S, sfx_pattern: S, caption_style: S, pacing: S }),
  formula: { type: "array", items: S },
  virality: N,
  weak_points: { type: "array", items: S },
});

export const xrayVideo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { frames: { t: number; img: string }[]; duration: number; title?: string; cuts?: number[] }) => ({
    frames: (Array.isArray(i.frames) ? i.frames : []).slice(0, 40).map((f) => ({ t: Number(f.t) || 0, img: String(f.img).slice(0, 400_000) })),
    duration: Math.max(1, Number(i.duration) || 1),
    title: String(i.title ?? "").slice(0, 120),
    cuts: (Array.isArray(i.cuts) ? i.cuts : []).slice(0, 300).map(Number),
  }))
  .handler(async ({ data, context }) => {
    try {
      if (!data.frames.length) throw new Error("Nenhum quadro do vídeo foi capturado");
      const { aiJson } = await import("@/server/ai.server");
      const { loadKeys } = await import("@/server/tasks.server");
      const keys = await loadKeys(context.userId);
      const stamps = data.frames.map((f, k) => `Imagem ${k + 1} = segundo ${f.t.toFixed(1)}`).join("; ");
      const r = await aiJson<Xray>({
        keys,
        schemaName: "lab_xray",
        schema,
        images: data.frames.map((f) => f.img),
        system:
          "Você é um editor sênior de canais dark virais (Shorts/TikTok/YouTube) e analista de retenção. Disseca vídeos como um humano assistindo: entende gancho, ritmo, emoção e onde o público rola a tela. Responda em PT-BR, concreto, sem enrolação.",
        user:
          `Vídeo "${data.title}" com ${data.duration.toFixed(1)}s. Recebeu ${data.frames.length} quadros em ordem: ${stamps}.` +
          (data.cuts.length ? ` Cortes detectados por mudança de imagem nos segundos: ${data.cuts.map((c) => c.toFixed(1)).join(", ")}.` : "") +
          `\nTarefas:\n1) hook: analise os segundos 0-3 (nota 0-100, o que aparece, estilo de fala provável, gatilho psicológico, veredito e como melhorar).` +
          `\n2) scenes: divida o vídeo em TODAS as cenas reais (quantidade dinâmica, use os cortes detectados), cada uma com start/end em segundos, shot (o que aparece, cite personagens/pessoas reais se reconhecer), action, energy 1-10, sfx provável, transition, caption (texto/legenda visível ou estilo).` +
          `\n3) retention: curva de atenção estimada, um ponto a cada 1 segundo de 0 até ${Math.ceil(data.duration)}, attention 0-100, risk vazio se ok ou motivo curto do risco de scroll (imagem parada, repetição, falta de impacto).` +
          `\n4) dna: cortes por minuto, duração média da cena, mistura de conteúdo (ex: 70% luta/ação, 30% close), música, padrão de sfx, estilo de legenda, ritmo.` +
          `\n5) formula: 5 a 8 regras objetivas para replicar este vídeo trocando só o tema.` +
          `\n6) virality: nota 0-100 de potencial viral. 7) weak_points: momentos fracos com o segundo.`,
      });
      const x = JSON.parse(JSON.stringify(r.data)) as Xray;
      // Nota estável: 70% métricas objetivas (cortes/min, corte nos 2s iniciais) + 30% IA, arredondada de 5 em 5.
      const cpm = (data.cuts.length / data.duration) * 60;
      const cutScore = cpm >= 15 && cpm <= 45 ? 100 : cpm < 15 ? (cpm / 15) * 100 : Math.max(50, 100 - (cpm - 45) * 2);
      const early = data.cuts.some((c) => c > 0.2 && c <= 2.5) ? 100 : 40;
      const objective = cutScore * 0.6 + early * 0.4;
      const ai = Math.max(0, Math.min(100, Number(x.virality) || 50));
      x.virality = data.cuts.length ? Math.round((objective * 0.7 + ai * 0.3) / 5) * 5 : Math.round(ai / 5) * 5;
      x.hook.score = Math.round((Number(x.hook.score) || 50) / 5) * 5;
      return { ok: true as const, xray: x };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

export type ChannelFormula = { summary: string; cuts_per_min: number; avg_scene_s: number; hook_pattern: string; content_mix: string; music: string; sfx: string; captions: string; rules: string[] };

const channelSchema = obj({ summary: S, cuts_per_min: N, avg_scene_s: N, hook_pattern: S, content_mix: S, music: S, sfx: S, captions: S, rules: { type: "array", items: S } });

/** Cruza até 5 Raio-X do mesmo canal e extrai a Fórmula de Ouro comum. */
export const crossFormula = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { items: { title: string; duration: number; xray: Xray }[] }) => ({
    items: (Array.isArray(i.items) ? i.items : []).slice(0, 5).map((x) => ({ title: String(x.title).slice(0, 120), duration: Number(x.duration) || 0, xray: x.xray })),
  }))
  .handler(async ({ data, context }) => {
    try {
      if (data.items.length < 2) throw new Error("Escolha pelo menos 2 Raio-X");
      const { aiJson } = await import("@/server/ai.server");
      const { loadKeys } = await import("@/server/tasks.server");
      const keys = await loadKeys(context.userId);
      const brief = data.items.map((it, k) => {
        const x = it.xray;
        return `VÍDEO ${k + 1} "${it.title}" (${it.duration.toFixed(0)}s, viral ${x.virality}, gancho ${x.hook.score}): gancho=${x.hook.visual} / ${x.hook.trigger}; DNA=${JSON.stringify(x.dna)}; cenas=${x.scenes.map((s) => `${s.shot} (energia ${s.energy})`).join(" | ").slice(0, 1500)}; regras=${x.formula.join(" ; ")}`;
      }).join("\n\n");
      const r = await aiJson<ChannelFormula>({
        keys, schemaName: "channel_formula", schema: channelSchema,
        system: "Você é um editor sênior de canais dark. Cruza análises de vários vídeos do mesmo canal e extrai SÓ o que se repete (o padrão real), em números e regras objetivas. PT-BR.",
        user: `${brief}\n\nExtraia a Fórmula de Ouro do canal: médias de cortes/min e duração de cena, padrão de gancho, mistura de conteúdo (ex: 60% ação), música, SFX, legenda, e 6 a 10 regras objetivas para copiar o canal trocando só o tema.`,
      });
      return { ok: true as const, formula: JSON.parse(JSON.stringify(r.data)) as ChannelFormula };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

export type ClonedCaption = { name: string; font: string; color: string; highlight: string; outline: string; box: boolean; upper: boolean; italic: boolean; position: string; words_per_block: number };
const capSchema = obj({ name: S, font: S, color: S, highlight: S, outline: S, box: { type: "boolean" }, upper: { type: "boolean" }, italic: { type: "boolean" }, position: S, words_per_block: N });

/** Lê o print de uma legenda e devolve um preset pronto. */
export const cloneCaption = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { img: string }) => ({ img: String(i.img).slice(0, 2_000_000) }))
  .handler(async ({ data, context }) => {
    try {
      if (!data.img.startsWith("data:image")) throw new Error("Envie uma imagem");
      const { aiJson } = await import("@/server/ai.server");
      const { loadKeys } = await import("@/server/tasks.server");
      const keys = await loadKeys(context.userId);
      const r = await aiJson<ClonedCaption>({
        keys, schemaName: "caption_clone", schema: capSchema, images: [data.img],
        system: "Você é especialista em tipografia de vídeos virais (CapCut/TikTok/Reels).",
        user: "Analise a legenda deste print. Devolva: name (nome curto do estilo), font (a fonte Google Fonts mais parecida, ex: Bebas Neue, Anton, Montserrat, Poppins, Oswald, Archivo Black), color (hex do texto), highlight (hex da palavra em destaque ou igual a color), outline (hex da borda/sombra), box (tem tarja atrás?), upper (caixa alta?), italic, position (topo|meio|base), words_per_block (1 a 5).",
      });
      return { ok: true as const, caption: JSON.parse(JSON.stringify(r.data)) as ClonedCaption };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
