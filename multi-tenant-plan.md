# Telegram Plugin Multi-Tenant Plan (companySettingsPage)

## Context / Problem Statement

Fork do `paperclip-plugin-telegram` para torná-lo multi-tenant (1 config por company).

**Descoberta chave:** A bridge do Paperclip sobrescreve silenciosamente o `companyId` enviado pela UI para a company ativa da página (`hostContext.companyId`). Isso quebrou a abordagem `settingsPage` + dropdown de company na UI.

**Solução encontrada:** Usar `type: "companySettingsPage"` no manifest. A página renderiza em `/company/:prefix/settings/:routePath`, e o `hostContext.companyId` já vem correto da rota — **sem sobrescrita pelo sandbox**.

---

## High-Level Design

### Global Config (instance-level, via `ctx.config`)

- `paperclipBaseUrl`
- `paperclipPublicUrl`

### Company Config (company-level, via `ctx.state`)

Persistir um documento por company em:

```
scopeKind: "company"
scopeId: <companyId>
stateKey: "telegram.config.v2.${companyId}"
```

Campos por company incluem:

- `telegramBotToken` (plaintext — secrets refs desabilitados no host)
- Routing: chat IDs, topics, notify flags, digest settings
- Access: enableCommands/enableInbound, allowlists
- Media: transcription, brief agent
- Escalation, proactive, watch windows

---

## Manifest

```ts
ui: {
  slots: [
    {
      type: "companySettingsPage",
      id: "telegram-settings",
      displayName: "Telegram Settings",
      exportName: "TelegramSettingsPage",
      routePath: "telegram-settings",
    },
  ],
}
```

---

## Worker Changes

1. **Setup:** ler URLs globais de `ctx.config.get()`. Ignorar token global.
2. **Handlers:**
   - `company-config.get` → lê `ctx.state` company-scoped, retorna config pública (sem token) + `hasToken`
   - `company-config.save` → escreve `ctx.state` company-scoped
3. **Polling:** um loop por company habilitada (token não vazio). Offsets separados por company.
4. **Eventos/Jobs:** para cada evento/job, carregar config da company do contexto. Skip se sem token.

---

## UI Changes

- **Sem dropdown de company.** O `context.companyId` da página já é a company correta.
- **Sem lista de companies.** A página é renderizada dentro do contexto da company.
- Token input mascarado (`type="password"`). Status: `Token configured: yes/no`.
- Seções por company: routing, access, media, escalation, proactive.
- Seção global (instance): Connection & URLs.

---

## Files Added/Modified (vs original)

| File | Change |
|------|--------|
| `src/manifest.ts` | `type: "companySettingsPage"` + `routePath` |
| `src/company-config.ts` | **novo** — tipos, normalização, get/save por company |
| `src/worker.ts` | refatorado para multi-tenant por company |
| `src/polling-offset.ts` | offset por company |
| `src/ui/index.tsx` | simplificado — sem dropdown, usa `context.companyId` |
| `src/acp-bridge.ts` | `tokenResolver` por company |
| `tests/company-config.test.ts` | **novo** — testes de normalização |

---

## Database Note

A tabela `plugin_state` precisa da constraint `UNIQUE NULLS NOT DISTINCT` em `(plugin_id, scope_kind, scope_id, namespace, state_key)` para o upsert funcionar corretamente com `scopeId = null`. Sem isso, o Drizzle `onConflictDoUpdate` insere duplicatas.

---

## Status

✅ **Funcionando.** Após alterar o manifest para `companySettingsPage` e reiniciar o Paperclip, o plugin aparece na settings de cada company (`/company/:prefix/settings/telegram-settings`). O isolamento por company funciona corretamente.
