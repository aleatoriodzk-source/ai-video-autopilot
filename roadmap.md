# Roadmap

## Feito
- [x] Aba "Chaves de IA" (Gemini, ChatGPT, Claude) com teste, IA padrão e escolha por produção
- [x] Novas tentativas automáticas quando a IA dá 503/429 e troca para a próxima IA

## Próximos (em ordem)
1. [x] Fila: mensagens claras por etapa, reiniciar só a etapa que falhou, evitar loops
2. [x] Duração garantida pelo áudio final (não entregar 39s quando pediu 60s)
3. [x] Tela de roteiro completo (gancho, desenvolvimento, clímax, CTA, fontes) + regenerar uma cena
4. [x] Mídia: filtro pelo assunto + IA confere a imagem (até 4 por cena)
5. [x] Novas fontes: Wikimedia, Openverse, NASA, Internet Archive; acervo próprio (aba Acervo + escolha no editor + agente usa o acervo)
6. [x] Análise profunda: transcrição, hook, estrutura, ritmo, legendas, áudio → DNA de Nicho e Estilo
7. [x] Análise de canal comparando vários vídeos
8. [x] Editor estilo CapCut (timeline, troca de mídia por cena, legendas palavra por palavra)
9. [x] Automático: transições reais no vídeo, efeitos sonoros gerados pelo programa, música livre online por clima (clima escolhido sozinho)
9b. [ ] Prévia da voz antes de gerar
10. [x] Versões do vídeo e renderização mais rápida
11. [~] ZIP novo gerado com tudo; falta o Júlio trocar os arquivos no PC. Agente do PC: gerar ZIP novo e trocar os arquivos no PC (deixado para o final, a pedido do Júlio)
- [x] Mídia real por assunto: trechos do YouTube + imagens da web para cultura pop/filmes/famosos; IA de conferência menos rígida; roteiro usa nomes próprios na busca
- [x] Banco de Vozes: isolar voz (Demucs) + medir ritmo/pausas + clonar (F5-TTS/XTTS no PC via install_voice_clone.bat)
- [x] Modo fatiador: IA assiste as tomadas do vídeo de referência e monta o roteiro com elas
- [x] Contas vinculadas (cookies.txt YouTube/TikTok) + Explorador de busca no YouTube
- [x] Narração sem pausas, fatiador fiel à IA, faxina de 24h
- [x] Legenda sincronizada com a fala real (ignora pausas)
- [ ] Próximos: efeitos sonoros reais, voz clonada mais rápida, sugestões de temas após análise de canal
- [ ] Testar no PC do Júlio (depende de trocar os arquivos do agente)

## Lista de correções (Out/2026)
- [x] Mínimo 60s em vídeos curtos
- [x] Legenda na zona segura inferior
- [x] Análise de canal: 5 vídeos mais recentes + link /videos
- [x] Excluir referências + atualização automática + selo "Analisado"
- [x] Campo de tema no Laboratório (sem janelinha do navegador)
- [x] Narração reaproveitada se o agente reiniciar
- [x] Smart crop (personagem centralizado) e personagem bater com a fala
- [x] Ritmo de cortes igual ao da referência; trilha e efeitos ligados por padrão
- [x] Laboratório: música isolada (sem voz), zoom/pan/flash medidos, kit aplica o movimento
- [x] Escolher voz, velocidade, legenda, música e efeitos ao criar vídeo (Laboratório e Referências)
- [x] Efeitos sonoros reais (CC0) no lugar do chiado; imagens de fundo branco ficam sobre fundo escuro
- [x] Roteiro com uma história só, linear e com nomes reais

## Visual e estilo (Out/2026) — ZIP só no final, a pedido do Júlio
- [x] Roteiro curto: 165-195 palavras (nunca < 60s)
- [x] Legenda Karaokê (palavra falada acende) e Caixa escura
- [x] Proporção por cena (16:9, 1:1, 3:4, tela cheia) aprendida da referência, sempre com fundo desfocado (vídeos e fotos)
- [x] TikTok: link curto, sem marca d'água, plano B se o yt-dlp falhar
- [x] Gerar ZIP final (efeitos ligados por padrão, 6 sons reais embutidos, verificação do FFmpeg)
- [ ] Voz clonada na nuvem (deixada por último)
