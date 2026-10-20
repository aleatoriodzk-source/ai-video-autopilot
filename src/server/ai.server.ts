// Server-only Lovable AI Gateway helpers (raw HTTP, streamed Responses API).
const GATEWAY = "https://ai.gateway.lovable.dev";
export const TEXT_MODEL = "openai/gpt-6-astra";

export class AiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function key() {
  const k = process.env["LOVABLE_API_KEY"];
  if (!k) throw new AiError(401, "LOVABLE_API_KEY não configurada no servidor");
  return k;
}

export type Usage = { input_tokens: number; output_tokens: number; total_tokens: number };

export async function aiJson<T>(opts: {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  images?: string[]; // data: URLs or https URLs
}): Promise<{ data: T; usage: Usage }> {
  // Own Gemini key (free tier) takes priority so platform credits are not consumed.
  if (process.env["GEMINI_API_KEY"]) return geminiJson<T>(opts);
  const content: Record<string, unknown>[] = [{ type: "input_text", text: opts.user }];
  for (const url of opts.images ?? []) content.push({ type: "input_image", image_url: url });
  const res = await fetch(`${GATEWAY}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key(), "X-Lovable-AIG-SDK": "fetch" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      stream: true,
      store: false,
      reasoning: { effort: opts.schemaName === "script" ? "medium" : "low" },
      input: [
        { role: "system", content: opts.system },
        { role: "user", content },
      ],
      text: { format: { type: "json_schema", name: opts.schemaName, schema: opts.schema, strict: true } },
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    throw new AiError(res.status, `IA respondeu ${res.status}: ${t.slice(0, 400)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: Usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.type === "response.output_text.delta") text += ev.delta ?? "";
      else if (ev.type === "response.completed" && ev.response?.usage) usage = ev.response.usage;
      else if (ev.type === "response.failed" || ev.type === "error")
        throw new AiError(502, ev.response?.error?.message ?? ev.message ?? "Falha na IA");
      else if (ev.type === "response.refusal.delta") throw new AiError(422, "A IA recusou a solicitação");
    }
  }
  if (!text.trim()) throw new AiError(422, "A IA não retornou conteúdo");
  return { data: JSON.parse(text) as T, usage };
}

export async function aiImage(prompt: string, aspect: string, model: string): Promise<string> {
  const size = aspect === "9:16" ? "1024x1536" : aspect === "16:9" ? "1536x1024" : "1024x1024";
  const res = await fetch(`${GATEWAY}/v1/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size }),
  });
  if (!res.ok) throw new AiError(res.status, `Imagem IA ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new AiError(422, "Nenhuma imagem retornada");
  return b64;
}
