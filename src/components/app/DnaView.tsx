/* eslint-disable @typescript-eslint/no-explicit-any */
function Sec({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}
const List = ({ items }: { items?: string[] }) =>
  items?.length ? <ul className="list-disc space-y-0.5 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <span className="text-muted-foreground">—</span>;

export function DnaView({ report }: { report: any }) {
  const d = report?.format_dna;
  if (!d) {
    return <p className="text-sm text-muted-foreground">Esta análise foi feita antes do DNA do formato existir. Clique em "Analisar" de novo para gerar a versão completa.</p>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Sec t="Nicho">{d.niche} · {d.subniche}<div className="text-muted-foreground">Público: {d.audience}</div><div className="text-muted-foreground">Promessa: {d.promise}</div></Sec>
      <Sec t={`Gancho (${d.hook?.seconds ?? "?"}s)`}>
        <b>{d.hook?.type}</b> — {d.hook?.first_line_pattern}
        <div className="text-muted-foreground">{d.hook?.why_it_works}</div>
        <List items={d.hook?.templates} />
      </Sec>
      <Sec t="Estrutura do roteiro">
        <ol className="space-y-1">
          {(d.structure ?? []).map((p: any, i: number) => (
            <li key={i}><b>{p.percent}% · {p.part}</b> — {p.purpose}. <span className="text-muted-foreground">{p.how}</span></li>
          ))}
        </ol>
      </Sec>
      <Sec t="Narração">
        {d.narration?.person}, {d.narration?.tone}, ~{d.narration?.words_per_second} palavras/s, frases {d.narration?.sentence_length}
        <div className="text-muted-foreground">{d.narration?.vocabulary}</div>
        <List items={d.narration?.rhetorical_devices} />
      </Sec>
      <Sec t="Retenção"><List items={d.retention} /></Sec>
      <Sec t="Loops abertos"><List items={d.open_loops} /></Sec>
      <Sec t="Edição">
        {d.editing?.cuts_per_min} cortes/min · Zoom: {d.editing?.zoom_usage} · Transições: {d.editing?.transitions} · Imagens de apoio: {d.editing?.broll_ratio} · Sobreposições: {d.editing?.overlays}
      </Sec>
      <Sec t="Legendas e áudio">
        {d.captions?.style}, {d.captions?.words_per_line} palavras/linha, destaque: {d.captions?.emphasis}
        <div className="text-muted-foreground">Música: {d.audio?.music} · Voz: {d.audio?.voice} · Efeitos: {(d.audio?.sfx ?? []).join(", ")}</div>
      </Sec>
      <Sec t="Imagens e onde buscar">
        <ul className="space-y-0.5">{(d.visual_sources ?? []).map((v: any, i: number) => <li key={i}><b>{v.kind}</b> → {v.best_source} <span className="font-mono text-xs text-muted-foreground">{v.example_query}</span></li>)}</ul>
      </Sec>
      <Sec t="Título e CTA">{d.title_pattern}<div className="text-muted-foreground">CTA: {d.cta}</div></Sec>
      <Sec t="Fazer"><List items={d.do_list} /></Sec>
      <Sec t="Evitar"><List items={d.dont_list} /></Sec>
      <Sec t="Ideias de vídeos novos neste formato"><List items={d.new_video_ideas} /></Sec>
    </div>
  );
}
