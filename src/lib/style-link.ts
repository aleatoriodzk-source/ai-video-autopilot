/**
 * Integração do perfil v2 (Fase 1/2) com o fluxo real: escolha do perfil forense medido,
 * gravação junto ao legado e associação segura produção → perfil de estilo.
 * Funções puras: quem chama decide se e onde gravar.
 */
import { parseStructured, withStructured, STYLE_PROFILE_VERSION, type StructuredStyleProfile } from "./style-profile";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isV2 = (v: unknown): v is Obj => isObj(v) && v["version"] === STYLE_PROFILE_VERSION;

/** Primeiro vídeo coletado com perfil forense v2 válido (o mais recente vem primeiro na coleta). */
export function pickStructured(collected: unknown, ids: { referenceId: string | null; analysisId: string }): StructuredStyleProfile | null {
  const vids = isObj(collected) && Array.isArray(collected["videos"]) ? (collected["videos"] as unknown[]) : [];
  const raw = vids.map((v) => (isObj(v) ? v["structured"] : null)).find(isV2);
  if (!raw) return null;
  const p = parseStructured(raw);
  p.source = { reference_id: ids.referenceId, analysis_id: ids.analysisId, migrated_from_legacy: false };
  return p;
}

/** JSON final de style_profiles.profile: campos legados intactos + `structured` quando há medição. */
export function profileToSave(legacy: unknown, structured: StructuredStyleProfile | null): unknown {
  return structured ? withStructured(legacy, structured) : legacy;
}

export type StyleCandidate = { id: string; user_id: string; profile: unknown; analyses: { reference_id: string | null; user_id: string } | null };
export type StyleLink = { styleId: string | null; reason: "already_linked" | "matched" | "no_reference" | "no_candidate" | "ambiguous" };

/**
 * Perfil para uma produção sem style_id: só do MESMO usuário, ligado (via análise) à MESMA referência
 * e com perfil v2 medido. Mais de um candidato = ambíguo → não associa.
 */
export function resolveStyleLink(prod: { user_id: string; style_id: string | null; reference_id: string | null }, candidates: StyleCandidate[]): StyleLink {
  if (prod.style_id) return { styleId: prod.style_id, reason: "already_linked" };
  if (!prod.reference_id) return { styleId: null, reason: "no_reference" };
  const ok = candidates.filter(
    (c) => c.user_id === prod.user_id && c.analyses?.user_id === prod.user_id && c.analyses?.reference_id === prod.reference_id && isObj(c.profile) && isV2(c.profile["structured"]),
  );
  if (ok.length === 0) return { styleId: null, reason: "no_candidate" };
  if (ok.length > 1) return { styleId: null, reason: "ambiguous" };
  return { styleId: ok[0].id, reason: "matched" };
}
