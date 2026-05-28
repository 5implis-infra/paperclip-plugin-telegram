# Telegram UX Improve — Plano de Implementação

Derivado de `telegram-ux-improve-plan.md`. Cada etapa é ordenada por dependência (menos dependente primeiro).

---

## ETAPA 1 — Mudanças simples e independentes

Sem dependências entre si ou com outras etapas. Podem ser feitas em qualquer ordem ou em paralelo.

---

### 1.1 — Autocomplete nível 1: filtrar menu de comandos

**Arquivo:** `src/commands.ts`, `src/worker.ts`

**Contexto:** O array `BOT_COMMANDS` tem 11 comandos, incluindo `/approve` e `/connect_topic`. O `setMyCommands()` recebe esse array inteiro. O requisito é que o menu de sugestão do Telegram (ao digitar `/`) **não liste** `/approve` nem `/connect_topic`.

**Estratégia:**
- Manter `BOT_COMMANDS` completo — é usado pelo `/help` e pelo roteamento interno.
- Criar um segundo array `BOT_COMMANDS_MENU` (ou filtrar inline) excluindo `approve` e `connect_topic`, e passar **apenas esse** para `setMyCommands()`.
- Nenhuma mudança no roteamento, no `/help` nem em nenhum fluxo de runtime.

---

### 1.2 — `/connect_topic` deprecated

**Arquivo:** `src/commands.ts`

**Contexto:** `/connect_topic` é substituído pelo novo `/connect` (Etapa 5). Deve parar de funcionar e responder como "comando desconhecido".

**Estratégia:**
- Remover `connect_topic` do array `BOT_COMMANDS` (desaparece do `/help` e do menu).
- Remover o `case "connect_topic"` do `switch` em `handleCommand()` — a chamada cai no `default` que já responde "Unknown command: /connect\_topic. Try /help".
- A função `handleConnectTopic()` é mantida (será reaproveitada internamente pelo novo `/connect` na Etapa 5).

---

### 1.3 — `/approve` sem args: mensagem orientativa

**Arquivo:** `src/commands.ts` — `handleApprove()`

**Contexto:** Hoje, `/approve` sem ID responde "Usage: /approve \<approval-id\>". O requisito é responder orientando o usuário a usar o botão da notificação.

**Estratégia:**
- No guard `if (!approvalId.trim())`, substituir a mensagem atual por:
  > "Para aprovar, use o botão **Approve** na mensagem de pedido de aprovação, ou responda diretamente a ela com `/approve`."
- O fluxo com ID explícito (via callback ou reply) não muda.

---

### 1.4 — `createForumTopic` na Telegram API

**Arquivo:** `src/telegram-api.ts`

**Contexto:** Hoje o plugin usa tópicos existentes, mas nunca cria um programaticamente. Isso será necessário nas Etapas 2 e 4.

**Estratégia:**
- Adicionar função `createForumTopic(ctx, token, chatId, name, iconEmojiId?)`:
  - Chama `POST /bot{token}/createForumTopic` da Bot API do Telegram.
  - Retorna `{ messageThreadId: number, name: string }`.
  - Trata erros conhecidos (chat não é forum, sem permissão de admin) com mensagens específicas.
- Esta função **não é chamada** nesta etapa — apenas adicionada à API layer para uso posterior.

---

## ETAPA 2 — Infraestrutura de sessão genérica + tópico

Depende de 1.4. Dependências internas: 2.1 antes de 2.4; 2.2 antes de 2.3 e 2.4.

---

### 2.1 — Helper `checkForumOrError`

**Arquivo:** `src/telegram-api.ts`

**Contexto:** O requisito (refId: ACP, item 8) exige que todo fluxo que cria tópico verifique se o chat é forum antes de qualquer ação. Se não for, deve responder erro amigável e **abortar sem persistir state nem disparar eventos**.

**Estratégia:**
- Criar função `checkForumOrError(ctx, token, chatId, messageThreadId?)`:
  - Chama `isForum(ctx, token, chatId)` (já existe).
  - Se não for forum: envia mensagem de erro amigável no chat (e no thread se disponível) e retorna `false`.
  - Se for forum: retorna `true`.
- Todo ponto de entrada que cria tópico chama isso **antes** de qualquer outra ação e retorna imediatamente se `false`.
- Garantia: nenhum estado é persistido antes da verificação ser feita.

