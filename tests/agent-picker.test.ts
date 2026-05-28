import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAgentPickerContent,
  sendAgentPickerPage,
  spawnAgentSessionById,
  closeSessionById,
  cancelSessionById,
} from "../src/acp-bridge.js";
import { handleAcpCommand } from "../src/acp-bridge.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<unknown> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 42;
    }),
    sendChatAction: vi.fn(),
    checkForumOrError: vi.fn(async () => true),
    createForumTopic: vi.fn(async () => ({ messageThreadId: 55, name: "Agent Session" })),
    isForum: vi.fn(async () => true),
  };
});

const AGENTS = [
  { id: "uuid-a1", agentId: "uuid-a1", name: "Builder", status: "active" },
  { id: "uuid-a2", agentId: "uuid-a2", name: "Tester", status: "active" },
  { id: "uuid-a3", agentId: "uuid-a3", name: "Reporter", status: "inactive" },
];

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => { stateStore[key.stateKey] = value; }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      emit: vi.fn((...args: unknown[]) => { emittedEvents.push(args); }),
      on: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue(AGENTS),
      get: vi.fn().mockResolvedValue(null),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "native-s1" }),
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
    },
    issues: {
      create: vi.fn().mockResolvedValue({ id: "issue-1" }),
      update: vi.fn().mockResolvedValue({ id: "issue-1" }),
    },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
  vi.clearAllMocks();
});

// --- 3.1: buildAgentPickerContent ---

describe("buildAgentPickerContent", () => {
  it("returns active agents only by default (showAll: false)", async () => {
    const ctx = mockCtx();
    const { text, keyboard } = await buildAgentPickerContent(ctx, "company-1", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
    });
    expect(text).toContain("Agentes ativos");
    // 2 active agents → 2 buttons (Builder, Tester)
    const agentRows = keyboard.filter((row) => row.length === 1 && row[0]!.callback_data.startsWith("acp_spawn_sel_"));
    expect(agentRows).toHaveLength(2);
  });

  it("returns all agents when showAll: true", async () => {
    const ctx = mockCtx();
    const { keyboard } = await buildAgentPickerContent(ctx, "company-1", {
      page: 0,
      showAll: true,
      callbackPrefix: "acp_spawn",
    });
    const agentRows = keyboard.filter((row) => row.length === 1 && row[0]!.callback_data.startsWith("acp_spawn_sel_"));
    expect(agentRows).toHaveLength(3); // 2 active + 1 inactive
  });

  it("includes 'Ver todos' nav button when showAll is false and there are inactive agents", async () => {
    const ctx = mockCtx();
    const { keyboard } = await buildAgentPickerContent(ctx, "company-1", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
    });
    const navRow = keyboard.find((row) => row.some((b) => b.callback_data.includes("_all_")));
    expect(navRow).toBeDefined();
    expect(navRow!.find((b) => b.callback_data === "acp_spawn_all_0")).toBeDefined();
  });

  it("paginates correctly — page 0 of 2", async () => {
    const manyAgents = Array.from({ length: 10 }, (_, i) => ({
      id: `id-${i}`, agentId: `id-${i}`, name: `Agent${i}`, status: "active",
    }));
    const ctx = mockCtx();
    (ctx.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue(manyAgents);

    const { keyboard: kb0 } = await buildAgentPickerContent(ctx, "co", { page: 0, showAll: false, callbackPrefix: "p" });
    const agentRows0 = kb0.filter((r) => r.some((b) => b.callback_data.startsWith("p_sel_")));
    expect(agentRows0).toHaveLength(8); // PICKER_PAGE_SIZE

    const navRow = kb0.find((r) => r.some((b) => b.callback_data.includes("_page_")));
    expect(navRow).toBeDefined();
    expect(navRow!.some((b) => b.callback_data === "p_page_1")).toBe(true);
  });

  it("active agents are sorted alphabetically", async () => {
    const ctx = mockCtx();
    const { keyboard } = await buildAgentPickerContent(ctx, "company-1", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
    });
    const names = keyboard
      .filter((row) => row.length === 1 && row[0]!.callback_data.startsWith("acp_spawn_sel_"))
      .map((row) => row[0]!.text);
    expect(names[0]).toContain("Builder");
    expect(names[1]).toContain("Tester");
  });

  it("callback_data uses agentId field when available", async () => {
    const ctx = mockCtx();
    const { keyboard } = await buildAgentPickerContent(ctx, "company-1", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
    });
    const firstAgentBtn = keyboard.find((row) => row.length === 1 && row[0]!.callback_data.startsWith("acp_spawn_sel_"))?.[0];
    expect(firstAgentBtn?.callback_data).toBe("acp_spawn_sel_uuid-a1");
  });

  it("handles no agents gracefully", async () => {
    const ctx = mockCtx();
    (ctx.agents.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { text, keyboard } = await buildAgentPickerContent(ctx, "co", { page: 0, showAll: false, callbackPrefix: "p" });
    expect(text).toContain("Nenhum agente");
    expect(keyboard).toHaveLength(0);
  });
});

// --- 3.1: sendAgentPickerPage ---

