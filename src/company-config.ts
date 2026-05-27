import type { PluginContext } from "@paperclipai/plugin-sdk";

// --- Types ---

export type TelegramGlobalConfig = {
  paperclipBaseUrl: string;
  paperclipPublicUrl: string;
};

export type TelegramCompanyConfigV2 = {
  // Token (plaintext, temporary until secrets are re-enabled)
  telegramBotToken: string;

  // Routing
  defaultChatId: string;
  topicRouting: boolean;
  maxAgentsPerThread: number;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  approvalsChatId: string;
  approvalsTopicId: string;
  notifyOnApprovalCreated: boolean;
  onlyNotifyBoardApprovals: boolean;
  errorsChatId: string;
  errorsTopicId: string;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  digestChatId: string;
  digestTopicId: string;
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;

  // Access
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];

  // Board fallback (secret ref disabled; kept for schema compatibility but ignored)
  paperclipBoardApiTokenRef: string;

  // Media
  transcriptionApiKeyRef: string;
  briefAgentId: string;
  briefAgentChatIds: string[];

  // Escalation
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;

  // Proactive
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

/** Public-safe view of company config (never includes the bot token). */
export type TelegramCompanyConfigV2Public = Omit<TelegramCompanyConfigV2, "telegramBotToken"> & {
  hasToken: boolean;
};

// --- Defaults ---

const DEFAULT_MAX_AGENTS_PER_THREAD = 5;

export const DEFAULT_COMPANY_CONFIG_V2: TelegramCompanyConfigV2 = {
  telegramBotToken: "",
  defaultChatId: "",
  topicRouting: false,
  maxAgentsPerThread: DEFAULT_MAX_AGENTS_PER_THREAD,
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  approvalsChatId: "",
  approvalsTopicId: "",
  notifyOnApprovalCreated: true,
  onlyNotifyBoardApprovals: false,
  errorsChatId: "",
  errorsTopicId: "",
  notifyOnAgentError: true,
  notifyOnAgentRunStarted: false,
  notifyOnAgentRunFinished: false,
  digestChatId: "",
  digestTopicId: "",
  digestMode: "off",
  dailyDigestTime: "09:00",
  bidailySecondTime: "17:00",
  tridailyTimes: "07:00,13:00,19:00",
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
  paperclipBoardApiTokenRef: "",
  transcriptionApiKeyRef: "",
  briefAgentId: "",
  briefAgentChatIds: [],
  escalationChatId: "",
  escalationTimeoutMs: 900_000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86_400_000,
};

// --- Normalization ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function asDigestMode(value: unknown): TelegramCompanyConfigV2["digestMode"] {
  return value === "daily" || value === "bidaily" || value === "tridaily" ? value : "off";
}

function asEscalationDefaultAction(
  value: unknown,
): TelegramCompanyConfigV2["escalationDefaultAction"] {
  return value === "auto_reply" || value === "close" ? value : "defer";
}

