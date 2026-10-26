import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Local agent API. Every request must carry `Authorization: Bearer <agent token>`;
// tokens are created in the panel and only their SHA-256 hash is stored.
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const Body = z.object({ action: z.string().max(40) }).passthrough();
const uuid = z.string().uuid();
const JOB_STATUSES = ["queued", "running", "waiting_api", "waiting_download", "rendering", "awaiting_review", "paused", "failed", "cancelled", "done"] as const;

const json = (d: unknown, status = 200) => Response.json(d, { status });

export const Route = createFileRoute("/api/public/agent")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        if (token.length < 30) return json({ error: "token ausente" }, 401);
        const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
        const { data: agent } = await db.from("agents").select("id,user_id,revoked").eq("token_hash", await sha256(token)).maybeSingle();
        if (!agent || agent.revoked) return json({ error: "token inválido ou revogado" }, 401);
        const userId = agent.user_id;

        let body: any;
        try {
          body = Body.parse(await request.json());
        } catch {
          return json({ error: "corpo inválido" }, 400);
        }

        const ownJob = async (id: unknown) => {
          const { data } = await db.from("jobs").select("*").eq("id", uuid.parse(id)).eq("user_id", userId).maybeSingle();
          if (!data) throw new Error("job não encontrado");
          return data;
        };
        const ownProduction = async (id: unknown) => {
          const { data } = await db.from("productions").select("*").eq("id", uuid.parse(id)).eq("user_id", userId).maybeSingle();
          if (!data) throw new Error("produção não encontrada");
          return data;
        };

        try {
          const tasks = await import("@/server/tasks.server");
          switch (body.action) {
            case "heartbeat": {
              await db.from("agents").update({ last_seen_at: new Date().toISOString(), info: (body.info ?? null) as never }).eq("id", agent.id);
              return json({ ok: true, settings: await tasks.loadSettings(db, userId) });
            }
            case "claim": {
              await db.from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", agent.id);
              const now = new Date().toISOString();
              // Jobs left "running" by a closed/crashed agent go back to the queue (or fail after max attempts) instead of hanging forever.
              const stale = new Date(Date.now() - 20 * 60_000).toISOString();
              const { data: stuck } = await db.from("jobs").select("id,attempts,max_attempts,production_id,step").eq("user_id", userId).in("status", ["running", "waiting_api", "waiting_download", "rendering"]).lt("updated_at", stale);
              for (const s of stuck ?? []) {
                const attempts = s.attempts + 1;
                const failed = attempts >= s.max_attempts;
                await db.from("jobs").update({ status: failed ? "failed" : "queued", attempts, locked_by: null, wait_reason: null, error: failed ? `A etapa "${s.step ?? "?"}" ficou parada mais de 20 minutos (o agente foi fechado ou travou).` : null }).eq("id", s.id);
                if (s.production_id) await db.from("productions").update({ status: failed ? "failed" : "queued" }).eq("id", s.production_id);
              }
              const { data: jobs } = await db.from("jobs").select("*").eq("user_id", userId).eq("status", "queued").order("created_at").limit(10);
              const job = (jobs ?? []).find((j) => !(j.payload as Record<string, string>)?.["retry_at"] || ((j.payload as Record<string, string>)["retry_at"] ?? "") <= now);
              if (!job) return json({ job: null });
              const { data: locked } = await db.from("jobs").update({ status: "running", locked_by: agent.id, locked_at: now, wait_reason: null }).eq("id", job.id).eq("status", "queued").select("*").maybeSingle();
              if (!locked) return json({ job: null });
              return json({ job: locked, ...(await bundle(db, locked, userId)) });
            }
            case "get_job": {
              const job = await ownJob(body.job_id);
              return json({ job, ...(await bundle(db, job, userId)) });
            }
            case "update_job": {
              const job = await ownJob(body.job_id);
              const p = z
                .object({
                  status: z.enum(JOB_STATUSES).optional(),
                  step: z.string().max(40).nullable().optional(),
                  progress: z.number().min(0).max(100).optional(),
                  wait_reason: z.string().max(300).nullable().optional(),
                  completed_steps: z.array(z.string().max(40)).max(20).optional(),
                  attempts: z.number().int().min(0).max(50).optional(),
                  error: z.string().max(4000).nullable().optional(),
                  payload: z.record(z.unknown()).optional(),
                })
                .parse(body.patch ?? {});
              // Never override a user's pause/cancel with agent progress.
              const { data: cur } = await db.from("jobs").select("status").eq("id", job.id).single();
              if (cur && ["paused", "cancelled"].includes(cur.status) && p.status && !["paused", "cancelled"].includes(p.status)) delete p.status;
              const { data } = await db.from("jobs").update(p as never).eq("id", job.id).select("*").single();
              if (job.production_id && (p.status || p.step)) await db.from("productions").update({ status: data!.status, current_step: data!.step }).eq("id", job.production_id);
              return json({ job: data });
            }
            case "log": {
              const l = z.object({ job_id: uuid.nullable().optional(), production_id: uuid.nullable().optional(), level: z.enum(["debug", "info", "warn", "error"]), step: z.string().max(40).nullable().optional(), message: z.string().max(4000), data: z.unknown().optional() }).parse(body);
              await db.from("activity_logs").insert({ user_id: userId, job_id: l.job_id ?? null, production_id: l.production_id ?? null, level: l.level, step: l.step ?? null, message: l.message, data: (l.data ?? null) as never });
              return json({ ok: true });
            }
            case "record_usage": {
              const u = z.object({ job_id: uuid.nullable().optional(), production_id: uuid.nullable().optional(), provider: z.string().max(80), operation: z.string().max(80), units: z.number(), unit_name: z.string().max(30), cost_usd: z.number().nullable() }).parse(body);
              await db.from("usage_records").insert({ ...u, user_id: userId } as never);
              return json({ ok: true });
            }
            case "save_collected": {
              const job = await ownJob(body.job_id);
              if (!job.reference_id) throw new Error("job sem referência");
              await db.from("reference_sources").update({ collected: body.collected as never, status: "collected", title: (body.title as string) ?? undefined }).eq("id", job.reference_id);
              return json({ ok: true });
            }
            case "ai_analyze": {
              const job = await ownJob(body.job_id);
              if (!job.analysis_id) throw new Error("job sem análise");
              const frames = z.array(z.string().max(400_000)).max(10).optional().parse(body.frames);
              const r = await tasks.runAnalysis(db, userId, { analysisId: job.analysis_id, jobId: job.id, collected: body.collected, frames: frames ?? [] });
              if (job.production_id && r.styleId) {
                const prod = await ownProduction(job.production_id);
                if (!prod.style_id) await db.from("productions").update({ style_id: r.styleId }).eq("id", prod.id);
              }
              return json(r);
            }
            case "ai_ideas": {
              const job = await ownJob(body.job_id);
              return json({ ideas: await tasks.runIdeas(db, userId, job.production_id!, job.id) });
            }
            case "ai_script": {
              const job = await ownJob(body.job_id);
              const topic = z.string().max(500).optional().parse(body.topic);
              return json({ script: await tasks.runScript(db, userId, job.production_id!, job.id, topic) });
            }
            case "ai_image": {
              const job = await ownJob(body.job_id);
              const { prompt, aspect, used } = z.object({ prompt: z.string().min(3).max(2000), aspect: z.enum(["9:16", "16:9", "1:1", "3:4"]), used: z.number().int().min(0) }).parse(body);
              const s = await tasks.guardBudget(db, userId, job.id, null);
              const { canGenerateAiImage } = await import("@/lib/costs");
              const ok = canGenerateAiImage({ allowPaid: s.ai.allow_ai_images, usedInVideo: used, limits: s.limits });
              if (!ok.allowed) return json({ error: ok.reason, blocked: true }, 402);
              const { aiImage } = await import("@/server/ai.server");
              const b64 = await aiImage(prompt, aspect, s.ai.image_model);
              await db.from("usage_records").insert({ user_id: userId, job_id: job.id, production_id: job.production_id, provider: `Lovable AI (${s.ai.image_model})`, operation: "imagem IA", units: 1, unit_name: "imagem", cost_usd: s.prices.ai_image_each ?? null });
              return json({ b64 });
            }
            case "check_image": {
              const job = await ownJob(body.job_id);
              const { image, description, topic, characters } = z.object({ image: z.string().startsWith("data:image/").max(400_000), description: z.string().max(1000), topic: z.string().max(500), characters: z.string().max(300).optional() }).parse(body);
              return json(await tasks.runCheckImage(db, userId, job.id, job.production_id, image, description, topic, characters ?? ""));
            }
            case "update_scene": {
              const id = uuid.parse(body.scene_id);
              const f = z.object({ duration_s: z.number().optional(), audio_path: z.string().max(500).optional(), audio_duration_s: z.number().optional(), word_timings: z.unknown().optional(), asset_id: uuid.nullable().optional(), status: z.string().max(30).optional() }).parse(body.fields ?? {});
              await db.from("scenes").update(f as never).eq("id", id).eq("user_id", userId);
              return json({ ok: true });
            }
            case "create_asset": {
              const a = z.object({ production_id: uuid.nullable().optional(), kind: z.enum(["image", "video", "audio", "music", "sfx"]), source: z.enum(["upload", "ai_image", "ai_video", "pexels", "pixabay", "local", "openverse", "youtube", "web", "wikimedia", "nasa", "archive"]), source_url: z.string().max(1000).nullable().optional(), license: z.string().max(300).nullable().optional(), attribution: z.string().max(300).nullable().optional(), local_path: z.string().max(500).nullable().optional(), storage_path: z.string().max(500).nullable().optional(), description: z.string().max(1000).nullable().optional(), meta: z.record(z.unknown()).optional() }).parse(body.asset);
              const { data } = await db.from("assets").insert({ ...a, user_id: userId, meta: a.meta ?? {} } as never).select("id").single();
              return json({ id: data!.id });
            }
            case "save_production": {
              const prod = await ownProduction(body.production_id);
              const f = z.object({ validation: z.unknown().optional(), report: z.unknown().optional(), output_path: z.string().max(500).optional(), preview_path: z.string().max(500).optional(), status: z.string().max(30).optional(), title: z.string().max(200).optional(), topic: z.string().max(500).optional(), versions: z.array(z.record(z.string(), z.unknown())).max(50).optional() }).parse(body.fields ?? {});
              await db.from("productions").update(f as never).eq("id", prod.id);
              return json({ ok: true });
            }
            case "upload_url": {
              const name = z.string().regex(/^[\w\-./]+$/).max(200).parse(body.name);
              const path = `${userId}/${name.replace(/\.\.+/g, ".")}`;
              const { data, error } = await db.storage.from("media").createSignedUploadUrl(path, { upsert: true });
              if (error) throw error;
              return json({ path, signed_url: data.signedUrl, token: data.token });
            }
            case "download_url": {
              const path = z.string().max(500).parse(body.path);
              if (!path.startsWith(`${userId}/`)) return json({ error: "caminho não permitido" }, 403);
              const { data, error } = await db.storage.from("media").createSignedUrl(path, 3600);
              if (error) throw error;
              return json({ url: data.signedUrl });
            }
            case "save_voice": {
              const id = uuid.parse(body.voice_id);
              const f = z.object({ status: z.enum(["queued", "processing", "ready", "failed"]).optional(), sample_path: z.string().max(500).nullable().optional(), stats: z.record(z.unknown()).optional(), error: z.string().max(2000).nullable().optional() }).parse(body.fields ?? {});
              await db.from("voices").update(f as never).eq("id", id).eq("user_id", userId);
              return json({ ok: true });
            }
            case "cookies": {
              // Arquivos de sessão (cookies.txt) que o usuário enviou para YouTube/TikTok.
              const { data } = await db.from("linked_accounts").select("platform,cookies_path").eq("user_id", userId);
              const out: Record<string, string> = {};
              for (const a of data ?? []) {
                const { data: s } = await db.storage.from("media").createSignedUrl(a.cookies_path, 600);
                if (s) out[a.platform] = s.signedUrl;
              }
              return json({ cookies: out });
            }
            case "ai_match_shots": {
              const job = await ownJob(body.job_id);
              const { frames, scenes, notes } = z.object({ frames: z.array(z.string().startsWith("data:image/").max(600_000)).min(1).max(100), scenes: z.array(z.string().max(2000)).min(1).max(120), notes: z.array(z.string().max(2000)).max(60).optional() }).parse(body);
              return json({ match: await tasks.runMatchShots(db, userId, job.id, job.production_id, frames, scenes, notes ?? []) });
            }
            default:
              return json({ error: "ação desconhecida" }, 400);
          }
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          const status = (e as { status?: number }).status ?? (msg.startsWith("ORÇAMENTO") ? 402 : e instanceof z.ZodError ? 400 : 500);
          return json({ error: msg, retryable: status === 429 || status >= 500 }, status);
        }
      },
    },
  },
});

