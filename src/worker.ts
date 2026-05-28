import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type Agent,
  type Issue,
} from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  setMyCommands,
  escapeMarkdownV2,
  isForum,
  GENERAL_TOPIC_THREAD_ID,
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  type IssueLinksOpts,
} from "./formatters.js";
import { handleCommand, resolveNotificationThreadId, BOT_COMMANDS_MENU } from "./commands.js";
import {
  routeMessageToAgent,
  handleHandoffToolCall,
  handleDiscussToolCall,
  handleHandoffApproval,
  handleHandoffRejection,
  setupAcpOutputListener,
  buildAgentPickerContent,
  spawnAgentSessionById,
  closeSessionById,
  cancelSessionById,
  handleOpenSessionCallback,
} from "./acp-bridge.js";
import { createIssueWithAgent } from "./commands.js";
import { handleMediaMessage } from "./media-pipeline.js";
import {
  getPersistedTelegramUpdateOffset,
  getPersistedTelegramUpdateOffsetForCompany,
  persistTelegramUpdateOffset,
  persistTelegramUpdateOffsetForCompany,
  processTelegramUpdateBatch,
} from "./polling-offset.js";
import {
  getCompanyConfig,
  saveCompanyConfig,
  companyHasToken,
  stripTokenFromCompanyConfig,
  extractGlobalConfig,
  companyConfigStateKey,
} from "./company-config.js";
import { handleCommandsCommand, tryCustomCommand } from "./command-registry.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { AGENT_ERROR_DEDUPLICATION_WINDOW_MS, METRIC_NAMES } from "./constants.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent } from "./escalation.js";
import { isTelegramUpdateAllowed, validateTelegramAllowlists } from "./allowlist.js";
import { validateSecretRefFields } from "./secret-ref-validation.js";
import { shouldNotifyApproval } from "./approval-routing.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";

type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  approvalsTopicId: string;
  errorsChatId: string;
  errorsTopicId: string;
  digestChatId: string;
  digestTopicId: string;
  paperclipBaseUrl: string;
  paperclipBoardApiTokenRef: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  notifyOnApprovalCreated: boolean;
  onlyNotifyBoardApprovals: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  maxAgentsPerThread: number;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
      from?: { is_bot?: boolean };
    };
    entities?: Array<{ type: string; offset: number; length: number }>;
    // Media fields (Phase 3)
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
    video_note?: { file_id: string; duration: number };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";
const BOARD_ACCESS_SCOPE = {
  scopeKind: "instance",
  stateKey: "telegram.board-access.v1",
} as const;

type TelegramBoardAccessState = {
  paperclipBoardApiTokenRef: string | null;
  identity: string | null;
  companyId: string | null;
  updatedAt: string | null;
};

type TelegramBoardAccessRegistration = TelegramBoardAccessState & {
  configured: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBoardAccessState(value: unknown): TelegramBoardAccessState {
  const record = isRecord(value) ? value : {};
  return {
    paperclipBoardApiTokenRef: asNonEmptyString(record.paperclipBoardApiTokenRef),
    identity: asNonEmptyString(record.identity),
    companyId: asNonEmptyString(record.companyId),
    updatedAt: asNonEmptyString(record.updatedAt),
  };
}

async function loadBoardAccessState(ctx: PluginContext): Promise<TelegramBoardAccessState> {
  return normalizeBoardAccessState(await ctx.state.get(BOARD_ACCESS_SCOPE));
}

async function persistBoardAccessState(
  ctx: PluginContext,
  state: TelegramBoardAccessState,
): Promise<TelegramBoardAccessRegistration> {
  const nextState = normalizeBoardAccessState(state);
  await ctx.state.set(BOARD_ACCESS_SCOPE, nextState);
  return {
    ...nextState,
    configured: Boolean(nextState.paperclipBoardApiTokenRef),
  };
}

function getBoardAccessRegistration(
  state: TelegramBoardAccessState,
): TelegramBoardAccessRegistration {
  return {
    ...state,
    configured: Boolean(state.paperclipBoardApiTokenRef),
  };
}

async function resolveBoardApiToken(
  ctx: PluginContext,
  config: { paperclipBoardApiTokenRef?: string },
  companyId?: string | null,
): Promise<string | undefined> {
  const boardAccessState = await loadBoardAccessState(ctx);
  const candidates: Array<{ source: string; ref: string }> = [];

  if (
    boardAccessState.paperclipBoardApiTokenRef &&
    (!companyId || !boardAccessState.companyId || boardAccessState.companyId === companyId)
  ) {
    candidates.push({
      source: "board-access",
      ref: boardAccessState.paperclipBoardApiTokenRef,
    });
  }

  if (config.paperclipBoardApiTokenRef) {
    candidates.push({
      source: "config",
      ref: config.paperclipBoardApiTokenRef,
    });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.ref)) continue;
    seen.add(candidate.ref);
    try {
      return await ctx.secrets.resolve(candidate.ref);
    } catch (err) {
      ctx.logger.warn("Failed to resolve board API token secret", {
        source: candidate.source,
        companyId,
        error: String(err),
      });
    }
  }

  return undefined;
}

async function resolveCallbackCompanyId(
  ctx: PluginContext,
  query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<string | null> {
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return null;

  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `msg_${chatId}_${messageId}`,
  }) as { companyId?: string } | null;

  return mapping?.companyId ?? null;
}

