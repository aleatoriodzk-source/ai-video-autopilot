// Shared pipeline definition — used by the web panel, the agent API and tests.
export type StepId =
  | "analyze"
  | "topic"
  | "script"
  | "narration"
  | "visuals"
  | "scenes"
  | "captions"
  | "audio"
  | "render"
  | "validate";

export const STEPS: { id: StepId; label: string; reviewable: boolean; runsOn: "agente" | "nuvem" }[] = [
  { id: "analyze", label: "Analisar referências", reviewable: false, runsOn: "agente" },
  { id: "topic", label: "Selecionar tema", reviewable: true, runsOn: "nuvem" },
  { id: "script", label: "Criar roteiro", reviewable: true, runsOn: "nuvem" },
  { id: "narration", label: "Gerar narração", reviewable: true, runsOn: "agente" },
  { id: "visuals", label: "Selecionar/gerar imagens", reviewable: true, runsOn: "agente" },
  { id: "scenes", label: "Montar cenas", reviewable: true, runsOn: "agente" },
  { id: "captions", label: "Legendas sincronizadas", reviewable: true, runsOn: "agente" },
  { id: "audio", label: "Efeitos e ajuste de áudio", reviewable: false, runsOn: "agente" },
  { id: "render", label: "Renderizar vídeo", reviewable: true, runsOn: "agente" },
  { id: "validate", label: "Validar e gerar relatório", reviewable: false, runsOn: "agente" },
];

/** Which steps must be redone when a given step changes. */
export const DEPENDENTS: Record<StepId, StepId[]> = {
  analyze: ["topic", "script", "narration", "visuals", "scenes", "captions", "audio", "render", "validate"],
  topic: ["script", "narration", "visuals", "scenes", "captions", "audio", "render", "validate"],
  script: ["narration", "visuals", "scenes", "captions", "audio", "render", "validate"],
  narration: ["scenes", "captions", "audio", "render", "validate"],
  visuals: ["scenes", "render", "validate"],
  scenes: ["render", "validate"],
  captions: ["render", "validate"],
  audio: ["render", "validate"],
  render: ["validate"],
  validate: [],
};

/** Completed steps after the user asks to redo `step` (keeps unaffected work). */
export function invalidateFrom(completed: string[], step: StepId): string[] {
  const drop = new Set<string>([step, ...DEPENDENTS[step]]);
  return completed.filter((s) => !drop.has(s));
}

export function nextStep(completed: string[]): StepId | null {
  return STEPS.find((s) => !completed.includes(s.id))?.id ?? null;
}

export const JOB_STATUS_LABEL: Record<string, string> = {
  queued: "Na fila (aguardando agente)",
  running: "Executando",
  waiting_api: "IA trabalhando…",
  waiting_download: "Baixando arquivos",
  rendering: "Renderizando",
  awaiting_review: "Aguardando sua revisão",
  paused: "Pausado",
  failed: "Falhou",
  cancelled: "Cancelado",
  done: "Concluído",
};