---

### 2.2 — Extensão do tipo `ChatSession`

**Arquivo:** `src/acp-bridge.ts`

**Contexto:** `ChatSession` hoje tem `agentId` e `agentName` obrigatórios e não referencia explicitamente o tópico (o tópico está codificado na storage key `sessions_${chatId}_${threadId}`). O novo modelo exige sessões genéricas onde o agente é opcional e o tópico é metadata da sessão.

**Estratégia:**
- Tornar `agentId` e `agentName` opcionais no tipo `ChatSession`.
- Adicionar campos opcionais:
  - `topicId?: number` — o threadId do tópico vinculado a esta sessão
  - `sourceRunId?: string` — runId que originou a sessão (quando criada via botão de run)
  - `sourceAgentId?: string` — agentId que originou a sessão
  - `sourceEventType?: "agent.run.failed" | "agent.run.started" | "agent.run.finished"` — tipo do evento que originou
- Adicionar índice inverso: ao salvar uma sessão, persistir também `session_idx_${sessionId}` → `{ chatId, topicId }`. Isso permite que callbacks (que só conhecem o sessionId) encontrem o chat/tópico correto.
- `getSessions()` e `saveSessions()` continuam funcionando com a storage key existente — as mudanças são aditivas (campos opcionais).

---

### 2.3 — Correlação `issueId → sessionId`

**Arquivo:** `src/acp-bridge.ts` — `wakeAgentWithIssue()`

**Contexto:** O requisito (refId: ACP, item 6) define que para transport native a correlação é `issueId → sessionId → dados Telegram`. Hoje `wakeAgentWithIssue()` cria a issue e retorna o `issueId`, mas não salva esse mapeamento. Sem ele, futuros eventos de run (`agent.run.started/finished`) não conseguem ser roteados ao tópico correto da sessão.

**Estratégia:**
- Adicionar parâmetro opcional `sessionId?: string` em `wakeAgentWithIssue()`.
- Quando `sessionId` é fornecido, persistir: `issue_session_${issueId}` → `{ sessionId, chatId, threadId }`.
- O `worker.ts`, ao receber eventos de run com `issueId` no payload, faz lookup nesse estado para descobrir o tópico destino.
- Os callers existentes não passam `sessionId` — o campo é opcional e não muda nenhum comportamento atual.

---

### 2.4 — Função `createSessionWithTopic()`

**Arquivo:** `src/acp-bridge.ts`

**Contexto:** Função central que encapsula o fluxo "criar tópico + criar sessão + vincular os dois". Será chamada tanto pelo botão "Abrir/Criar Sessão" (Etapa 4) quanto por `/acp spawn` sem agente (Etapa 3.2).

**Estratégia:**

```
createSessionWithTopic(ctx, token, chatId, companyId, opts)
  opts: { sourceRunId?, sourceAgentId?, sourceEventType?, topicName? }
```

Fluxo interno (nenhuma persistência acontece antes do passo 3):

1. Chamar `checkForumOrError()` (de 2.1). Se não for forum → retornar erro, abortar.
2. Chamar `createForumTopic()` (de 1.4) com nome derivado do contexto:
   - Se `sourceRunId`: "Run \<runId truncado\>"
   - Caso contrário: "Agent Session"
3. Criar `ChatSession` genérico (sem `agentId`), preenchendo `topicId` com o `messageThreadId` recém-criado e os campos `source*` opcionais.
4. Persistir sessão em `sessions_${chatId}_${newTopicId}`.
5. Persistir índice inverso `session_idx_${sessionId}` → `{ chatId, topicId }` (de 2.2).
6. Retornar `{ sessionId, topicId }`.
7. Enviar mensagem no **chat original** (não no tópico) com card:
   > "🗂 Sessão criada. Abra o tópico para interagir: [Session #X](link)"
   - Link formato: `https://t.me/c/<chatId sem -100>/<topicId>` para grupos privados.

**Garantia de atomicidade:** se `createForumTopic()` falhar, nenhum estado é escrito. Se a persistência da sessão falhar após o tópico criado, logar o erro — o tópico existirá vazio, mas sem state órfão com consequências operacionais.

**Depende de:** 1.4, 2.1, 2.2.

---

