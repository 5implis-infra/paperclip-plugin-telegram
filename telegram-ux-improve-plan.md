# Telegram Improve Plan

## Objetivo
Criar um plano de melhorias de UX para o plugin Telegram.

## Regras
- 'refId' são sessões para agrupar assuntos (ex.: `COMANDOS`, `PENDENCIAS`).
- Pendencias tem IDs numericos sequenciais (1, 2, 3...).
- Pendencias sao itens em aberto para definir/decidir (nao e lista de implementacao).


## refId: #MAPA ATUAL

### Objetivo
Listar os tipos de mensagens que o plugin envia para o Telegram.

### Tipos de mensagens
O plugin hoje envia para o Telegram estes tipos de mensagens (pensando só no que “aparece no chat”)


1. Notificações de issue
- issue.created (issue criada)
- issue.updated quando vira done (issue concluída)
- issue.updated quando muda assignee (atribuída a alguém) (se habilitado)
2. Notificações de approval
- approval.created (pedido de aprovação)
- Normalmente vem com botões inline tipo aprovar/rejeitar (dependendo do fluxo)
3. Notificações de agentes (runs)
- agent.run.failed (erro do agente) (essa é a “❌ Agent Error”)
- agent.run.started (run começou) (se habilitado)
- agent.run.finished (run terminou) (se habilitado)
4. Digest
- “Daily Digest / Digest” (job agendado): resumo do dia (tarefas criadas/concluídas, agents ativos, etc.)
5. Escalação para humano
- Mensagens geradas quando um agente chama o tool escalate_to_human (inclui botões tipo Reply/Override/Dismiss e às vezes “Send Suggested Reply”)
6. Mensagens de “sessão de agente” (ACP/native)
- Confirmações do /acp spawn, /acp status, /acp cancel, /acp close
- Outputs do agente dentro do tópico (mensagens com label tipo [CEO] ...), e o plugin registra mapping dessas mensagens para permitir reply continuar a conversa
7. Mensagens de comandos
- Respostas dos comandos /status, /issues, /agents, /help, /connect, /topics, /connect_topic, /approve, /commands, etc.
8. Mensagens “proativas” / watches
- Sugestões/alertas enviados por watches registrados (via register_watch) (tipo “ei, observei X, sugiro Y”)


### Comandos (built-in)  

 1. /help: lista comandos.  
 2. /status: mostra status da empresa (agents/issues).  
 3. /issues [filtro]: lista issues abertas (opcional filtrar por projeto).  
 4. /agents: lista agents e status.  
 5. /create <titulo>: cria uma issue/tarefa (tenta atribuir ao CEO).  
 6. /approve <approval-id>: aprova uma solicitação pendente.  
 7. /connect <company-name>: vincula este chat a uma company no Paperclip.  
 8. /connect_topic <project-name> [topic-id]: mapeia projeto para um tópico (forum).  
 9. /topics [list|remove|clear]: gerencia mapeamentos de tópicos.  
10. /acp [spawn|status|cancel|close]: gerencia sessões de agente no tópico.  
11. /commands [list|import|run|delete]: gerencia comandos customizados (workflows).  
12. /<custom>: comandos adicionados via /commands import.


### Mensagens livres (sem /...)  

1. Em tópicos (threads): se houver sessão ativa/mapeamento, a mensagem é roteada para o agente (routeMessageToAgent).  
2. Como resposta a uma mensagem do bot: se enableInbound estiver ligado, roteia para uma escalação (escalation) ou vira comentário em issue (dependendo do mapping salvo).


## refId: COMANDOS

### Objetivo
Definir comportamento e UX dos comandos do bot no Telegram.

### Diretrizes registradas
1. Implementar autocomplete nivel 1 para comandos no Telegram: o usuario digita `/` e o Telegram sugere os comandos disponiveis.
2. O autocomplete nivel 1 nao deve listar `/approve` nem `/connect_topic`.

### Comandos e regras (alto nivel)
- `/help`: ok
- `/status`:
  - a. se estiver no topico geral: fica como e hoje (nao muda)
  - b. se estiver num topico de projeto: mostra como e hoje, mas restrito ao projeto do topico
  - c. se estiver num topico de "spawn"/sessao: mostra status relativo a sessao:
    - sessao: sessionId, transport (native/acp), status (active/closed), spawnedAt, lastActivityAt
    - topico: chatId e threadId, com link/card para abrir o topico (se disponivel)
    - agente (se houver): agentDisplayName/agentId e status
    - runs: currentRunId (se houver) + status, e ultimas N (ex.: 3) runs com timestamp + resultado
    - issues correlacionadas (native): ultima issueId/identifier usada para wake + link (se houver publicUrl)
    - atalhos: botoes para View Agent / View Run / Open Issue / Close session / Cancel (se aplicavel)
- `/issues`: mesmo contexto de `/status` (a e b)
- `/agents`: sempre mostra todos os agentes (independente de projeto/topico)
- `/create`: adicionar suporte para informar agente:
  - sintaxe: `/create @agenteId texto livre...`
  - titulo: primeira frase do texto
  - descricao: texto sem o titulo
  - se nao informar `@agenteId`: retornar lista de agentes para selecionar (mesmo UX definido na refId `ACP`)