async function bundle(db: any, job: { production_id: string | null; reference_id: string | null; analysis_id: string | null }, userId?: string) {
  const out: any = {};
  if (job.production_id) {
    const { data: p } = await db.from("productions").select("*, style_profiles(*)").eq("id", job.production_id).single();
    const { data: scenes } = await db.from("scenes").select("*").eq("production_id", job.production_id).order("idx");
    const { data: assets } = await db.from("assets").select("*").or(`production_id.eq.${job.production_id},and(production_id.is.null,source.eq.upload)`);
    // GAP 2/3: produção sem style_id recebe o perfil v2 só se houver UM candidato do mesmo usuário e da mesma referência.
    if (p && !p.style_id && p.reference_id) {
      const { resolveStyleLink } = await import("@/lib/style-link");
      const { data: cands } = await db.from("style_profiles").select("id,user_id,profile,analyses!inner(reference_id,user_id)").eq("user_id", p.user_id).eq("analyses.reference_id", p.reference_id);
      const link = resolveStyleLink(p, cands ?? []);
      out.style_link = { reason: link.reason, style_id: link.styleId, persisted: false };
      if (link.styleId) {
        p.style_profiles = (cands ?? []).find((c: any) => c.id === link.styleId);
        // só grava em produção nova (nunca renderizada); antigas recebem o perfil apenas nesta entrega
        if (!p.output_path) {
          await db.from("productions").update({ style_id: link.styleId }).eq("id", p.id).eq("user_id", p.user_id).is("style_id", null);
          p.style_id = link.styleId;
          out.style_link.persisted = true;
        }
      }
    } else if (p) out.style_link = { reason: p.style_id ? "already_linked" : "no_reference", style_id: p.style_id ?? null, persisted: false };
    out.production = p;
    out.scenes = scenes;
    out.assets = assets;
    // Modo fatiador: vídeo das cenas (separado do vídeo de estilo); cai para a referência de estilo se não houver.
    const srcId = (p?.settings as Record<string, unknown> | null)?.["scenes_reference_id"] ?? p?.reference_id;
    if (typeof srcId === "string") {
      const { data: r } = await db.from("reference_sources").select("id,urls,title").eq("id", srcId).maybeSingle();
      out.source_reference = r;
    }
    const vid = (p?.settings as Record<string, unknown> | null)?.["voice_id"];
    if (typeof vid === "string") {
      const { data: v } = await db.from("voices").select("*").eq("id", vid).maybeSingle();
      out.voice = v;
    }
  }
  const pv = (job as { payload?: Record<string, unknown> }).payload?.["voice_id"];
  if (typeof pv === "string" && !out.voice) {
    const { data: v } = await db.from("voices").select("*").eq("id", pv).maybeSingle();
    out.voice = v;
  }
  if (job.reference_id) {
    const { data: r } = await db.from("reference_sources").select("*").eq("id", job.reference_id).single();
    out.reference = r;
  }
  if (job.analysis_id) {
    const { data: a } = await db.from("analyses").select("id,kind,status").eq("id", job.analysis_id).single();
    out.analysis = a;
  }
  // Chave opcional da ElevenLabs: só vai para o agente do próprio dono quando há voz clonada.
  if (out.voice && userId) {
    const { data: k } = await db.from("user_api_keys").select("api_key").eq("user_id", userId).eq("provider", "elevenlabs").maybeSingle();
    if (k?.api_key) out.elevenlabs_key = k.api_key;
  }
  return out;
}
