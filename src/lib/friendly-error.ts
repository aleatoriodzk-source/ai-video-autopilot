/** Turns raw technical errors into a short explanation + what to do, in Portuguese. */
export function friendlyError(raw: string | null | undefined): { title: string; hint: string } | null {
  if (!raw) return null;
  const e = raw.toLowerCase();
  const has = (...w: string[]) => w.some((x) => e.includes(x));
  if (has("orçamento")) return { title: "Limite de gastos atingido", hint: "Aumente o limite ou espere o próximo mês." };
  if (has("402", "not enough credits", "créditos")) return { title: "Créditos da plataforma acabaram", hint: "Salve uma chave do Gemini, ChatGPT ou Claude em Chaves de IA." };
  if (has("nenhuma ia respondeu")) return { title: "Nenhuma IA respondeu", hint: "As IAs estão ocupadas ou as chaves falharam. Teste as chaves em Chaves de IA e tente de novo." };
  if (has("503", "overloaded", "unavailable", "529")) return { title: "A IA está sobrecarregada", hint: "É temporário. Clique em Tentar de novo em alguns minutos." };
  if (has("429", "rate limit", "quota")) return { title: "Limite de uso da IA atingido", hint: "Espere um minuto ou use outra IA em Chaves de IA." };
  if (has("401", "403", "api key", "invalid key", "permission")) return { title: "Chave recusada", hint: "Confira a chave em Chaves de IA ou o token do agente." };
  if (has("yt-dlp", "sign in to confirm", "bot")) return { title: "O YouTube/TikTok bloqueou o download", hint: "Envie o vídeo em MP4 pela página Referências." };
  if (has("ffmpeg", "ffprobe")) return { title: "Erro ao montar o vídeo no PC", hint: "Confira se o FFmpeg está instalado (rode install_windows.bat) e tente de novo." };
  if (has("edge-tts", "piper", "narração")) return { title: "Erro ao gerar a voz", hint: "Confira a internet do PC (a voz Edge precisa dela) e tente de novo." };
  if (has("pixabay", "pexels")) return { title: "Erro ao buscar imagens", hint: "Confira a chave do Pixabay/Pexels no config.json do agente." };
  if (has("ficou parada")) return { title: "A tarefa travou", hint: "Abra o agente no PC (run.bat) e clique em Tentar de novo." };
  if (has("timeout", "timed out", "connection")) return { title: "Falha de conexão", hint: "Confira a internet e tente de novo." };
  return { title: "Ocorreu um erro", hint: "Clique em Tentar de novo. Se repetir, veja os detalhes abaixo." };
}