describe("sendAgentPickerPage", () => {
  it("sends a message with inline keyboard", async () => {
    const ctx = mockCtx();
    await sendAgentPickerPage(ctx, "tok", "-100abc", "co", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
      messageThreadId: 5,
    });
    expect(sentMessages).toHaveLength(1);
    const opts = sentMessages[0]!.options as Record<string, unknown>;
    expect(opts.messageThreadId).toBe(5);
    expect(opts.inlineKeyboard).toBeDefined();
  });

  it("saves picker context to state", async () => {
    const ctx = mockCtx();
    await sendAgentPickerPage(ctx, "tok", "-100abc", "co-1", {
      page: 0,
      showAll: false,
      callbackPrefix: "acp_spawn",
      messageThreadId: 7,
    });
    const saved = stateStore["picker_ctx_-100abc_acp_spawn"] as Record<string, unknown>;
    expect(saved).toBeDefined();
    expect(saved.messageThreadId).toBe(7);
    expect(saved.companyId).toBe("co-1");
  });
});

// --- 3.2: /acp spawn without args → picker ---

describe("/acp spawn without args shows picker", () => {
  it("shows picker instead of usage message when no agent name given", async () => {
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "tok", "-100grp", "spawn", 42, "co-1");
    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0]!;
    expect(msg.text).toContain("Agentes ativos");
    const opts = msg.options as Record<string, unknown>;
    expect(opts.inlineKeyboard).toBeDefined();
  });

  it("aborts if chat is not a forum", async () => {
    const { checkForumOrError } = await import("../src/telegram-api.js");
    (checkForumOrError as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "tok", "-100grp", "spawn", 42, "co-1");
    // checkForumOrError already sends the error message — no picker should be sent
    const pickerMsg = sentMessages.find((m) => m.text.includes("Agentes ativos"));
    expect(pickerMsg).toBeUndefined();
  });
});

// --- 3.2: spawnAgentSessionById ---

describe("spawnAgentSessionById", () => {
  it("resolves agent name and spawns in existing thread", async () => {
    stateStore["sessions_-100g_42"] = [];
    const ctx = mockCtx();
    await spawnAgentSessionById(ctx, "tok", "-100g", "uuid-a1", "co-1", 42);
    const session = sentMessages.find((m) => m.text.includes("Agent Session Started"));
    expect(session).toBeDefined();
    const savedSessions = stateStore["sessions_-100g_42"] as unknown[];
    expect(savedSessions).toHaveLength(1);
  });

  it("creates a new forum topic when no messageThreadId given", async () => {
    const { createForumTopic } = await import("../src/telegram-api.js");
    const ctx = mockCtx();
    await spawnAgentSessionById(ctx, "tok", "-100g", "uuid-a1", "co-1");
    expect(createForumTopic).toHaveBeenCalled();
    // Should send link card + spawn confirmation
    expect(sentMessages.some((m) => m.text.includes("t.me/c/"))).toBe(true);
    expect(sentMessages.some((m) => m.text.includes("Agent Session Started"))).toBe(true);
  });
});

// --- closeSessionById / cancelSessionById ---

describe("closeSessionById", () => {
  it("returns false when session_idx not found", async () => {
    const ctx = mockCtx();
    const ok = await closeSessionById(ctx, "tok", "sess-unknown", "co-1");
    expect(ok).toBe(false);
  });

  it("closes native session and marks it closed", async () => {
    const sessionId = "sess-close-1";
    stateStore[`session_idx_${sessionId}`] = { chatId: "-100g", topicId: 10 };
    stateStore["sessions_-100g_10"] = [{
      sessionId,
      transport: "native",
      status: "active",
      agentId: "a1",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];
    const ctx = mockCtx();
    const ok = await closeSessionById(ctx, "tok", sessionId, "co-1");
    expect(ok).toBe(true);
    expect(ctx.agents.sessions.close).toHaveBeenCalledWith(sessionId, "co-1");
    const updated = stateStore["sessions_-100g_10"] as Array<{ status: string }>;
    expect(updated[0]!.status).toBe("closed");
  });

  it("emits cancel event for ACP session", async () => {
    const sessionId = "sess-acp-1";
    stateStore[`session_idx_${sessionId}`] = { chatId: "-100g", topicId: 20 };
    stateStore["sessions_-100g_20"] = [{
      sessionId,
      transport: "acp",
      status: "active",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];
    const ctx = mockCtx();
    await closeSessionById(ctx, "tok", sessionId, "co-2");
    expect(ctx.events.emit).toHaveBeenCalled();
  });
});

describe("cancelSessionById", () => {
  it("returns false when session_idx not found", async () => {
    const ctx = mockCtx();
    const ok = await cancelSessionById(ctx, "co-1", "sess-unknown");
    expect(ok).toBe(false);
  });

  it("returns true and emits cancel for ACP session", async () => {
    const sessionId = "sess-cancel-1";
    stateStore[`session_idx_${sessionId}`] = { chatId: "-100g", topicId: 30 };
    stateStore["sessions_-100g_30"] = [{
      sessionId,
      transport: "acp",
      status: "active",
      spawnedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];
    const ctx = mockCtx();
    const ok = await cancelSessionById(ctx, "co-1", sessionId);
    expect(ok).toBe(true);
    expect(ctx.events.emit).toHaveBeenCalled();
  });
});
