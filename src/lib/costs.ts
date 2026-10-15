// Cost estimation and budget rules. Prices are NEVER assumed: unknown => null.
export type Prices = {
  /** USD per 1M tokens for Lovable AI text calls (user-configured from their billing). */
  ai_text_per_mtok?: number | null;
  /** USD per AI-generated image. */
  ai_image_each?: number | null;
  /** USD per 1k characters for paid TTS (e.g. ElevenLabs). Piper is local = 0. */
  tts_per_kchar?: number | null;
};

export type Limits = {
  max_usd_per_task?: number | null;
  max_usd_per_month?: number | null;
  max_ai_images_per_video?: number | null;
};

export type EstimateInput = {
  scenes: number;
  narrationChars: number;
  aiImages: number;
  ttsProvider: "piper" | "elevenlabs";
  needsScript: boolean;
  needsAnalysis: boolean;
};

export type EstimateLine = { item: string; provider: string; cost: number | null; note: string };

// Rough token budgets per AI call (input+output), documented as estimates.
export const TOKENS = { analysis: 20000, ideas: 4000, script: 8000 };

export function estimateCost(input: EstimateInput, prices: Prices): { lines: EstimateLine[]; total: number | null; unknown: boolean } {
  const lines: EstimateLine[] = [];
  const tok = (input.needsAnalysis ? TOKENS.analysis : 0) + (input.needsScript ? TOKENS.ideas + TOKENS.script : 0);
  if (tok > 0) {
    const p = prices.ai_text_per_mtok;
    lines.push({
      item: `Texto IA (~${tok.toLocaleString("pt-BR")} tokens, estimativa)`,
      provider: "Lovable AI",
      cost: p == null ? null : (tok / 1_000_000) * p,
      note: p == null ? "Preço não configurado — consome créditos de IA da sua área de trabalho" : "Estimativa",
    });
  }
  if (input.aiImages > 0) {
    const p = prices.ai_image_each;
    lines.push({
      item: `${input.aiImages} imagem(ns) por IA`,
      provider: "Lovable AI",
      cost: p == null ? null : input.aiImages * p,
      note: p == null ? "Preço não configurado — consome créditos" : "Estimativa",
    });
  }
  if (input.ttsProvider === "piper") {
    lines.push({ item: "Narração", provider: "Piper (local)", cost: 0, note: "Roda no seu computador, sem cobrança" });
  } else {
    const p = prices.tts_per_kchar;
    lines.push({
      item: `Narração (${input.narrationChars} caracteres)`,
      provider: "ElevenLabs",
      cost: p == null ? null : (input.narrationChars / 1000) * p,
      note: "Plano pago próprio; verifique seu limite mensal de caracteres",
    });
  }
  lines.push({ item: "Montagem e renderização", provider: "FFmpeg (local)", cost: 0, note: "Código aberto, roda no seu PC" });
  const unknown = lines.some((l) => l.cost == null);
  const total = unknown ? null : lines.reduce((s, l) => s + (l.cost ?? 0), 0);
  return { lines, total, unknown };
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

export function evaluateBudget(args: { limits: Limits; spentTask: number; spentMonth: number; nextCost: number | null }): BudgetDecision {
  const { limits, spentTask, spentMonth, nextCost } = args;
  const add = nextCost ?? 0;
  if (limits.max_usd_per_task != null && spentTask + add > limits.max_usd_per_task)
    return { allowed: false, reason: `Limite por tarefa (US$ ${limits.max_usd_per_task}) seria ultrapassado` };
  if (limits.max_usd_per_month != null && spentMonth + add > limits.max_usd_per_month)
    return { allowed: false, reason: `Limite mensal (US$ ${limits.max_usd_per_month}) seria ultrapassado` };
  return { allowed: true };
}

export function canGenerateAiImage(args: { allowPaid: boolean; usedInVideo: number; limits: Limits }): BudgetDecision {
  if (!args.allowPaid) return { allowed: false, reason: "Imagens por IA desativadas (serviço pago) nas configurações" };
  const max = args.limits.max_ai_images_per_video;
  if (max != null && args.usedInVideo >= max) return { allowed: false, reason: `Limite de ${max} imagens por IA por vídeo atingido` };
  return { allowed: true };
}
