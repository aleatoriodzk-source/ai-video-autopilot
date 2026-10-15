import { supabase } from "@/integrations/supabase/client";
import { invalidateFrom, type StepId } from "./pipeline";

async function uid() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Sessão expirada");
  return data.user.id;
}

export async function activeJob(productionId: string) {
  const { data } = await supabase.from("jobs").select("*").eq("production_id", productionId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data;
}

/** Starts (or restarts) the production pipeline, keeping work already completed. */
export async function startProduction(productionId: string, opts: { needsAnalysis: boolean; analysisId?: string | null; referenceId?: string | null }) {
  const user_id = await uid();
  const existing = await activeJob(productionId);
  if (existing && !["done", "cancelled", "failed"].includes(existing.status)) {
    await supabase.from("jobs").update({ status: "queued", error: null }).eq("id", existing.id);
    return existing.id;
  }
  const completed = existing?.completed_steps ?? (opts.needsAnalysis ? [] : ["analyze"]);
  const { data, error } = await supabase
    .from("jobs")
    .insert({ user_id, type: "production", production_id: productionId, reference_id: opts.referenceId ?? null, analysis_id: opts.analysisId ?? null, completed_steps: existing?.status === "done" ? [] : completed })
    .select("id")
    .single();
  if (error) throw error;
  await supabase.from("productions").update({ status: "queued" }).eq("id", productionId);
  return data.id;
}

export async function setJobStatus(jobId: string, status: "paused" | "queued" | "cancelled") {
  await supabase.from("jobs").update({ status, ...(status === "queued" ? { error: null, attempts: 0 } : {}) }).eq("id", jobId);
}

export async function approveStep(jobId: string) {
  await supabase.from("jobs").update({ status: "queued", wait_reason: null }).eq("id", jobId);
}

export async function redoStep(jobId: string, completed: string[], step: StepId) {
  await supabase.from("jobs").update({ completed_steps: invalidateFrom(completed, step), status: "queued", error: null, attempts: 0 }).eq("id", jobId);
}

export async function requestAnalysis(referenceId: string, kind: "channel" | "short") {
  const user_id = await uid();
  const { data: a, error } = await supabase.from("analyses").insert({ user_id, reference_id: referenceId, kind }).select("id").single();
  if (error) throw error;
  await supabase.from("jobs").insert({ user_id, type: "analyze_reference", reference_id: referenceId, analysis_id: a.id });
  await supabase.from("reference_sources").update({ status: "queued" }).eq("id", referenceId);
  return a.id;
}

export function agentOnline(lastSeen: string | null | undefined) {
  return !!lastSeen && Date.now() - new Date(lastSeen).getTime() < 90_000;
}