/**
 * Shared 5s sliding-window dedupe for issue.updated handlers.
 *
 * Paperclip's core can emit duplicate `issue.updated` plugin events for a
 * single PATCH (the route's logActivity plus side-effects from heartbeat
 * reconciliation), so handlers must dedupe to avoid sending the same
 * Telegram message twice.
 */
function makeUpdateDedupe(windowMs = 5_000, maxEntries = 500) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(key, now);
    if (seen.size > maxEntries) {
      const cutoff = now - windowMs;
      for (const [k, ts] of seen) {
        if (ts < cutoff) seen.delete(k);
      }
    }
    return true;
  };
}

function normalizeAgentErrorMessage(input: unknown): string {
  return String(input ?? "Unknown error")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

async function resolveChat(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "telegram-chat",
  });
  return (override as string) ?? fallback ?? null;
}

function parseTopicId(value?: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function validateConfiguredTopicIds(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["approvalsTopicId", "errorsTopicId", "digestTopicId"]) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !parseTopicId(value)) {
      errors.push(`${key} must be a numeric Telegram forum topic ID string.`);
    }
  }
  return errors;
}

async function resolveDigestThreadId(
  ctx: PluginContext,
  token: string,
  chatId: string,
  configuredTopicId?: string,
): Promise<number | undefined> {
  const configured = parseTopicId(configuredTopicId);
  if (configured) return configured;
  return await isForum(ctx, token, chatId) ? GENERAL_TOPIC_THREAD_ID : undefined;
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? mapping?.companyName ?? chatId;
}