## ETAPA 3 — Melhorias em comandos existentes

Depende de Etapa 2. Dependência interna: 3.1 antes de 3.2 e 3.3.

---

### 3.1 — Agent picker paginado (componente compartilhado)

**Arquivo:** `src/acp-bridge.ts` (nova função `sendAgentPickerPage()`)

**Contexto:** Tanto `/acp spawn` sem args quanto `/create` sem `@agente` precisam do mesmo componente UX: lista paginada de agentes com inline keyboard. Centralizar evita duplicação.

**Estratégia:**

```
sendAgentPickerPage(ctx, token, chatId, companyId, opts)
  opts: { page, showAll, callbackPrefix, messageThreadId? }
```

- Busca agentes via `ctx.agents.list({ companyId })`.
- Padrão (`showAll: false`): apenas `status === "active"`, ordenado alfabeticamente.
- Com `showAll: true`: ativos primeiro (alfabético), depois inativos (alfabético).
- Paginação: 8 agentes por página.
- Cada botão de agente: `"✅ Nome"` (ativo) ou `"❌ Nome"` (inativo), truncado para caber. `callback_data: "${callbackPrefix}_sel_${agentId}"`.
- Linha de navegação: `"← Anterior"` / `"Próxima →"` (quando aplicável) + `"Ver todos"` (quando `showAll: false` e há inativos).
  - `callback_data` de navegação: `"${callbackPrefix}_page_${page}"`, `"${callbackPrefix}_all_${page}"`.
- O `callbackPrefix` diferencia o contexto de uso (`acp_spawn` vs. `create_issue`) para que o handler em `worker.ts` saiba o que executar após a seleção.

---

### 3.2 — `/acp spawn` sem args → agent picker

**Arquivo:** `src/acp-bridge.ts` — `handleAcpSpawn()`

**O que muda:** Hoje retorna "Usage: /acp spawn \<agent-name\>". O requisito é mostrar o agent picker paginado.

**Estratégia:**
- No guard `if (!agentName.trim())`:
  1. Verificar forum via `checkForumOrError()` (de 2.1). Se não for forum → erro, abortar.
  2. Chamar `sendAgentPickerPage()` (de 3.1) com `callbackPrefix = "acp_spawn"`.
- No handler de callbacks do `worker.ts`, adicionar cases para:
  - `acp_spawn_sel_${agentId}`: executa spawn com o agente selecionado (chama `handleAcpSpawn()` com `agentName` já resolvido).
  - `acp_spawn_page_${page}`: edita a mensagem do picker com a página nova.
  - `acp_spawn_all_${page}`: edita a mensagem com `showAll: true`.

**Depende de:** 2.1, 2.4, 3.1.

---

### 3.3 — `/create @agente` com agent picker

**Arquivo:** `src/commands.ts` — `handleCreate()`

**O que muda:** Sintaxe atual: `/create <título>`, sempre atribui ao CEO. Nova sintaxe opcional: `/create @agente texto...` (atribui ao agente especificado) ou `/create texto...` sem `@` (mostra picker de agentes).

**Estratégia:**

Parse dos args no início de `handleCreate()`:
- Se o primeiro token começa com `@`: extrair `agentName = token.slice(1)`, restante é o texto do prompt.
- Se não começa com `@`: texto inteiro é o prompt, `agentName = undefined`.

Quando `agentName` está presente:
- Resolver agente via `resolveAgentByName()` (já existe em `acp-bridge.ts`).
- Se não encontrado: responder com lista de nomes disponíveis.
- Se encontrado: usar esse agente ao invés do CEO.

Extração de título e descrição (quando agente especificado):
- `title` = primeira frase do texto (até `.`, `!`, `?`, `\n` ou 120 chars — o que vier primeiro).
- `description` = restante do texto (se houver).

Quando `agentName` é `undefined` (sem `@`):
- Salvar o texto em state temporário: `create_pending_${chatId}_${userId}` → `{ text, messageThreadId }`.
- Chamar `sendAgentPickerPage()` (de 3.1) com `callbackPrefix = "create_issue"`.

No handler de callbacks do `worker.ts`, adicionar:
- `create_issue_sel_${agentId}`: lê state temporário, cria issue com agente selecionado, limpa state temporário.
- `create_issue_page_*` / `create_issue_all_*`: navegação do picker (mesmo padrão de 3.2).

