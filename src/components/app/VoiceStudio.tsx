import { useEffect, useState } from "react";
import { toast } from "sonner";
import { pullChannels, pushChannels } from "@/lib/channels";

// VoiceStudio (Edge-TTS gratuito): escolhe voz neural + persona e salva como padrão do canal atual.
const VOICES = [
  { id: "pt-BR-AntonioNeural", label: "Antonio (grave, masculino)" },
  { id: "pt-BR-FranciscaNeural", label: "Francisca (feminina, clara)" },
  { id: "pt-BR-ThalitaMultilingualNeural", label: "Thalita (feminina, jovem)" },
  { id: "pt-BR-MacerioMultilingualNeural", label: "Macério (masculino, narrador)" },
];
const PERSONAS = [
  { id: "misterio", label: "Suspense / Mistério", rate: "-6%", pitch: 0.9, text: "Ninguém sabia o que estava escondido naquela sala, até aquela noite." },
  { id: "epico", label: "Épico", rate: "-2%", pitch: 0.85, text: "E foi ali, no meio do caos, que nasceu uma lenda." },
  { id: "curiosidade", label: "Curiosidades rápidas", rate: "+12%", pitch: 1, text: "Você nunca reparou nesse detalhe, mas ele muda tudo." },
  { id: "historia", label: "Storytelling", rate: "+4%", pitch: 1, text: "Ele tinha tudo para dar errado, mas fez uma escolha que ninguém esperava." },
];

export function VoiceStudio() {
  const [voice, setVoice] = useState(VOICES[0]!.id);
  const [persona, setPersona] = useState(PERSONAS[2]!.id);
  const [rate, setRate] = useState(12);
  const [canal, setCanal] = useState("");
  const [text, setText] = useState(PERSONAS[2]!.text);
  useEffect(() => {
    void pullChannels().finally(() => {
      const c = localStorage.getItem("canal-atual") || ""; setCanal(c);
      try {
        const l = JSON.parse(localStorage.getItem("canal-look") || "{}")[c];
        if (l?.voice) setVoice(l.voice);
        if (l?.rate) setRate(parseInt(String(l.rate)) || 0);
      } catch { /* sem padrão */ }
    });
  }, []);
  const p = PERSONAS.find((x) => x.id === persona)!;
  function choose(id: string) { const x = PERSONAS.find((y) => y.id === id)!; setPersona(id); setRate(parseInt(x.rate)); setText(x.text); }
  function ouvir() {
    if (!("speechSynthesis" in window)) { toast.error("Seu navegador não toca prévia de voz"); return; }
    const u = new SpeechSynthesisUtterance(text);
    const vs = speechSynthesis.getVoices();
    const name = voice.replace("pt-BR-", "").replace(/(Multilingual)?Neural/, "");
    u.voice = vs.find((v) => v.name.includes(name)) ?? vs.find((v) => v.lang === "pt-BR") ?? null;
    u.lang = "pt-BR"; u.rate = 1 + rate / 100; u.pitch = p.pitch;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function salvar() {
    if (!canal) { toast.error("Escolha um canal no Radar ou em Produções primeiro"); return; }
    const all = JSON.parse(localStorage.getItem("canal-look") || "{}");
    all[canal] = { ...(all[canal] ?? {}), voice, rate: `${rate >= 0 ? "+" : ""}${rate}%` };
    localStorage.setItem("canal-look", JSON.stringify(all)); void pushChannels();
    toast.success(`Voz salva como padrão do canal ${canal}`);
  }
  const sel = "rounded-md border border-input bg-background px-3 py-2 text-sm";
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div><h2 className="font-semibold">VoiceStudio</h2><p className="text-sm text-muted-foreground">Vozes neurais grátis. Escolha a persona, ouça a prévia e salve no canal {canal ? <b>{canal}</b> : "atual"}. O robô usa essa voz em todas as produções do canal.</p></div>
      <div className="flex flex-wrap gap-2">
        {PERSONAS.map((x) => <button key={x.id} onClick={() => choose(x.id)} className={`rounded-full border px-3 py-1 text-sm ${persona === x.id ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-accent"}`}>{x.label}</button>)}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <select className={sel} value={voice} onChange={(e) => setVoice(e.target.value)}>{VOICES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</select>
        <label className="flex items-center gap-2 text-sm">Velocidade {rate >= 0 ? "+" : ""}{rate}%<input type="range" min={-20} max={30} value={rate} onChange={(e) => setRate(+e.target.value)} className="flex-1" /></label>
      </div>
      <textarea className={`${sel} w-full`} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <button onClick={ouvir} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent">Ouvir prévia</button>
        <button onClick={salvar} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">Salvar no canal</button>
      </div>
      <p className="text-xs text-muted-foreground">A prévia usa a voz do seu navegador (no Edge soa igual ao vídeo final). A voz real é gerada pelo robô.</p>
    </section>
  );
}