const plugin = definePlugin({
  async setup(ctx) {
    const rawGlobalConfig = await ctx.config.get();
    const globalConfig = extractGlobalConfig(rawGlobalConfig);
    const baseUrl = globalConfig.paperclipBaseUrl || "http://localhost:3100";
    const publicUrl = globalConfig.paperclipPublicUrl || baseUrl;

    ctx.data.register("board-access.read", async () => getBoardAccessRegistration(await loadBoardAccessState(ctx)));

    ctx.actions.register("board-access.update", async (params) => {
      const record = isRecord(params) ? params : {};
      const paperclipBoardApiTokenRef = asNonEmptyString(record.paperclipBoardApiTokenRef);
      const identity = asNonEmptyString(record.identity);
      const companyId = asNonEmptyString(record.companyId);
      const now = new Date().toISOString();
      return persistBoardAccessState(ctx, {
        paperclipBoardApiTokenRef,
        identity,
        companyId,
        updatedAt: now,
      });
    });

    async function handleCompanyConfigGet(params: unknown) {
      const record = isRecord(params) ? params : {};
      const companyId = asNonEmptyString(record.companyId);
      if (!companyId) return { config: null, hasToken: false };
      const cfg = await getCompanyConfig(ctx, companyId);
      if (!cfg) return { config: null, hasToken: false };
      return { config: stripTokenFromCompanyConfig(cfg), hasToken: companyHasToken(cfg) };
    }

    ctx.data.register("company-config.get", handleCompanyConfigGet);
    ctx.actions.register("company-config.get", handleCompanyConfigGet);

    ctx.actions.register("company-config.save", async (params) => {
      const record = isRecord(params) ? params : {};
      const companyId = asNonEmptyString(record.companyId);
      if (!companyId) throw new Error("companyId is required");
      const configJson = isRecord(record.configJson) ? record.configJson : {};
      const telegramBotToken =
        typeof record.telegramBotToken === "string" ? record.telegramBotToken.trim() : undefined;
      const patch: Parameters<typeof saveCompanyConfig>[2] = { ...configJson };
      if (telegramBotToken !== undefined) {
        patch.telegramBotToken = telegramBotToken;
      }
      await saveCompanyConfig(ctx, companyId, patch);
      return { ok: true };
    });

    // --- Multi-tenant polling ---
    const pollingRegistry = new Map<string, { token: string; active: boolean }>();

    async function startPollingForCompany(companyId: string, token: string) {
      if (pollingRegistry.has(companyId)) return;
      let active = true;
      pollingRegistry.set(companyId, { token, active });
      let lastUpdateId = await getPersistedTelegramUpdateOffsetForCompany(ctx, companyId);

      async function pollUpdates(): Promise<void> {
        while (active) {
          try {
            const res = await ctx.http.fetch(
              `${TELEGRAM_API}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["message","callback_query"]`,
              { method: "GET" },
            );
            const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
            if (data.ok && data.result) {
              lastUpdateId = await processTelegramUpdateBatch({
                updates: data.result,
                lastUpdateId,
                handleUpdate: (update) => handleUpdate(ctx, token, update, baseUrl, publicUrl, companyId),
                persistOffset: (updateId) => persistTelegramUpdateOffsetForCompany(ctx, companyId, updateId),
                logger: ctx.logger,
              });
            }
          } catch (err) {
            ctx.logger.error("Telegram polling error", { companyId, error: String(err) });
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }

      const companyCfg = await getCompanyConfig(ctx, companyId);
      if (companyCfg?.enableCommands) {
        const allCommands = [
          ...BOT_COMMANDS_MENU,
          { command: "commands", description: "Manage custom workflow commands" },
        ];
        setMyCommands(ctx, token, allCommands)
          .then((registered) => {
            if (registered) ctx.logger.info("Bot commands registered with Telegram", { companyId });
          })
          .catch((err) => {
            ctx.logger.error("Failed to register bot commands", { companyId, error: String(err) });
          });
      }

      pollUpdates().catch((err) => ctx.logger.error("Polling loop crashed", { companyId, error: String(err) }));
    }

    function stopPollingForCompany(companyId: string) {
      const reg = pollingRegistry.get(companyId);
      if (reg) reg.active = false;
      pollingRegistry.delete(companyId);
    }

    async function refreshPollingLoops() {
      const companies = await ctx.companies.list();
      const enabledCompanyIds: string[] = [];
      for (const company of companies) {
        const companyCfg = await getCompanyConfig(ctx, company.id);
        if (!companyCfg) return;
        if (companyHasToken(companyCfg)) {
          enabledCompanyIds.push(company.id);
          const existing = pollingRegistry.get(company.id);
          if (!existing) {
            ctx.logger.info("Starting Telegram polling for company", { companyId: company.id });
            await startPollingForCompany(company.id, companyCfg.telegramBotToken);
          } else if (existing.token !== companyCfg.telegramBotToken) {
            ctx.logger.info("Restarting Telegram polling for company due to token change", { companyId: company.id });
            stopPollingForCompany(company.id);
            await startPollingForCompany(company.id, companyCfg.telegramBotToken);
          }
        }
      }
      for (const [companyId] of pollingRegistry) {
        if (!enabledCompanyIds.includes(companyId)) {
          ctx.logger.info("Stopping Telegram polling for company", { companyId });
          stopPollingForCompany(companyId);
        }
      }
    }

    await refreshPollingLoops();

    ctx.events.on("plugin.stopping", async () => {
      for (const [companyId] of pollingRegistry) {
        stopPollingForCompany(companyId);
      }
    });

    // --- ACP output listener (multi-tenant via token resolver) ---
    setupAcpOutputListener(ctx, (companyId) => pollingRegistry.get(companyId)?.token);

    // --- Event subscriptions ---
    const issuePrefixCache = new Map<string, string>();

    async function resolveIssueLinksOpts(companyId: string): Promise<IssueLinksOpts> {
      let prefix = issuePrefixCache.get(companyId);
      if (!prefix) {
        const company = await ctx.companies.get(companyId);
        prefix = company?.issuePrefix ?? "";
        if (prefix) issuePrefixCache.set(companyId, prefix);
      }
      return { baseUrl: publicUrl, issuePrefix: prefix || undefined };
    }

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
      overrideChatId?: string,
      overrideTopicId?: string,
    ) => {
      const companyCfg = await getCompanyConfig(ctx, event.companyId);
      if (!companyCfg) return;
      if (!companyHasToken(companyCfg)) return;
      const token = companyCfg.telegramBotToken;

      const chatId = await resolveChat(ctx, event.companyId, overrideChatId || companyCfg.defaultChatId);
      if (!chatId) return;
      const linksOpts = await resolveIssueLinksOpts(event.companyId);
      const msg = formatter(event, linksOpts);

      let messageThreadId = parseTopicId(overrideTopicId);
      if (!messageThreadId) {
        messageThreadId = await resolveNotificationThreadId(ctx, chatId, event, companyCfg.topicRouting);
      }
      if (messageThreadId) {
        msg.options.messageThreadId = messageThreadId;
      }

      const anchorKey = event.entityId ? `anchor_${chatId}_${event.entityType}_${event.entityId}` : null;
      if (anchorKey) {
        const anchor = (await ctx.state.get({ scopeKind: "instance", stateKey: anchorKey })) as { messageId: number; messageThreadId?: number } | null;
        if (anchor?.messageId && anchor.messageThreadId === messageThreadId) {
          msg.options.replyToMessageId = anchor.messageId;
        }
      }

      const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);
      if (messageId) {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: `msg_${chatId}_${messageId}` },
          { entityId: event.entityId, entityType: event.entityType, companyId: event.companyId, eventType: event.eventType },
        );
        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Telegram`,
          entityType: "plugin",
          entityId: event.entityId,
        });
        if (anchorKey) {
          const existing = (await ctx.state.get({ scopeKind: "instance", stateKey: anchorKey })) as { messageId: number; messageThreadId?: number } | null;
          if (!existing) {
            await ctx.state.set({ scopeKind: "instance", stateKey: anchorKey }, { messageId, messageThreadId });
          }
        }
      }
    };

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (cfg?.notifyOnIssueCreated) await notify(event, formatIssueCreated);
    });

    const doneDedupe = makeUpdateDedupe();
    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (!cfg) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status === "done" && cfg.notifyOnIssueDone) {
        if (!doneDedupe(`done|${event.entityId}`)) return;
        if (!payload.title && event.entityId) {
          try { const issue = await ctx.issues.get(event.entityId, event.companyId); if (issue) payload.title = issue.title; } catch { /* best effort */ }
        }
        if (!payload.comment && event.entityId) {
          try {
            const comments = await ctx.issues.listComments(event.entityId, event.companyId);
            if (comments.length > 0) {
              const latest = comments.reduce((a, b) => new Date(a.createdAt) > new Date(b.createdAt) ? a : b);
              payload.comment = latest.body;
            }
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueDone);
      }
      if (cfg.notifyOnIssueAssigned) {
        const prev = (payload._previous as Record<string, unknown> | undefined) ?? {};
        const userChanged = "assigneeUserId" in payload && payload.assigneeUserId !== prev.assigneeUserId;
        const agentChanged = "assigneeAgentId" in payload && payload.assigneeAgentId !== prev.assigneeAgentId;
        if (!userChanged && !agentChanged) return;
        if (cfg.onlyNotifyIfAssignedTo && payload.assigneeUserId !== cfg.onlyNotifyIfAssignedTo) return;
        const dedupeKey = ["assigned", event.entityId, String(prev.assigneeUserId ?? ""), String(payload.assigneeUserId ?? ""), String(prev.assigneeAgentId ?? ""), String(payload.assigneeAgentId ?? "")].join("|");
        const assignmentDedupe = makeUpdateDedupe();
        if (!assignmentDedupe(dedupeKey)) return;
        if ((!payload.title || !payload.assigneeName) && event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) { payload.title ??= issue.title; const name = (issue as unknown as Record<string, unknown>).assigneeName; if (name) payload.assigneeName ??= name; }
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueAssigned);
      }
    });

    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (!cfg?.notifyOnApprovalCreated) return;
      if (!shouldNotifyApproval(event, cfg.onlyNotifyBoardApprovals)) return;
      const payload = event.payload as Record<string, unknown>;
      const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds as string[] : [];
      if (issueIds.length > 0 && !payload.linkedIssues) {
        try {
          const issues = await Promise.all(issueIds.slice(0, 5).map((id) => ctx.issues.get(id, event.companyId)));
          payload.linkedIssues = issues.filter(Boolean).map((i) => ({ identifier: i!.identifier, title: i!.title, status: i!.status, priority: i!.priority }));
          if (!payload.title && issues[0]) payload.title = issues[0].identifier ? `${issues[0].identifier}: ${issues[0].title}` : issues[0].title;
        } catch { /* best effort */ }
      }
      if (payload.agentId && !payload.agentName) {
        try { const agent = await ctx.agents.get(String(payload.agentId), event.companyId); if (agent) payload.agentName = agent.name; } catch { /* best effort */ }
      }
      if (!payload.title || payload.title === "Approval Requested") {
        const approvalType = String(payload.type ?? "unknown").replace(/_/g, " ");
        const agentLabel = payload.agentName ? String(payload.agentName) : null;
        payload.title = agentLabel ? `${approvalType} — ${agentLabel}` : approvalType;
      }
      await notify(event, formatApprovalCreated, cfg.approvalsChatId, cfg.approvalsTopicId);
    });

    const agentErrorDedupe = makeUpdateDedupe(AGENT_ERROR_DEDUPLICATION_WINDOW_MS, 1000);
    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (!cfg?.notifyOnAgentError) return;
      const payload = event.payload as Record<string, unknown>;
      const agentId = String(payload.agentId ?? event.entityId);
      if (payload.agentId && !payload.agentName) {
        try { const agent = await ctx.agents.get(String(payload.agentId), event.companyId); if (agent) payload.agentName = agent.name; } catch { /* best effort */ }
      }
      if (!payload.companyName) {
        try { const company = await ctx.companies.get(event.companyId); if (company?.name) payload.companyName = company.name; } catch { /* best effort */ }
      }
      if (payload.issueId && (!payload.issueIdentifier || !payload.issueTitle)) {
        try { const issue = await ctx.issues.get(String(payload.issueId), event.companyId); if (issue) { payload.issueIdentifier ??= issue.identifier; payload.issueTitle ??= issue.title; } } catch { /* best effort */ }
      }
      const errorMessage = normalizeAgentErrorMessage(payload.error ?? payload.message);
      const dedupeKey = ["agent.run.failed", event.companyId, agentId, errorMessage].join(":");
      if (!agentErrorDedupe(dedupeKey)) return;
      await notify(event, (e, opts) => formatAgentError(e, opts, { enableSessionButton: true }), cfg.errorsChatId, cfg.errorsTopicId);
    });

    const enrichAgentName = async (event: PluginEvent) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload.agentId && !payload.agentName) {
        try { const agent = await ctx.agents.get(String(payload.agentId), event.companyId); if (agent) payload.agentName = agent.name; } catch { /* best effort */ }
      }
    };

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (!cfg?.notifyOnAgentRunStarted) return;
      await enrichAgentName(event);
      await notify(event, (e, opts) => formatAgentRunStarted(e, opts, { enableSessionButton: true }));
    });

    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const cfg = await getCompanyConfig(ctx, event.companyId);
      if (!cfg?.notifyOnAgentRunFinished) return;
      await enrichAgentName(event);
      await notify(event, (e, opts) => formatAgentRunFinished(e, opts, { enableSessionButton: true }));
    });

    ctx.data.register("chat-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" });
      const cfg = await getCompanyConfig(ctx, companyId);
      if (!cfg) return;
      return { chatId: saved ?? cfg?.defaultChatId ?? "" };
    });

    ctx.actions.register("set-chat", async (params) => {
      const companyId = String(params.companyId);
      const chatId = String(params.chatId);
      await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" }, chatId);
      ctx.logger.info("Updated Telegram chat mapping", { companyId, chatId });
      return { ok: true };
    });

    // --- Jobs ---
    ctx.jobs.register("telegram-daily-digest", async () => {
      const nowHour = new Date().getUTCHours();
      const nowMin = new Date().getUTCMinutes();
      if (nowMin >= 5) return;
      const companies = await ctx.companies.list();
      for (const company of companies) {
        const companyCfg = await getCompanyConfig(ctx, company.id);
        if (!companyCfg) return;
        if (!companyHasToken(companyCfg)) continue;
        const effectiveDigestMode = companyCfg.digestMode;
        if (effectiveDigestMode === "off") continue;
        const parseHour = (t: string) => { const [h] = (t || "").split(":"); return parseInt(h ?? "", 10); };
        const firstHour = parseHour(companyCfg.dailyDigestTime);
        const secondHour = parseHour(companyCfg.bidailySecondTime);
        const tridailyHours = (companyCfg.tridailyTimes || "07:00,13:00,19:00").split(",").map((t) => parseHour(t.trim()));
        let shouldSend = false;
        if (effectiveDigestMode === "daily") shouldSend = nowHour === firstHour;
        else if (effectiveDigestMode === "bidaily") shouldSend = nowHour === firstHour || nowHour === secondHour;
        else if (effectiveDigestMode === "tridaily") shouldSend = tridailyHours.includes(nowHour);
        if (!shouldSend) continue;
        const token = companyCfg.telegramBotToken;
        const chatId = await resolveChat(ctx, company.id, companyCfg.digestChatId || companyCfg.defaultChatId);
        if (!chatId) continue;
        try {
          const agents = await ctx.agents.list({ companyId: company.id });
          const activeAgents = agents.filter((a: Agent) => a.status === "active");
          const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });
          const now = Date.now();
          const oneDayMs = 24 * 60 * 60 * 1000;
          const completedToday = issues.filter((i: Issue) => i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs);
          const createdToday = issues.filter((i: Issue) => (now - new Date(i.createdAt).getTime()) < oneDayMs);
          const issuePrefix = company.issuePrefix;
          const inProgress = issues.filter((i: Issue) => i.status === "in_progress");
          const inReview = issues.filter((i: Issue) => i.status === "in_review");
          const blocked = issues.filter((i: Issue) => i.status === "blocked");
          const dateStr = new Date().toISOString().split("T")[0];
          const companyLabel = company.name ? ` \- ${escapeMarkdownV2(company.name)}` : "";
          const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
          const lines = [
            escapeMarkdownV2("\ud83d\udcca") + ` *${escapeMarkdownV2(digestLabel)}${companyLabel} \- ${escapeMarkdownV2(dateStr!)}*`,
            "",
            `${escapeMarkdownV2("\u2705")} Tasks completed: *${completedToday.length}*`,
            `${escapeMarkdownV2("\ud83d\udccb")} Tasks created: *${createdToday.length}*`,
            `${escapeMarkdownV2("\ud83e\udd16")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
          ];
          if (activeAgents.length > 0) {
            const topAgent = activeAgents[0]!.name;
            lines.push(`${escapeMarkdownV2("\u2b50")} Top performer: *${escapeMarkdownV2(topAgent)}*`);
          }
          const formatIssueItem = (i: Issue) => {
            const id = i.identifier ?? i.id;
            const idText = issuePrefix ? `[${escapeMarkdownV2(id)}](${publicUrl}/${issuePrefix}/issues/${id})` : escapeMarkdownV2(id);
            return `  ${idText} \- ${escapeMarkdownV2(i.title)}`;
          };
          if (inProgress.length > 0) { lines.push("", `${escapeMarkdownV2("\ud83d\udd04")} *In Progress \(${inProgress.length}\)*`); for (const i of inProgress.slice(0, 10)) lines.push(formatIssueItem(i)); }
          if (inReview.length > 0) { lines.push("", `${escapeMarkdownV2("\ud83d\udd0d")} *In Review \(${inReview.length}\)*`); for (const i of inReview.slice(0, 10)) lines.push(formatIssueItem(i)); }
          if (blocked.length > 0) { lines.push("", `${escapeMarkdownV2("\ud83d\udeab")} *Blocked \(${blocked.length}\)*`); for (const i of blocked.slice(0, 10)) lines.push(formatIssueItem(i)); }
          const digestThreadId = await resolveDigestThreadId(ctx, token, chatId, companyCfg.digestTopicId);
          await sendMessage(ctx, token, chatId, lines.join("\n"), { parseMode: "MarkdownV2", messageThreadId: digestThreadId });
        } catch (err) {
          ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
          const text = [escapeMarkdownV2("\ud83d\udcca") + " *Daily Digest*", "", escapeMarkdownV2("Could not generate digest. Check plugin logs for details.")].join("\n");
          const errorThreadId = await resolveDigestThreadId(ctx, token, chatId, companyCfg.errorsTopicId || companyCfg.digestTopicId);
          await sendMessage(ctx, token, chatId, text, { parseMode: "MarkdownV2", messageThreadId: errorThreadId });
        }
      }
    });

    const escalationManager = new EscalationManager();

    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"], description: "Why this conversation needs human attention" },
          conversationSummary: { type: "string", description: "Brief summary of the conversation context and what the user needs" },
          suggestedActions: { type: "array", items: { type: "string" }, description: "Suggested actions the human responder could take" },
          suggestedReply: { type: "string", description: "A draft reply the human can send or modify" },
          confidenceScore: { type: "number", minimum: 0, maximum: 1, description: "How confident the agent is (0-1). Lower values indicate greater need for human help" },
          originChatId: { type: "string" },
          originThreadId: { type: "string" },
          originMessageId: { type: "string" },
          sessionId: { type: "string", description: "Session ID for routing reply back" },
          transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const p = params as Record<string, unknown>;
      const companyCfg = await getCompanyConfig(ctx, runCtx.companyId);
      if (!companyCfg) return { error: "Company config not available" };
      if (!companyHasToken(companyCfg)) return { error: "Telegram bot not configured for this company" };
      const token = companyCfg.telegramBotToken;
      const escalationId = crypto.randomUUID();
      const timeoutMs = companyCfg.escalationTimeoutMs || 900000;
      const defaultAction = companyCfg.escalationDefaultAction || "defer";
      const resolvedEscalationChatId = await resolveChat(ctx, runCtx.companyId, companyCfg.escalationChatId);
      if (!resolvedEscalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured", { companyId: runCtx.companyId });
        return { error: "No escalation channel configured" };
      }
      const escalationEvent: EscalationEvent = {
        escalationId,
        agentId: runCtx.agentId,
        companyId: runCtx.companyId,
        reason: p.reason as EscalationEvent["reason"],
        context: {
          conversationHistory: [],
          agentReasoning: String(p.conversationSummary ?? ""),
          suggestedActions: (p.suggestedActions as string[]) ?? [],
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
          confidenceScore: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
        },
        timeout: { durationMs: timeoutMs, defaultAction },
        originChatId: p.originChatId ? String(p.originChatId) : undefined,
        originThreadId: p.originThreadId ? String(p.originThreadId) : undefined,
        originMessageId: p.originMessageId ? String(p.originMessageId) : undefined,
        transport: p.transport as "native" | "acp" | undefined,
        sessionId: p.sessionId ? String(p.sessionId) : undefined,
      };
      await escalationManager.create(ctx, token, escalationEvent, resolvedEscalationChatId);
      if (companyCfg.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(companyCfg.escalationHoldMessage);
        await sendMessage(ctx, token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }
      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to hand off to" },
          reason: { type: "string", description: "Why you're handing off" },
          contextSummary: { type: "string", description: "Summary for the target agent" },
          requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "reason", "contextSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const companyCfg = await getCompanyConfig(ctx, runCtx.companyId);
      if (!companyCfg) return { error: "Company config not available" };
      if (!companyHasToken(companyCfg)) return { error: "Telegram bot not configured for this company" };
      return handleHandoffToolCall(ctx, companyCfg.telegramBotToken, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to discuss with" },
          topic: { type: "string", description: "Discussion topic" },
          initialMessage: { type: "string", description: "First message to send" },
          maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
          humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "topic", "initialMessage"],
      },
    }, async (params: unknown, runCtx) => {
      const companyCfg = await getCompanyConfig(ctx, runCtx.companyId);
      if (!companyCfg) return { error: "Company config not available" };
      if (!companyHasToken(companyCfg)) return { error: "Telegram bot not configured for this company" };
      return handleDiscussToolCall(ctx, companyCfg.telegramBotToken, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    ctx.tools.register("register_watch", {
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the watch" },
          description: { type: "string", description: "What this watch monitors" },
          entityType: { type: "string", enum: ["issue", "agent", "company", "custom"], description: "Type of entity to watch" },
          conditions: { type: "array", items: { type: "object", properties: { field: { type: "string" }, operator: { type: "string", enum: ["gt", "lt", "eq", "ne", "contains", "exists"] }, value: {} }, required: ["field", "operator", "value"] }, description: "Conditions that trigger the watch" },
          template: { type: "string", description: "Message template with {{field}} placeholders" },
          builtinTemplate: { type: "string", enum: ["invoice-overdue", "lead-stale"], description: "Use a built-in template instead" },
          chatId: { type: "string", description: "Telegram chat ID for suggestions" },
          threadId: { type: "number", description: "Telegram thread ID for suggestions" },
        },
        required: ["chatId"],
      },
    }, async (params: unknown, runCtx) => {
      return handleRegisterWatch(ctx, params as Record<string, unknown>, runCtx.companyId);
    });

    ctx.jobs.register("check-escalation-timeouts", async () => {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        const companyCfg = await getCompanyConfig(ctx, company.id);
        if (!companyCfg) return;
        if (!companyHasToken(companyCfg)) continue;
        try {
          await escalationManager.checkTimeouts(ctx, companyCfg.telegramBotToken);
        } catch (err) {
          ctx.logger.error("Escalation timeout check failed", { companyId: company.id, error: String(err) });
        }
      }
    });

    ctx.jobs.register("check-watches", async () => {
      const companies = await ctx.companies.list();
      for (const company of companies) {
        const companyCfg = await getCompanyConfig(ctx, company.id);
        if (!companyCfg) return;
        if (!companyHasToken(companyCfg)) continue;
        try {
          await checkWatches(ctx, companyCfg.telegramBotToken, {
            maxSuggestionsPerHourPerCompany: companyCfg.maxSuggestionsPerHourPerCompany ?? 10,
            watchDeduplicationWindowMs: companyCfg.watchDeduplicationWindowMs ?? 86400000,
          });
        } catch (err) {
          ctx.logger.error("Watch check failed", { companyId: company.id, error: String(err) });
        }
      }
    });

    ctx.logger.info("Telegram bot plugin started (multi-tenant)");
  },
  async onValidateConfig(config) {
    const topicErrors = validateConfiguredTopicIds(config as Record<string, unknown>);
    if (topicErrors.length > 0) {
      return { ok: false, errors: topicErrors };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

async function handleUpdate(
  ctx: PluginContext,
  token: string,
  update: TelegramUpdate,
  baseUrl: string,
  publicUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  const companyCfg = resolvedCompanyId ? await getCompanyConfig(ctx, resolvedCompanyId) : null;
  if (!companyCfg || !companyHasToken(companyCfg)) {
    return;
  }

  if (!isTelegramUpdateAllowed(companyCfg, update)) {
    const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    ctx.logger.warn("Blocked unauthorized Telegram update", { updateId: update.update_id, fromId, chatId, companyId: resolvedCompanyId });
    return;
  }

  if (update.callback_query) {
    const companyId = await resolveCallbackCompanyId(ctx, update.callback_query);
    const boardApiToken = await resolveBoardApiToken(ctx, companyCfg, companyId);
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl, boardApiToken);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.document || msg.photo);
  if (hasMedia) {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const handled = await handleMediaMessage(ctx, token, msg as Parameters<typeof handleMediaMessage>[2], {
      briefAgentId: companyCfg.briefAgentId ?? "",
      briefAgentChatIds: companyCfg.briefAgentChatIds ?? [],
      transcriptionApiKeyRef: companyCfg.transcriptionApiKeyRef ?? "",
      publicUrl,
    }, companyId);
    if (handled) return;
  }

  if (!msg.text) return;

  const text = msg.text;

  if (threadId) {
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
      const replyToId = msg.reply_to_message?.message_id;
      const routed = await routeMessageToAgent(ctx, token, chatId, threadId, text, replyToId, companyId);
      if (routed) return;
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && companyCfg.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);

    if (command === "commands") {
      await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
      return;
    }

    const handledCustom = await tryCustomCommand(ctx, token, chatId, command, args, threadId, companyId);
    if (handledCustom) return;

    const boardApiToken = command === "approve" ? await resolveBoardApiToken(ctx, companyCfg, companyId) : undefined;
    const userId = msg.from?.id ? String(msg.from.id) : undefined;
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl, publicUrl, companyId, boardApiToken, companyCfg.maxAgentsPerThread, userId);
    return;
  }

  if (companyCfg.enableInbound && msg.reply_to_message?.from?.is_bot) {
    const replyToId = msg.reply_to_message.message_id;
    const mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${replyToId}`,
    }) as { entityId: string; entityType: string; companyId: string } | null;

    if (mapping && mapping.entityType === "escalation") {
      const escalationManager = new EscalationManager();
      const responderId = `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`;
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId,
        responseText: text,
        action: "reply_to_customer",
      });
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed Telegram reply to escalation", { escalationId: mapping.entityId, from: msg.from?.username });
    } else if (mapping && mapping.entityType === "issue") {
      try {
        await ctx.issues.createComment(mapping.entityId, text, mapping.companyId);
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", { issueId: mapping.entityId, from: msg.from?.username });
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", { issueId: mapping.entityId, error: String(err) });
      }
    }
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
  boardApiToken?: string,
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });
    try {
      await fetchPaperclipApi(ctx, `${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildPaperclipAuthHeaders(boardApiToken) },
        body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
      });
      await answerCallbackQuery(ctx, token, query.id, "Approved");
      if (chatId && messageId) {
        await editMessage(ctx, token, chatId, messageId, `${escapeMarkdownV2("\u2705")} *Approved* by ${escapeMarkdownV2(actor)}`, { parseMode: "MarkdownV2" });
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1] ?? "";
    const escalationId = parts.slice(2).join("_");
    const escalationManager = new EscalationManager();
    await escalationManager.handleCallback(ctx, token, action, escalationId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, `Escalation: ${action}`);
    return;
  }

  if (data.startsWith("reject_")) {
    const approvalId = data.replace("reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, actor });
    try {
      await fetchPaperclipApi(ctx, `${baseUrl}/api/approvals/${approvalId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...buildPaperclipAuthHeaders(boardApiToken) },
        body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
      });
      await answerCallbackQuery(ctx, token, query.id, "Rejected");
      if (chatId && messageId) {
        await editMessage(ctx, token, chatId, messageId, `${escapeMarkdownV2("\u274c")} *Rejected* by ${escapeMarkdownV2(actor)}`, { parseMode: "MarkdownV2" });
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("handoff_approve_")) {
    const handoffId = data.replace("handoff_approve_", "");
    await handleHandoffApproval(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff approved");
    return;
  }

  if (data.startsWith("handoff_reject_")) {
    const handoffId = data.replace("handoff_reject_", "");
    await handleHandoffRejection(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff rejected");
    return;
  }

  // --- Agent picker: /acp spawn ---
  if (data.startsWith("acp_spawn_sel_")) {
    const agentId = data.slice("acp_spawn_sel_".length);
    if (!chatId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const pickerCtx = await ctx.state.get({ scopeKind: "instance", stateKey: `picker_ctx_${chatId}_acp_spawn` }) as { messageThreadId?: number; companyId?: string } | null;
    const companyId = pickerCtx?.companyId ?? await resolveCompanyId(ctx, chatId);
    await answerCallbackQuery(ctx, token, query.id, "Iniciando sessão...");
    await spawnAgentSessionById(ctx, token, chatId, agentId, companyId, pickerCtx?.messageThreadId);
    return;
  }

  if (data.startsWith("acp_spawn_page_") || data.startsWith("acp_spawn_all_")) {
    if (!chatId || !messageId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const isAll = data.startsWith("acp_spawn_all_");
    const page = parseInt(data.split("_").pop() ?? "0", 10);
    const pickerCtx = await ctx.state.get({ scopeKind: "instance", stateKey: `picker_ctx_${chatId}_acp_spawn` }) as { companyId?: string } | null;
    const companyId = pickerCtx?.companyId ?? await resolveCompanyId(ctx, chatId);
    const { text, keyboard } = await buildAgentPickerContent(ctx, companyId, { page, showAll: isAll, callbackPrefix: "acp_spawn" });
    await editMessage(ctx, token, chatId, messageId, text, { inlineKeyboard: keyboard });
    await answerCallbackQuery(ctx, token, query.id, "");
    return;
  }

  // --- Agent picker: /create issue ---
  if (data.startsWith("create_issue_sel_")) {
    const agentId = data.slice("create_issue_sel_".length);
    if (!chatId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const pendingKey = `create_pending_${chatId}_${query.from.id}`;
    const pending = await ctx.state.get({ scopeKind: "instance", stateKey: pendingKey }) as { text: string; messageThreadId?: number; linkBaseUrl?: string; companyId?: string } | null
      ?? await ctx.state.get({ scopeKind: "instance", stateKey: `create_pending_${chatId}` }) as { text: string; messageThreadId?: number; linkBaseUrl?: string; companyId?: string } | null;

    if (!pending) { await answerCallbackQuery(ctx, token, query.id, "Sessão expirada. Use /create novamente."); return; }

    const companyId = pending.companyId ?? await resolveCompanyId(ctx, chatId);
    const allAgents = await ctx.agents.list({ companyId }) as Array<{ id?: string; agentId?: string; _id?: string; name?: string }>;
    const agent = allAgents.find((a) => String(a.agentId ?? a._id ?? a.id ?? "") === agentId);
    const agentName = agent?.name ?? agentId;

    const title = pending.text.match(/^[^.!?\n]{1,120}[.!?\n]?/)?.[0]?.trim() ?? pending.text.slice(0, 120).trim();
    const description = pending.text.length > title.length ? pending.text.slice(title.length).trim() : undefined;

    await ctx.state.set({ scopeKind: "instance", stateKey: pendingKey }, null);
    await answerCallbackQuery(ctx, token, query.id, "Criando task...");
    await createIssueWithAgent(ctx, token, chatId, companyId, agentId, agentName, title, description, pending.messageThreadId, pending.linkBaseUrl);
    return;
  }

  if (data.startsWith("create_issue_page_") || data.startsWith("create_issue_all_")) {
    if (!chatId || !messageId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const isAll = data.startsWith("create_issue_all_");
    const page = parseInt(data.split("_").pop() ?? "0", 10);
    const pickerCtx = await ctx.state.get({ scopeKind: "instance", stateKey: `picker_ctx_${chatId}_create_issue` }) as { companyId?: string } | null;
    const companyId = pickerCtx?.companyId ?? await resolveCompanyId(ctx, chatId);
    const { text, keyboard } = await buildAgentPickerContent(ctx, companyId, { page, showAll: isAll, callbackPrefix: "create_issue" });
    await editMessage(ctx, token, chatId, messageId, text, { inlineKeyboard: keyboard });
    await answerCallbackQuery(ctx, token, query.id, "");
    return;
  }

  // --- Session close / cancel from /status buttons ---
  if (data.startsWith("acp_close_")) {
    const sessionId = data.slice("acp_close_".length);
    if (!chatId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const companyId = await resolveCompanyId(ctx, chatId);
    const ok = await closeSessionById(ctx, token, sessionId, companyId);
    await answerCallbackQuery(ctx, token, query.id, ok ? "Sessão encerrada." : "Sessão não encontrada.");
    return;
  }

  if (data.startsWith("acp_cancel_")) {
    const sessionId = data.slice("acp_cancel_".length);
    if (!chatId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }
    const companyId = await resolveCompanyId(ctx, chatId);
    const ok = await cancelSessionById(ctx, companyId, sessionId);
    await answerCallbackQuery(ctx, token, query.id, ok ? "Cancelamento solicitado." : "Sessão não encontrada.");
    return;
  }

  // --- Botão "Abrir/Criar Sessão" em mensagens de agent run ---
  if (data.startsWith("open_session_")) {
    if (!chatId) { await answerCallbackQuery(ctx, token, query.id, "Contexto inválido."); return; }

    const rest = data.slice("open_session_".length);
    let agentId: string;
    let runId: string | undefined;

    // agentId is a UUID (exactly 36 chars); runId follows after "_" separator if present
    if (rest.length > 36 && rest[36] === "_") {
      agentId = rest.slice(0, 36);
      runId = rest.slice(37) || undefined;
    } else {
      agentId = rest;
      runId = undefined;
    }

    const result = await handleOpenSessionCallback(ctx, token, chatId, agentId, runId);

    if (result.status === "existing") {
      const chatNumericId = result.existingChatId.replace(/^-100/, "");
      const topicLink = `https://t.me/c/${chatNumericId}/${result.topicId}`;
      await answerCallbackQuery(ctx, token, query.id, "Sessão já existe.");
      await sendMessage(ctx, token, chatId, `🗂 Sessão já criada. <a href="${topicLink}">Abrir tópico</a>`, { parseMode: "HTML" });
    } else if (result.status === "created") {
      await answerCallbackQuery(ctx, token, query.id, "Sessão criada!");
    } else {
      await answerCallbackQuery(ctx, token, query.id, "Erro ao criar sessão.");
    }
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

runWorker(plugin, import.meta.url);