- `/approve`:
  - digitado manualmente: responder com mensagem do tipo "aprovar o que?" (orientando usar o botao)
  - permitido via callback e via reply na mensagem de approval com `/approve` + mensagem (opcional)
- `/connect`: funciona como o `/connect_topic` atual (mapeia projeto -> topico)
- `/connect_topic`: deixa de existir e deve responder como comando desconhecido
- `/topics`: ok
- `/acp`: abrir sessao dedicada
- `/commands`: ok
- `/custom`: ok

## refId: TOPICOS

### Objetivo
Definir o modelo de topicos/threads no Telegram e como isso afeta comandos, mapeamentos e roteamento.

### Definicoes/decisoes registradas
1. `topicRouting` ("Route project-linked notifications to Telegram forum topics mapped with /connect_topic"):
   - quando ligado, tenta rotear notificacoes vinculadas a projeto para topicos mapeados via `/connect_topic`.
2. Eventos com `overrideTopicId` nao sao afetados pelo `topicRouting`/mapeamento projeto->topico.
   - exemplos atuais: `approval.created` (approvalsTopicId), `agent.run.failed` (errorsTopicId), `digest` (digestTopicId).
3. Topicos criados por `spawn` (sessao com agente / ACP) sao tratados como "overrides".
   - como linkar outros eventos a esse topico sera definido na refId `/acp`.

## refId: BOTOES

### Objetivo
Definir padroes de botoes (inline/callback) e acoes no Telegram.

### O que existe hoje (confirmado)
1. Links (url):
   - `Open <ISSUE_ID> ↗` (quando existe publicUrl e issuePrefix)
   - `View Run ↗`
   - `View Agent ↗`
   - `Open Dashboard ↗` (no `/status`, quando existe publicUrl)
2. Approvals (callback):
   - `Approve` / `Reject` (approval notify)
3. Escalation (callback):
   - `Send Suggested Reply` (se existir suggestedReply)
   - `Reply` / `Override` / `Dismiss`
   - Observacao: hoje `Reply` e `Override` so mudam o texto/instrucao da mensagem (na pratica, ambos esperam reply do usuario).
   - `suggestedReply` e fornecido pelo agente no `escalate_to_human` e vai junto na notificacao.
4. ACP handoff (callback):
   - `Approve` / `Reject` quando um agente pede handoff com aprovacao.

### Nova definicao
1. Adicionar botao `Abrir/Criar Sessao` em mensagens de `agent run`.
2. A acao do botao deve:
   - criar uma sessao generica
   - criar um topico no Telegram
   - vincular sessao <-> topico
   - apos criar o topico, enviar um "card" com link para o usuario abrir/ir para o topico
3. Sessao e generica (nao 1:1 com agentId ou runId):
   - se a sessao tiver topico, mensagens respondidas nela vao sempre para o topico
   - agent/run sao metadados opcionais da sessao (quando existirem)
4. Como vincular novas runs e eventos ao topico/sessao criado pelo botao fica para a refId `ACP`.

## refId: ACP

### Objetivo
Definir como sessoes de agente funcionam via `/acp` e como elas se conectam a topicos.

### Definicoes/decisoes registradas
1. `/acp` sem argumentos: retorna lista de subcomandos.
2. Subcomandos continuam os mesmos: `spawn`, `status`, `cancel`, `close`.
3. `/acp spawn` cria `sessao + topico` (mesmo fluxo do botao `Abrir/Criar Sessao`) e vincula os 2.
4. Sessoes iniciadas pelo Telegram sempre tem topico proprio e so sao criadas por:
   - `/acp spawn`
   - botao `Criar Sessao`/`Abrir/Criar Sessao` em callbacks
5. Sessoes indiretas (handoff/discuss/escalation) ficam como estao: usam o `threadId`/contexto existente e callbacks continuam no mesmo thread.
6. Correlacao de eventos de run com uma sessao/topico (alto nivel):
   - native: `issueId -> sessionId -> dados Telegram`
   - acp: `sessionId -> dados Telegram` (sem precisar "passar dados" para fora)
7. `/acp spawn` sem args: retorna lista de agentes para selecionar:
   - default: ativos, ordem alfabetica
   - botao `Ver todos`: lista completa (ativos primeiro, depois inativos; ambos em ordem alfabetica)
   - sempre paginado: 8 itens por pagina
   - item: `Agent Name` truncado + icone pequeno de status (`✅` ativo, `❌` inativo)
   - clicar no item executa o spawn (mesmo fluxo do botao `Criar Sessao`)
8. Sempre que um fluxo precisar criar topico, deve:
   - verificar se o chat e forum
   - se nao for forum: responder erro amigavel e abortar todo o processo (sem criar sessao, sem persistir state, sem disparar eventos)

## refId: PENDENCIAS

### Lista de pendencias
\(sem pendencias no momento\)