**Depende de:** 3.1.

---

### 3.4 — `/status` context-aware (3 variantes)

**Arquivo:** `src/commands.ts` — `handleStatus()`

**O que muda:** Hoje sempre mostra status global. O requisito define 3 contextos por tipo de tópico.

**Estratégia:**

No início de `handleStatus()`, detectar o contexto antes de buscar dados:

**Branch a — Tópico geral (ou sem tópico):**
Comportamento atual. Nenhuma mudança.

**Branch b — Tópico de projeto:**
Condição: `messageThreadId` existe **e** há entrada no topic-map para esse `threadId`.
- Buscar `projectId` do mapeamento.
- Filtrar `ctx.issues.list()` pelo `projectId`.
- Header: "📊 Status — *Nome do Projeto*".
- Botão "Open Dashboard ↗" mantido (se disponível).

**Branch c — Tópico de sessão:**
Condição: `getSessions(ctx, chatId, messageThreadId)` retorna sessões ativas (verificar antes do branch b, pois tem prioridade).
- Para cada sessão ativa, montar bloco com:
  - **Sessão:** `sessionId`, `transport`, `status`, `spawnedAt`, `lastActivityAt`.
  - **Tópico:** `chatId` e `threadId` com link clicável para o tópico.
  - **Agente** (se `agentId` presente): nome e status atual via `ctx.agents.list()`.
  - **Runs** (se `agentId` presente): buscar via `fetchPaperclipApi()` `GET /api/agents/${agentId}/runs?limit=3`. Mostrar `runId` truncado + status + timestamp.
  - **Issue correlacionada** (transport native): lookup `issue_session_${issueId}` (de 2.3) para encontrar a issue mais recente da sessão. Mostrar identifier + link.
  - **Botões atalho** (condicionais por disponibilidade de dados):
    - "View Agent ↗" (se `publicUrl` e `agentId`)
    - "View Run ↗" (se `publicUrl` e `runId` da run mais recente)
    - "Open Issue ↗" (se `publicUrl` e `issueId` correlacionada)
    - "Close Session" (callback `acp_close_${sessionId}`)
    - "Cancel" (callback `acp_cancel_${sessionId}`, só se houver run ativa)

**Prioridade de detecção:** sessão > projeto > geral.

**Depende de:** 2.2 (tipo `ChatSession` com `topicId`), 2.3 (correlação issueId→sessionId).

---

### 3.5 — `/issues` context-aware

**Arquivo:** `src/commands.ts` — `handleIssues()`

**O que muda:** Hoje filtra por texto passado como argumento. Em tópico de projeto, deve auto-detectar o projeto.

**Estratégia:**
- Se `messageThreadId` existe e está mapeado a um projeto no topic-map:
  - Usar `projectId` do mapeamento como filtro em `ctx.issues.list()`.
  - Ignorar o argumento de texto passado (ou usá-lo como sub-filtro adicional de título).
  - Header: "📋 Issues — *Nome do Projeto*".
- Se não estiver em tópico de projeto: comportamento atual.

**Depende de:** Nenhuma infraestrutura nova — topic-map já existe. Pode ser feita a qualquer ponto após Etapa 1.

---

## ETAPA 4 — Botão "Abrir/Criar Sessão" em mensagens de run

4.1 não tem dependências externas. 4.2 depende de Etapa 2 completa e de 4.1.

---

### 4.1 — Botão nos formatters de agent run

**Arquivo:** `src/formatters.ts` — `formatAgentError()`, `formatAgentRunStarted()`, `formatAgentRunFinished()`

**O que muda:** Adicionar botão "🗂 Abrir/Criar Sessão" nas mensagens de agent run.

**Estratégia:**
- Adicionar parâmetro opcional `enableSessionButton?: boolean` nas assinaturas dos três formatters.
- Quando `true`: incluir botão com `callback_data: "open_session_${agentId}_${runId}"` (usar só `agentId` se `runId` não disponível).
- O botão fica na linha abaixo dos botões existentes (View Run ↗, View Agent ↗), ou sozinho se os outros não estiverem disponíveis.
- O `worker.ts` passa `enableSessionButton: true` ao chamar esses formatters.

