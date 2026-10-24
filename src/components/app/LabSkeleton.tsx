/* eslint-disable @typescript-eslint/no-explicit-any */
const STATUS_TXT: Record<string, string> = { queued: "Na fila do seu PC", waiting_download: "Baixando", running: "Processando", waiting_api: "IA trabalhando", done: "Concluído", failed: "Falhou", paused: "Pausado" };

export function JobProgress({ label, job }: { label: string; job?: any }) {
  if (!job || job.status === "done") return null;
  const pct = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const failed = job.status === "failed";
  return (
    <div className="space-y-1 rounded-md border border-border p-3 text-sm">
      <div className="flex justify-between gap-2">
        <span className="font-medium">{label}</span>
        <span className={failed ? "text-destructive" : "text-primary"}>{failed ? "Falhou" : `${pct}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full transition-all ${failed ? "bg-destructive" : "bg-primary"}`} style={{ width: `${failed ? 100 : pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{failed ? job.error : job.wait_reason || STATUS_TXT[job.status] || job.status}</p>
    </div>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Full skeleton of the reference: timeline of shots, transitions, sound effects and the cloned caption. */
export function LabSkeleton({ report }: { report: any }) {
  const scenes: any[] = report?.scenes ?? [];
  const sfx: any[] = report?.sfx_map ?? [];
  const tr: any[] = report?.transitions_map ?? [];
  const cap = report?.caption_clone;
  const total = Math.max(1, ...scenes.map((s) => Number(s.end_s) || 0), ...sfx.map((s) => Number(s.at_s) || 0));
  if (!scenes.length && !cap) {
    return <p className="text-sm text-muted-foreground">Este kit foi dissecado na versão antiga. Envie o vídeo de novo para gerar o esqueleto completo (legenda clonada, mapa de efeitos e transições).</p>;
  }
  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Esqueleto do vídeo ({fmt(total)})</div>
      <div className="relative h-14 rounded-md bg-muted">
        {scenes.map((s, i) => (
          <div key={i} title={`${s.description} · ${s.motion} · ${s.transition}`} className={`absolute top-0 h-8 border-r border-background ${i % 2 ? "bg-primary/60" : "bg-primary/35"}`} style={{ left: `${(s.start_s / total) * 100}%`, width: `${((s.end_s - s.start_s) / total) * 100}%` }} />
        ))}
        {sfx.map((s, i) => <div key={`f${i}`} title={`${s.kind} em ${s.at_s}s`} className="absolute bottom-1 h-3 w-1 rounded bg-accent-foreground" style={{ left: `${(s.at_s / total) * 100}%` }} />)}
      </div>
      <p className="text-xs text-muted-foreground">Barras = tomadas ({scenes.length}) · traços embaixo = efeitos sonoros ({sfx.length}) · {tr.length} transições mapeadas</p>

      {cap && (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Legenda clonada</div>
          <div className="flex h-24 items-end justify-center rounded-md bg-foreground/90 pb-3">
            <span className="text-xl" style={{ color: cap.text_hex, WebkitTextStroke: `1px ${cap.outline_hex}`, fontWeight: cap.font_weight === "black" ? 900 : cap.font_weight === "bold" ? 700 : 400, textTransform: cap.uppercase ? "uppercase" : "none" }}>
              exemplo <span style={{ color: cap.highlight_hex }}>impacto</span>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{cap.words_per_block} palavras por bloco · {cap.bottom_percent}% do rodapé · animação {cap.animation} · destaque: {cap.highlight_rule}</p>
        </div>
      )}

      <div className="max-h-72 overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground"><tr><th className="py-1">Tempo</th><th>Cena</th><th>Câmera</th><th>Transição</th><th>Legenda</th></tr></thead>
          <tbody>
            {scenes.map((s, i) => (
              <tr key={i} className="border-t border-border align-top">
                <td className="py-1 font-mono">{Number(s.start_s).toFixed(1)}s</td><td>{s.description}</td><td>{s.motion}</td><td>{s.transition}</td><td>{s.caption}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sfx.length > 0 && <p className="text-xs"><b>Efeitos:</b> {sfx.map((s) => `${s.kind} ${Number(s.at_s).toFixed(1)}s`).join(" · ")}</p>}
    </div>
  );
}
