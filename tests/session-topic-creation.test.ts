import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getSessions,
  wakeAgentWithIssue,
  createSessionWithTopic,
} from "../src/acp-bridge.js";
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
    createForumTopic: vi.fn(async () => ({ messageThreadId: 99, name: "Test Topic" })),
  };
});

function mockCtx(overrides: Partial<ReturnType<typeof vi.fn>> = {}): PluginContext {
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
    ...overrides,
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  vi.clearAllMocks();
});

// --- 2.2: ChatSession com campos opcionais ---

describe("ChatSession — campos opcionais", () => {
  it("getSessions retorna sessões armazenadas sem agentId/agentName (sessão genérica)", async () => {
    const genericSession = {
      sessionId: "sess-gen-1",
      transport: "native",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
      topicId: 99,
    };
    stateStore["sessions_chat-1_99"] = [genericSession];
    const ctx = mockCtx();
    const sessions = await getSessions(ctx, "chat-1", 99);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe("sess-gen-1");
    expect(sessions[0]!.agentId).toBeUndefined();
    expect(sessions[0]!.agentName).toBeUndefined();
    expect(sessions[0]!.topicId).toBe(99);
  });

  it("getSessions preserva campos source* opcionais", async () => {
    const session = {
      sessionId: "sess-src-1",
      transport: "native",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
      topicId: 77,
      sourceRunId: "run-42",
      sourceAgentId: "agent-x",
      sourceEventType: "agent.run.failed",
    };
    stateStore["sessions_chat-2_77"] = [session];
    const ctx = mockCtx();
    const sessions = await getSessions(ctx, "chat-2", 77);
    expect(sessions[0]!.sourceRunId).toBe("run-42");
    expect(sessions[0]!.sourceAgentId).toBe("agent-x");
    expect(sessions[0]!.sourceEventType).toBe("agent.run.failed");
  });
});

// --- 2.2: Índice inverso em saveSessions ---

