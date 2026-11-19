# AI Video Autopilot

Crie uma plataforma de automação inteligente de vídeos com IA



Quero desenvolver uma plataforma completa de automação de criação de vídeos, do zero, com inteligência artificial. O objetivo é que eu possa fornecer um canal do YouTube ou perfil do TikTok como referência, mandar a automação trabalhar e receber vídeos finalizados, sem precisar editar manualmente.



IMPORTANTE: Não quero apenas um protótipo visual ou um painel com botões que não funcionam. Quero um sistema funcional, construído com arquitetura preparada para integrar serviços reais de inteligência artificial, processamento de vídeo e análise de conteúdo.



1. Análise automática de canais e perfis



Crie um módulo no qual eu possa informar:



- Link de um canal do YouTube.

- Link de um vídeo específico do YouTube.

- Link de um perfil ou vídeo do TikTok.

- Links de vários vídeos do mesmo criador.



A inteligência artificial deverá analisar o conteúdo de referência e montar um relatório com:



- Nicho e subnichos.

- Público-alvo provável.

- Temas mais recorrentes.

- Tipos de ganchos utilizados no início dos vídeos.

- Estrutura dos roteiros.

- Duração média dos vídeos.

- Ritmo de edição.

- Quantidade e frequência de cortes.

- Estilo de legendas, fontes, cores e animações.

- Uso de imagens, vídeos de fundo, efeitos sonoros e música.

- Movimentos de câmera, zooms e transições.

- Estrutura narrativa e técnicas de retenção.

- Padrões de títulos, thumbnails e chamadas para ação.

- Diferenças entre os vídeos com melhor e pior desempenho, quando houver dados disponíveis.



Não invente métricas. Utilize apenas informações acessíveis e identifique claramente o que for estimativa.



Ao terminar, gere um perfil de estilo reutilizável, que possa ser salvo e aplicado em novas produções.



2. Análise de vídeos do TikTok



Crie uma ferramenta específica para analisar vídeos curtos.



Ela deverá identificar a estrutura visual e temporal do vídeo, incluindo:



- O que acontece em cada cena.

- Duração aproximada de cada cena.

- Momentos de troca de imagens.

- Sincronização entre fala e legenda.

- Estilo de legendas dinâmicas.

- Efeitos de aproximação e afastamento.

- Transições, animações e sobreposições.

- Ritmo visual e sonoro.

- Gancho inicial e desenvolvimento da história.

- Elementos que tornam o vídeo reconhecível visualmente.



Permita transformar essa análise em um modelo de edição que possa ser reutilizado em vídeos novos.



A automação deve reproduzir características gerais do estilo de referência, sem simplesmente copiar vídeos, roteiros, marcas d'água ou materiais protegidos de terceiros.



3. Geração automática de ideias e roteiros



Depois de analisar o canal, a plataforma deverá sugerir temas alinhados ao nicho identificado.



Para cada tema, deverá gerar:



- Título chamativo.

- Gancho forte para os primeiros segundos.

- Roteiro completo.

- Narração em português brasileiro.

- Divisão do texto em cenas.

- Descrição visual de cada cena.

- Legendas correspondentes.

- Indicações de pausas, efeitos sonoros e mudanças de ritmo.

- Encerramento e chamada para ação, quando apropriado.



Os roteiros devem ser originais, naturais e adequados ao público do canal.



Evite informações inventadas, repetições excessivas e textos genéricos. Para conteúdos factuais, inclua referências para verificação.



4. Geração automática de imagens e vídeos



A plataforma deverá escolher os recursos visuais mais adequados para cada trecho do roteiro.



Ela deverá poder:



- Pesquisar imagens e vídeos em fontes autorizadas.

- Utilizar arquivos que eu enviar.

- Gerar imagens com inteligência artificial.

- Integrar serviços de geração de vídeo quando disponíveis.

- Selecionar imagens de acordo com o significado de cada frase.

- Evitar imagens repetidas em cenas próximas.

- Aplicar movimentos às imagens estáticas.

- Criar sequências visuais coerentes com a narração.



Sempre que possível, a escolha das imagens deverá ser contextual, e não apenas baseada em palavras-chave.



Registre a origem dos materiais e permita verificar suas condições de uso.



5. Narração automática



Implemente um módulo de geração de voz que permita:



- Selecionar vozes em português brasileiro.

- Ajustar velocidade, pausas e expressividade.

- Gerar a narração completa automaticamente.

- Dividir o áudio por cenas.

- Sincronizar as legendas com o áudio.

- Substituir a narração sem reconstruir desnecessariamente o projeto inteiro.



Prepare integrações com serviços como ElevenLabs ou alternativas compatíveis. Não presuma que as APIs sejam gratuitas: mostre os custos e os limites quando forem conhecidos.



6. Editor automático de vídeos



Este é um dos módulos mais importantes.



Crie um editor capaz de montar o vídeo final usando roteiro, narração, imagens, vídeos, legendas e efeitos.



Ele deverá permitir:



- Montagem automática da linha do tempo.

- Cortes sincronizados com a narração.

- Ajuste da duração de cada cena.

- Legendas animadas e sincronizadas.

- Diferentes estilos de tipografia.

- Zooms, panorâmicas e movimentos de câmera.

- Transições e efeitos sonoros.

- Música de fundo com volume adequado.

- Ajuste automático do volume da voz.

- Correção de proporção e enquadramento.

- Aplicação de um modelo visual salvo.

- Pré-visualização antes da exportação.



