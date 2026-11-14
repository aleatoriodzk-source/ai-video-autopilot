/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RadarItem = { id: string; title: string; views: number; url: string; thumb: string };

// "8,7 mil visualizações" / "1,2 mi de visualizações" / "532 visualizações" -> número
export function parseViews(t: string): number {
  const m = t.match(/(\d[\d.,]*)\s*(mil|mi|bi|k|m|b)?\w*\s*(de\s+)?(visualiza|views)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]!.replace(/\./g, "").replace(",", "."));
  const u = (m[2] ?? "").toLowerCase();
  return Math.round(n * (u === "mil" || u === "k" ? 1e3 : u === "mi" || u === "m" ? 1e6 : u === "bi" || u === "b" ? 1e9 : 1));
}

export function extractShorts(html: string): RadarItem[] {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const out: RadarItem[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, any>;
    const s = r["shortsLockupViewModel"];
    if (s) {
      const id = s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId as string | undefined;
      const acc = String(s.accessibilityText ?? "");
      const title = acc.split(/,\s*[\d.,]+\s*(mil|mi|bi)?\s*(de\s+)?visualiza/i)[0]!.trim();
      if (id) out.push({ id, title, views: parseViews(acc), url: `https://www.youtube.com/shorts/${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
    }
    Object.values(r).forEach(walk);
  };
  walk(JSON.parse(m[1]!));
  return out;
}

// Radar V8: Shorts desta semana do nicho, ordenados por visualizações.
export const radarSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { q: string }) => ({ q: String(i?.q ?? "").trim().slice(0, 100) }))
  .handler(async ({ data }) => {
    if (!data.q) return { items: [] as RadarItem[], error: "Digite um nicho" };
    try {
      const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(data.q + " #shorts")}&sp=EgIIAw%253D%253D`, {
        headers: { "Accept-Language": "pt-BR,pt;q=0.9", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", Cookie: "CONSENT=YES+1" },
      });
      const seen = new Set<string>();
      const items = extractShorts(await r.text()).filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((a, b) => b.views - a.views).slice(0, 24);
      return { items, error: items.length ? null : "O YouTube não devolveu resultados agora; tente outro termo" };
    } catch (e) {
      return { items: [] as RadarItem[], error: `Falha ao consultar o YouTube: ${(e as Error).message}` };
    }
  });

export type RadarInsight = {
  thumb_patterns: string[];
  title_patterns: string[];
  titles: { title: string; score: number; trigger: string }[];
  pinned_comment: string;
  hashtags: string[];
};

const S = { type: "string" } as const;
const N = { type: "number" } as const;
const obj = (p: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(p), properties: p });
const insightSchema = obj({
  thumb_patterns: { type: "array", items: S },
  title_patterns: { type: "array", items: S },
  titles: { type: "array", items: obj({ title: S, score: N, trigger: S }) },
  pinned_comment: S,
  hashtags: { type: "array", items: S },
});

async function toDataUrl(u: string): Promise<string | null> {
  try {
    const r = await fetch(u);
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(s)}`;
  } catch { return null; }
}

// V9: lê capas e títulos dos virais do Radar e devolve o padrão + títulos A/B + comentário fixado.
export const radarInsight = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: { niche: string; items: { title: string; views: number; thumb: string }[] }) => ({
    niche: String(i?.niche ?? "").slice(0, 100),
    items: (Array.isArray(i?.items) ? i.items : []).slice(0, 6).map((x) => ({ title: String(x.title).slice(0, 200), views: Number(x.views) || 0, thumb: String(x.thumb).startsWith("https://i.ytimg.com/") ? String(x.thumb) : "" })),
  }))
  .handler(async ({ data, context }) => {
    try {
      if (!data.items.length) throw new Error("Busque os virais primeiro");
      const imgs = (await Promise.all(data.items.map((x) => (x.thumb ? toDataUrl(x.thumb) : null)))).filter(Boolean) as string[];
      const { aiJson } = await import("@/server/ai.server");
      const { loadKeys } = await import("@/server/tasks.server");
      const keys = await loadKeys(context.userId);
      const r = await aiJson<RadarInsight>({
        keys,
        schemaName: "radar_insight",
        schema: insightSchema,
        images: imgs,
        system: "Você é estrategista de canais dark virais (sem rosto). Responda em PT-BR, concreto e curto.",
        user:
          `Nicho: "${data.niche}". Estes são os Shorts mais vistos da semana (as imagens são as capas na mesma ordem):\n` +
          data.items.map((x, k) => `${k + 1}. "${x.title}" — ${x.views} views`).join("\n") +
          `\nTarefas: thumb_patterns = 3 a 5 padrões visuais das capas (contraste, cores, texto na capa, close, expressão) para copiar. title_patterns = 3 a 5 padrões dos títulos (gatilhos, tamanho, números, nomes). titles = 3 títulos NOVOS para um vídeo original do nicho, com nota 0-100 de curiosidade e o gatilho usado (mistério, contradição, urgência, número). pinned_comment = um comentário para fixar que provoca respostas. hashtags = 5 hashtags.`,
      });
      return { ok: true as const, insight: JSON.parse(JSON.stringify(r.data)) as RadarInsight };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