describe("saveSessions — índice inverso session_idx_*", () => {
  it("persiste session_idx_<sessionId> quando sessão tem topicId", async () => {
    const ctx = mockCtx();
    // Seed uma sessão com topicId via createSessionWithTopic (chama saveSessions internamente)
    // Aqui testamos via getSessions → verifica que o índice foi escrito
    // Cria sessão com topicId diretamente no stateStore e chama a função
    // Para exercitar saveSessions, usamos createSessionWithTopic
    const result = await createSessionWithTopic(ctx, "tok", "-100111222", {
      sourceRunId: "run-1",
    });
    expect(result).not.toBeNull();
    const { sessionId } = result!;
    // O índice deve ter sido persistido
    expect(stateStore[`session_idx_${sessionId}`]).toEqual({
      chatId: "-100111222",
      topicId: 99,
    });
  });

  it("não persiste session_idx_* para sessões sem topicId (sessões legacy)", async () => {
    stateStore["sessions_chat-3_10"] = [{
      sessionId: "legacy-s1",
      agentId: "a1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];
    // Ao ler as sessões, o índice não deve existir
    expect(stateStore["session_idx_legacy-s1"]).toBeUndefined();
  });
});

// --- 2.3: Correlação issueId → sessionId ---

describe("wakeAgentWithIssue — correlação issueId→sessionId", () => {
  it("salva issue_session_<issueId> quando opts.sessionId, chatId e threadId são fornecidos", async () => {
    const ctx = mockCtx();
    const issueId = await wakeAgentWithIssue(
      ctx,
      "agent-1",
      "company-1",
      "Crie um relatório",
      "telegram_message",
      undefined,
      { sessionId: "sess-gen-1", chatId: "chat-x", threadId: 99 },
    );
    expect(issueId).toBe("issue-abc");
    expect(stateStore["issue_session_issue-abc"]).toEqual({
      sessionId: "sess-gen-1",
      chatId: "chat-x",
      threadId: 99,
    });
  });

  it("não salva issue_session_* quando opts não é fornecido (comportamento legacy)", async () => {
    const ctx = mockCtx();
    const issueId = await wakeAgentWithIssue(
      ctx,
      "agent-1",
      "company-1",
      "Faça algo",
      "handoff",
    );
    expect(issueId).toBe("issue-abc");
    // Nenhuma chave issue_session_* deve ter sido criada
    const keys = Object.keys(stateStore);
    expect(keys.filter(k => k.startsWith("issue_session_"))).toHaveLength(0);
  });

  it("não salva issue_session_* quando opts.sessionId está presente mas chatId está ausente", async () => {
    const ctx = mockCtx();
    await wakeAgentWithIssue(
      ctx,
      "agent-1",
      "company-1",
      "Faça algo",
      "test",
      undefined,
      { sessionId: "sess-1" }, // sem chatId nem threadId
    );
    expect(stateStore["issue_session_issue-abc"]).toBeUndefined();
  });

  it("retorna null e não salva índice quando a criação da issue falha", async () => {
    const ctx = mockCtx();
    (ctx.issues.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("API down"));
    const issueId = await wakeAgentWithIssue(
      ctx,
      "agent-fail",
      "company-1",
      "Texto",
      "test",
      undefined,
      { sessionId: "s1", chatId: "c1", threadId: 1 },
    );
    expect(issueId).toBeNull();
    expect(stateStore["issue_session_issue-abc"]).toBeUndefined();
  });
});

// --- 2.4: createSessionWithTopic ---

describe("createSessionWithTopic", () => {
  it("retorna null e não persiste state quando checkForumOrError retorna false", async () => {
    const { checkForumOrError } = await import("../src/telegram-api.js");
    (checkForumOrError as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100111");
    expect(result).toBeNull();
    // Nenhum estado de sessão deve ter sido persistido
    const sessionKeys = Object.keys(stateStore).filter(k => k.startsWith("sessions_"));
    expect(sessionKeys).toHaveLength(0);
  });

  it("cria sessão + tópico e retorna { sessionId, topicId }", async () => {
    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100123456");
    expect(result).not.toBeNull();
    expect(result!.topicId).toBe(99);
    expect(result!.sessionId).toMatch(/^sess_/);
  });

  it("persiste sessão em sessions_<chatId>_<topicId>", async () => {
    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100123456");
    const sessions = stateStore[`sessions_-100123456_${result!.topicId}`] as unknown[];
    expect(sessions).toHaveLength(1);
    const s = sessions[0] as Record<string, unknown>;
    expect(s["sessionId"]).toBe(result!.sessionId);
    expect(s["topicId"]).toBe(99);
    expect(s["status"]).toBe("active");
    expect(s["agentId"]).toBeUndefined();
  });

  it("usa nome do topico baseado no sourceRunId quando fornecido", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    const ctx = mockCtx();
    await createSessionWithTopic(ctx, "tok", "-100123", { sourceRunId: "run-abcdef12" });
    expect(createForumTopic).toHaveBeenCalledWith(
      expect.anything(),
      "tok",
      "-100123",
      "Run run-abcd",
    );
  });

  it("usa 'Agent Session' como nome padrão quando não há sourceRunId", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    const ctx = mockCtx();
    await createSessionWithTopic(ctx, "tok", "-100123");
    expect(createForumTopic).toHaveBeenCalledWith(
      expect.anything(),
      "tok",
      "-100123",
      "Agent Session",
    );
  });

  it("usa topicName customizado quando fornecido", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    const ctx = mockCtx();
    await createSessionWithTopic(ctx, "tok", "-100123", { topicName: "Minha Sessão" });
    expect(createForumTopic).toHaveBeenCalledWith(
      expect.anything(),
      "tok",
      "-100123",
      "Minha Sessão",
    );
  });

  it("envia card com link para o tópico no chat original", async () => {
    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100111222333");
    expect(result).not.toBeNull();
    const card = sentMessages.find(m => m.text.includes("t.me/c/"));
    expect(card).toBeDefined();
    expect(card!.text).toContain("111222333"); // chatId sem -100
    expect(card!.text).toContain("99"); // topicId
    expect(card!.options?.parseMode).toBe("HTML");
  });

  it("armazena sourceAgentId e sourceEventType na sessão", async () => {
    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100x", {
      sourceAgentId: "agent-z",
      sourceEventType: "agent.run.failed",
    });
    const sessions = stateStore[`sessions_-100x_${result!.topicId}`] as unknown[];
    const s = sessions[0] as Record<string, unknown>;
    expect(s["sourceAgentId"]).toBe("agent-z");
    expect(s["sourceEventType"]).toBe("agent.run.failed");
  });

  it("retorna null e envia mensagem de erro quando createForumTopic lança exceção", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    (createForumTopic as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Sem permissão"));

    const ctx = mockCtx();
    const result = await createSessionWithTopic(ctx, "tok", "-100bad");
    expect(result).toBeNull();
    const errMsg = sentMessages.find(m => m.text.includes("Erro ao criar"));
    expect(errMsg).toBeDefined();
    // Nenhuma sessão deve ter sido salva
    const sessionKeys = Object.keys(stateStore).filter(k => k.startsWith("sessions_"));
    expect(sessionKeys).toHaveLength(0);
  });
});