Ofereça formatos para vídeos verticais 9:16, horizontais 16:9 e quadrados 1:1.



Priorize a qualidade da edição e a coerência entre o que está sendo narrado e o que aparece na tela.



Utilize ferramentas reais de processamento, como FFmpeg, e uma arquitetura que permita integrar outros editores ou serviços.



7. Dois modos de funcionamento



Implemente dois modos independentes.



Modo automático



Eu informo o tema ou o canal de referência, escolho o estilo, defino as configurações e clico em “Iniciar automação”.



A partir daí, o sistema deverá executar as etapas disponíveis:



1. Analisar as referências.

2. Selecionar ou sugerir um tema.

3. Criar o roteiro.

4. Gerar a narração.

5. Selecionar ou gerar as imagens.

6. Montar as cenas.

7. Criar e sincronizar as legendas.

8. Aplicar efeitos e ajustes de áudio.

9. Renderizar o vídeo.

10. Salvar o resultado final e apresentar um relatório.



Quero poder deixar o computador trabalhando enquanto faço outras atividades.



Se ocorrer um erro, a automação deverá registrar o problema, tentar novamente quando for seguro e continuar de onde parou, sem perder todo o trabalho.



Modo assistido



Permita revisar e aprovar cada etapa:



- Tema.

- Roteiro.

- Narração.

- Imagens.

- Divisão das cenas.

- Legendas.

- Edição final.



Eu devo poder alterar qualquer etapa antes de continuar.



8. Painel de controle



Crie uma interface moderna, profissional, intuitiva e em português brasileiro.



O painel deverá conter:



- Dashboard com resumo da produção.

- Cadastro de canais de referência.

- Biblioteca de estilos salvos.

- Analisador de YouTube e TikTok.

- Gerador de ideias e roteiros.

- Editor e pré-visualizador de vídeos.

- Lista de trabalhos em andamento.

- Histórico de vídeos produzidos.

- Biblioteca de arquivos e recursos visuais.

- Configurações de voz e inteligência artificial.

- Configurações de exportação.

- Estimativa de custo por vídeo.

- Logs de erros e atividades.

- Botões para iniciar, pausar, cancelar e retomar tarefas.



Mostre o progresso de cada etapa e deixe claro quando uma tarefa estiver aguardando uma API, um download ou a renderização.



9. Execução no meu computador



Quero que o sistema possa trabalhar com meu computador, e não fique limitado a uma interface web.



Projete a solução para permitir que uma aplicação local execute tarefas demoradas, processe vídeos e salve arquivos no meu disco.



O Lovable poderá ser utilizado para criar a interface e os componentes web. Se for necessário, crie também um backend e um agente local separados, com comunicação segura entre eles.



Use tecnologias adequadas, por exemplo:



- Interface web moderna.

- Backend para gerenciar tarefas e integrações.

- Banco de dados para projetos, configurações e histórico.

- Fila de tarefas para processamento assíncrono.

- FFmpeg para montagem e renderização.

- Armazenamento local dos arquivos finais.

- Integrações com APIs de inteligência artificial.



Escolha a arquitetura mais confiável, documente os requisitos e forneça instruções claras para instalar e executar tudo no Windows.



Não finja que o Lovable consegue acessar diretamente o meu computador sem um agente local devidamente instalado e autorizado.



10. Controle de custos



Quero começar gastando o mínimo possível.



Implemente:



- Preferência por ferramentas gratuitas e de código aberto quando forem adequadas.

- Configuração das chaves de API fora do código-fonte.

- Estimativa de custo antes de iniciar uma produção.

- Limites de gastos por tarefa e por período.

- Avisos antes de utilizar serviços pagos.

- Registro do consumo de cada integração.

- Possibilidade de trocar de provedor.

- Identificação de recursos que exigem assinatura ou créditos.



Não afirme que um serviço é gratuito sem verificar seus limites e suas condições.



11. Qualidade e confiabilidade



Quero um sistema que produza vídeos realmente utilizáveis, não apenas uma demonstração.



Implemente validações para verificar:



- Se o roteiro está completo.

- Se os arquivos de mídia existem.

- Se o áudio foi gerado corretamente.

- Se as legendas estão sincronizadas.

- Se há cenas vazias ou imagens repetidas em excesso.

- Se a duração final está correta.

- Se o arquivo exportado pode ser reproduzido.

- Se existem problemas de proporção, volume ou renderização.



Caso uma etapa falhe, permita corrigi-la e executar novamente apenas o necessário.



12. Entrega do projeto



Desenvolva o sistema em etapas funcionais.



Primeiro, entregue uma versão utilizável com cadastro de referências, análise de estilo, geração de roteiro, narração, seleção de imagens, legendas e renderização de um vídeo completo.



Depois, implemente as análises mais avançadas, a automação em segundo plano e as integrações adicionais.



Não crie botões falsos nem simule resultados como se fossem reais. Quando uma integração ainda não estiver configurada, informe isso claramente e mostre o que precisa ser feito.



Entregue o código, a estrutura do projeto, as instruções de instalação, o arquivo de configuração de exemplo e os testes essenciais.



Objetivo final: quero ter uma automação de produção audiovisual que eu possa comandar com instruções simples, como “analise este canal e produza um vídeo novo seguindo o estilo de edição dele”. O sistema deve executar o máximo possível sozinho, permitir revisão quando eu quiser e salvar os vídeos finalizados no meu computador.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/9ac76baf-2b34-4fa4-a547-906656174d1d).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
