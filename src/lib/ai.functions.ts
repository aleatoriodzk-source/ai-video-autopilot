import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { runIdeas, runScript } from "@/server/tasks.server";

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
