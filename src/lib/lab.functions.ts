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
      return { ok: true as const, xray: JSON.parse(JSON.stringify(r.data)) as Xray };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