export function normalizeCompanyConfigV2(raw: unknown): TelegramCompanyConfigV2 {
  const record = isRecord(raw) ? raw : {};
  return {
    telegramBotToken: asString(record.telegramBotToken),
    defaultChatId: asString(record.defaultChatId),
    topicRouting: asBoolean(record.topicRouting, DEFAULT_COMPANY_CONFIG_V2.topicRouting),
    maxAgentsPerThread: asNumber(record.maxAgentsPerThread, DEFAULT_COMPANY_CONFIG_V2.maxAgentsPerThread),
    notifyOnIssueCreated: asBoolean(record.notifyOnIssueCreated, DEFAULT_COMPANY_CONFIG_V2.notifyOnIssueCreated),
    notifyOnIssueDone: asBoolean(record.notifyOnIssueDone, DEFAULT_COMPANY_CONFIG_V2.notifyOnIssueDone),
    notifyOnIssueAssigned: asBoolean(record.notifyOnIssueAssigned, DEFAULT_COMPANY_CONFIG_V2.notifyOnIssueAssigned),
    onlyNotifyIfAssignedTo: asString(record.onlyNotifyIfAssignedTo),
    approvalsChatId: asString(record.approvalsChatId),
    approvalsTopicId: asString(record.approvalsTopicId),
    notifyOnApprovalCreated: asBoolean(record.notifyOnApprovalCreated, DEFAULT_COMPANY_CONFIG_V2.notifyOnApprovalCreated),
    onlyNotifyBoardApprovals: asBoolean(record.onlyNotifyBoardApprovals, DEFAULT_COMPANY_CONFIG_V2.onlyNotifyBoardApprovals),
    errorsChatId: asString(record.errorsChatId),
    errorsTopicId: asString(record.errorsTopicId),
    notifyOnAgentError: asBoolean(record.notifyOnAgentError, DEFAULT_COMPANY_CONFIG_V2.notifyOnAgentError),
    notifyOnAgentRunStarted: asBoolean(record.notifyOnAgentRunStarted, DEFAULT_COMPANY_CONFIG_V2.notifyOnAgentRunStarted),
    notifyOnAgentRunFinished: asBoolean(record.notifyOnAgentRunFinished, DEFAULT_COMPANY_CONFIG_V2.notifyOnAgentRunFinished),
    digestChatId: asString(record.digestChatId),
    digestTopicId: asString(record.digestTopicId),
    digestMode: asDigestMode(record.digestMode),
    dailyDigestTime: asString(record.dailyDigestTime) || DEFAULT_COMPANY_CONFIG_V2.dailyDigestTime,
    bidailySecondTime: asString(record.bidailySecondTime) || DEFAULT_COMPANY_CONFIG_V2.bidailySecondTime,
    tridailyTimes: asString(record.tridailyTimes) || DEFAULT_COMPANY_CONFIG_V2.tridailyTimes,
    enableCommands: asBoolean(record.enableCommands, DEFAULT_COMPANY_CONFIG_V2.enableCommands),
    enableInbound: asBoolean(record.enableInbound, DEFAULT_COMPANY_CONFIG_V2.enableInbound),
    allowedTelegramUserIds: asStringArray(record.allowedTelegramUserIds),
    allowedTelegramChatIds: asStringArray(record.allowedTelegramChatIds),
    paperclipBoardApiTokenRef: asString(record.paperclipBoardApiTokenRef),
    transcriptionApiKeyRef: asString(record.transcriptionApiKeyRef),
    briefAgentId: asString(record.briefAgentId),
    briefAgentChatIds: asStringArray(record.briefAgentChatIds),
    escalationChatId: asString(record.escalationChatId),
    escalationTimeoutMs: asNumber(record.escalationTimeoutMs, DEFAULT_COMPANY_CONFIG_V2.escalationTimeoutMs),
    escalationDefaultAction: asEscalationDefaultAction(record.escalationDefaultAction),
    escalationHoldMessage: asString(record.escalationHoldMessage) || DEFAULT_COMPANY_CONFIG_V2.escalationHoldMessage,
    maxSuggestionsPerHourPerCompany: asNumber(record.maxSuggestionsPerHourPerCompany, DEFAULT_COMPANY_CONFIG_V2.maxSuggestionsPerHourPerCompany),
    watchDeduplicationWindowMs: asNumber(record.watchDeduplicationWindowMs, DEFAULT_COMPANY_CONFIG_V2.watchDeduplicationWindowMs),
  };
}

// --- Helpers ---

export function companyConfigStateKey(companyId: string): string {
  return `telegram.config.v2.${companyId}`;
}

export async function getCompanyConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<TelegramCompanyConfigV2 | null> {
  const raw = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: companyConfigStateKey(companyId),
  });
  if (raw == null) return null;
  return normalizeCompanyConfigV2(raw);
}

export async function saveCompanyConfig(
  ctx: PluginContext,
  companyId: string,
  patchOrFull: Partial<TelegramCompanyConfigV2>,
): Promise<void> {
  const existing = await getCompanyConfig(ctx, companyId);
  const next: TelegramCompanyConfigV2 = existing
    ? { ...existing, ...patchOrFull }
    : { ...DEFAULT_COMPANY_CONFIG_V2, ...patchOrFull };
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: companyConfigStateKey(companyId) },
    next,
  );
}

export function companyHasToken(config: TelegramCompanyConfigV2 | null): boolean {
  return config != null && config.telegramBotToken.trim().length > 0;
}

export function stripTokenFromCompanyConfig(
  config: TelegramCompanyConfigV2,
): TelegramCompanyConfigV2Public {
  const { telegramBotToken, ...rest } = config;
  return { ...rest, hasToken: companyHasToken(config) };
}

export function extractGlobalConfig(raw: unknown): TelegramGlobalConfig {
  const record = isRecord(raw) ? raw : {};
  return {
    paperclipBaseUrl: asString(record.paperclipBaseUrl) || "http://localhost:3100",
    paperclipPublicUrl: asString(record.paperclipPublicUrl),
  };
}
