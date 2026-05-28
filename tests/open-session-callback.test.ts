import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleOpenSessionCallback } from "../src/acp-bridge.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
    checkForumOrError: vi.fn(async () => true),
    createForumTopic: vi.fn(async () => ({ messageThreadId: 42, name: "Run abc12345" })),
  };
});

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
    agents: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "native-s1" }),
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
    },
    issues: {
      create: vi.fn().mockResolvedValue({ id: "issue-abc" }),
      update: vi.fn().mockResolvedValue({ id: "issue-abc" }),
    },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  vi.clearAllMocks();
});

describe("handleOpenSessionCallback — nova sessão", () => {
  it("retorna status 'created' e cria sessão quando runId é novo", async () => {
    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100111222", "agent-uuid-1234567890123456789012", "run-new-1");
    expect(result.status).toBe("created");
    if (result.status === "created") {
      expect(result.sessionId).toMatch(/^sess_/);
      expect(result.topicId).toBe(42);
    }
  });

  it("persiste mapeamento run_session_<runId> após criar sessão", async () => {
    const ctx = mockCtx();
    await handleOpenSessionCallback(ctx, "tok", "-100111222", "agent-uuid-1234567890123456789012", "run-persist-1");
    const stored = stateStore["run_session_run-persist-1"] as { sessionId: string; chatId: string; topicId: number } | undefined;
    expect(stored).toBeDefined();
    expect(stored!.chatId).toBe("-100111222");
    expect(stored!.topicId).toBe(42);
    expect(stored!.sessionId).toMatch(/^sess_/);
  });

  it("não persiste run_session_* quando runId é undefined", async () => {
    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100111222", "agent-uuid-1234567890123456789012", undefined);
    expect(result.status).toBe("created");
    const runSessionKeys = Object.keys(stateStore).filter((k) => k.startsWith("run_session_"));
    expect(runSessionKeys).toHaveLength(0);
  });

  it("envia card com link para o tópico criado", async () => {
    const ctx = mockCtx();
    await handleOpenSessionCallback(ctx, "tok", "-100333444", "agent-uuid-1234567890123456789012", "run-link-1");
    const card = sentMessages.find((m) => m.text.includes("t.me/c/"));
    expect(card).toBeDefined();
    expect(card!.text).toContain("333444"); // chatId sem prefixo -100
  });
});

describe("handleOpenSessionCallback — sessão já existente (deduplicação)", () => {
  const agentId = "agent-uuid-1234567890123456789012";
  const runId = "run-dup-1";

  beforeEach(() => {
    stateStore[`run_session_${runId}`] = {
      sessionId: "sess_existing_abc",
      chatId: "-100999888",
      topicId: 77,
    };
  });

  it("retorna status 'existing' quando runId já tem sessão mapeada", async () => {
    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100111222", agentId, runId);
    expect(result.status).toBe("existing");
  });

  it("retorna existingChatId e topicId corretos", async () => {
    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100111222", agentId, runId);
    if (result.status === "existing") {
      expect(result.existingChatId).toBe("-100999888");
      expect(result.topicId).toBe(77);
    }
  });

  it("não cria novo tópico quando runId já tem sessão", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    const ctx = mockCtx();
    await handleOpenSessionCallback(ctx, "tok", "-100111222", agentId, runId);
    expect(createForumTopic).not.toHaveBeenCalled();
  });

  it("não envia card quando sessão já existe", async () => {
    const ctx = mockCtx();
    await handleOpenSessionCallback(ctx, "tok", "-100111222", agentId, runId);
    expect(sentMessages).toHaveLength(0);
  });
});

describe("handleOpenSessionCallback — erro ao criar tópico", () => {
  it("retorna status 'error' quando createForumTopic lança exceção", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    (createForumTopic as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Sem permissão"));

    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100bad", "agent-uuid-1234567890123456789012", "run-err-1");
    expect(result.status).toBe("error");
  });

  it("retorna status 'error' quando checkForumOrError retorna false", async () => {
    const { checkForumOrError } = await import("../src/telegram-api.js");
    (checkForumOrError as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const ctx = mockCtx();
    const result = await handleOpenSessionCallback(ctx, "tok", "-100notforum", "agent-uuid-1234567890123456789012", "run-nonforum-1");
    expect(result.status).toBe("error");
  });

  it("não persiste run_session_* quando criação falha", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    (createForumTopic as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("fail"));

    const ctx = mockCtx();
    await handleOpenSessionCallback(ctx, "tok", "-100bad", "agent-uuid-1234567890123456789012", "run-fail-persist");
    expect(stateStore["run_session_run-fail-persist"]).toBeUndefined();
  });
});