> **Assunção a validar:** Se o chat não for forum, o botão deve aparecer mesmo assim (erro é dado ao clicar) — alinhado com o requisito de que a verificação de forum acontece **no momento de criar o tópico**, não no momento de formatar a mensagem.

---

### 4.2 — Callback handler para "Abrir/Criar Sessão"

**Arquivo:** `src/worker.ts` — handler de `callback_query`

**O que muda:** Hoje não existe handler para `open_session_*`.

**Estratégia:**

No handler de callbacks, adicionar case para `callback_data` com prefixo `open_session_`:

1. Parsear `agentId` e `runId` do `callback_data` (formato: `open_session_${agentId}_${runId}` ou `open_session_${agentId}` sem run).
2. Verificar deduplicação: lookup `run_session_${runId}` no state.
   - Se já existe sessão: responder com `answerCallbackQuery()` "Sessão já existe" + enviar mensagem com link para o tópico existente.
3. Se não existe: chamar `createSessionWithTopic()` (de 2.4) com `sourceAgentId` e `sourceRunId` como metadata.
4. Salvar mapeamento `run_session_${runId}` → `{ sessionId, chatId, topicId }`.
5. Responder `answerCallbackQuery()` com "Sessão criada!" (toast no Telegram).
6. Enviar card com link no chat original (já feito dentro de `createSessionWithTopic()`).

**Depende de:** 2.1, 2.2, 2.4, 4.1.

---

## ETAPA 5 — `/connect` novo comportamento

Sem dependências de infraestrutura nova. Pode ser implementada em paralelo com Etapas 3–4.

---

### 5.1 — Repropor `/connect` como mapeador projeto → tópico

**Arquivo:** `src/commands.ts` — `handleConnect()`

**Contexto:** O plugin é multi-tenant native. Cada empresa configura `defaultChatId`, token, etc. via `companySettingsPage`. O `companyId` vem do contexto do polling loop, não de um comando de setup. O papel original de `/connect <company-name>` (escrever `chat_${chatId}` → `companyId` no state) é redundante nesse modelo.

**Estratégia:**
- Substituir o corpo de `handleConnect()` pela lógica de `handleConnectTopic()` (que continua existindo internamente).
- Sintaxe resultante para o usuário: `/connect <project-name>` (dentro do tópico) ou `/connect <project-name> <topic-id>` — idêntica ao que `/connect_topic` fazia.
- A lógica de fallback `resolveCompanyId()` que lê o state legado `chat_${chatId}` é mantida para instâncias que ainda tenham esse estado — mas não é mais escrita.
- Atualizar a descrição do comando em `BOT_COMMANDS`: de "Link this chat to a Paperclip company" para "Map a project to a forum topic".

**Impacto:** Usuários com state legado continuam funcionando (leitura do state antigo ainda existe como fallback). Não há quebra para instâncias novas (que nunca tiveram esse state).

---

## Resumo de dependências

```
ETAPA 1 (sem deps)
  1.1  Filtrar /approve e /connect_topic do menu de autocomplete
  1.2  /connect_topic: deprecated → "unknown command"
  1.3  /approve sem args: nova mensagem orientativa
  1.4  createForumTopic na Telegram API (adição pura)

ETAPA 2 (depende de 1.4)
  2.1  checkForumOrError helper
  2.2  Extensão do tipo ChatSession (campos opcionais + índice inverso)
  2.3  Correlação issueId → sessionId em wakeAgentWithIssue
  2.4  createSessionWithTopic() ← depende de 1.4 + 2.1 + 2.2

ETAPA 3 (depende de Etapa 2)
  3.1  Agent picker paginado (componente compartilhado)
  3.2  /acp spawn sem args → agent picker ← depende de 2.1 + 2.4 + 3.1
  3.3  /create @agente + agent picker ← depende de 3.1
  3.4  /status context-aware (3 variantes) ← depende de 2.2 + 2.3
  3.5  /issues context-aware (usa topic-map existente)

ETAPA 4 (4.1 sem dep; 4.2 depende de Etapa 2)
  4.1  Botão "Abrir/Criar Sessão" nos formatters de agent run
  4.2  Callback handler para o botão ← depende de 2.1 + 2.2 + 2.4 + 4.1

ETAPA 5 (sem dep nova — paralela a Etapas 3–4)
  5.1  /connect reproposto como mapeador projeto → tópico
```
