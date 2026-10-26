/**
 * Etapa TypeScript do teste ponta a ponta (agent/test_e2e_style.py).
 * Usa as MESMAS funções do servidor (pickStructured/profileToSave/resolveStyleLink) sobre um armazenamento
 * em memória — nenhuma linha do banco real é lida ou gravada.
 * Uso: bun scripts/e2e-style-link.ts <entrada.json> <saida.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pickStructured, profileToSave, resolveStyleLink, type StyleCandidate } from "../src/lib/style-link";

const [, , inPath, outPath] = process.argv;
const input = JSON.parse(readFileSync(inPath, "utf8")) as { collected: unknown; legacy: Record<string, unknown>; scenes: unknown[] };
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b";
const REF = "00000000-0000-4000-8000-0000000000r1".replace("r1", "f1"), REF2 = "00000000-0000-4000-8000-0000000000f2";
const AN = "00000000-0000-4000-8000-0000000000a1";

// runAnalysis: perfil v2 escolhido da coleta + legado preservado
const structured = pickStructured(input.collected, { referenceId: REF, analysisId: AN });
if (!structured) throw new Error("coleta sem perfil v2");
const saved = profileToSave(input.legacy, structured) as Record<string, unknown>;
const legacyKept = Object.keys(input.legacy).every((k) => JSON.stringify(saved[k]) === JSON.stringify(input.legacy[k]));

const v2 = (ref: string) => ({ structured: { ...structured, source: { ...structured.source, reference_id: ref } } });
const store: StyleCandidate[] = [
  { id: "style-target", user_id: A, profile: saved, analyses: { reference_id: REF, user_id: A } },
  { id: "decoy-other-user", user_id: B, profile: v2(REF), analyses: { reference_id: REF, user_id: B } },
  { id: "decoy-other-ref", user_id: A, profile: v2(REF2), analyses: { reference_id: REF2, user_id: A } },
  { id: "decoy-legacy-only", user_id: A, profile: input.legacy, analyses: { reference_id: REF, user_id: A } },
];
const prod = { id: "prod-e2e", user_id: A, style_id: null as string | null, reference_id: REF, output_path: null, title: "E2E perfil v2", aspect: "9:16", mode: "auto", topic: "teste", settings: { music_mood: "none", sfx: "on" }, versions: [] };
const link = resolveStyleLink(prod, store);
const ambiguous = resolveStyleLink(prod, [...store, { ...store[0], id: "style-target-2" }]);
const row = store.find((c) => c.id === link.styleId) ?? null;
const persisted = !!link.styleId && !prod.output_path;
if (persisted) prod.style_id = link.styleId;

writeFileSync(outPath, JSON.stringify({
  checks: { legacy_kept: legacyKept, has_structured: !!saved["structured"], link, ambiguous_reason: ambiguous.reason },
  bundle: { production: { ...prod, style_profiles: row }, scenes: input.scenes, style_link: { reason: link.reason, style_id: link.styleId, persisted } },
}));
console.log(JSON.stringify({ link, ambiguous: ambiguous.reason, legacyKept }));
