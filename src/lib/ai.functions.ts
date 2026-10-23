import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runChannelIdeas, runIdeas, runRewriteScene, runScript } from "@/server/tasks.server";

export const channelIdeas = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { referenceId: string; wish?: string }) => ({ referenceId: String(i.referenceId), wish: String(i.wish ?? "").slice(0, 300) }))
  .handler(async ({ data, context }) => {
    try {
      const ideas = await runChannelIdeas(context.supabase, context.userId, data.referenceId, data.wish);
      return { ok: true as const, ideas: ideas.map((x) => ({ title: String(x.title), hook: String(x.hook), angle: String(x.angle), why_fits: String(x.why_fits), factual: !!x.factual })) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });


export const generateIdeas = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { productionId: string }) => i)
  .handler(async ({ data, context }) => {
    try {
      return { ok: true as const, ideas: JSON.parse(JSON.stringify(await runIdeas(context.supabase, context.userId, data.productionId, null))) as Record<string, string | boolean>[] };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

export const generateScript = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { productionId: string; topic?: string }) => i)
  .handler(async ({ data, context }) => {
    try {
      const s = await runScript(context.supabase, context.userId, data.productionId, null, data.topic);
      return { ok: true as const, title: s.title };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

export const rewriteScene = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { sceneId: string; instruction?: string }) => ({ sceneId: String(i.sceneId), instruction: String(i.instruction ?? "").slice(0, 500) }))
  .handler(async ({ data, context }) => {
    try {
      await runRewriteScene(context.supabase, context.userId, data.sceneId, data.instruction);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
