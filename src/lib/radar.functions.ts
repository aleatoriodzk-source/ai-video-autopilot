/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type RadarItem = { id: string; title: string; views: number; url: string; thumb: string };

// "8,7 mil visualizações" / "1,2 mi de visualizações" / "532 visualizações" -> número
export function parseViews(t: string): number {
  const m = t.match(/([\d.,]+)\s*(mil|mi|bi|k|m|b)?\w*\s*(de\s+)?(visualiza|views)/i);
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
