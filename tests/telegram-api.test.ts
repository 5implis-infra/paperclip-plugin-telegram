import { describe, it, expect, vi } from "vitest";
import { escapeMarkdownV2, truncateAtWord, createForumTopic, checkForumOrError } from "../src/telegram-api.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

function mockCtx(fetchImpl?: ReturnType<typeof vi.fn>): PluginContext {
  return {
    http: { fetch: fetchImpl ?? vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn() },
  } as unknown as PluginContext;
}

describe("escapeMarkdownV2", () => {
  it("escapes underscores", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
  });

  it("escapes asterisks", () => {
    expect(escapeMarkdownV2("*bold*")).toBe("\\*bold\\*");
  });

  it("escapes brackets", () => {
    expect(escapeMarkdownV2("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  it("escapes backticks", () => {
    expect(escapeMarkdownV2("`code`")).toBe("\\`code\\`");
  });

  it("escapes tildes", () => {
    expect(escapeMarkdownV2("~strikethrough~")).toBe("\\~strikethrough\\~");
  });

  it("escapes hashes", () => {
    expect(escapeMarkdownV2("#heading")).toBe("\\#heading");
  });

  it("escapes plus signs", () => {
    expect(escapeMarkdownV2("a+b")).toBe("a\\+b");
  });

  it("escapes hyphens", () => {
    expect(escapeMarkdownV2("a-b")).toBe("a\\-b");
  });

  it("escapes equal signs", () => {
    expect(escapeMarkdownV2("a=b")).toBe("a\\=b");
  });

  it("escapes pipes", () => {
    expect(escapeMarkdownV2("a|b")).toBe("a\\|b");
  });

  it("escapes curly braces", () => {
    expect(escapeMarkdownV2("{a}")).toBe("\\{a\\}");
  });

  it("escapes dots", () => {
    expect(escapeMarkdownV2("a.b")).toBe("a\\.b");
  });

  it("escapes exclamation marks", () => {
    expect(escapeMarkdownV2("hello!")).toBe("hello\\!");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });

  it("escapes greater than", () => {
    expect(escapeMarkdownV2("a>b")).toBe("a\\>b");
  });

  it("handles multiple special chars in one string", () => {
    expect(escapeMarkdownV2("PROJ-42: Fix [bug] #1"))
      .toBe("PROJ\\-42: Fix \\[bug\\] \\#1");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdownV2("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("truncateAtWord", () => {
  it("returns text unchanged if shorter than max", () => {
    expect(truncateAtWord("hello", 10)).toBe("hello");
  });

  it("returns text unchanged if equal to max", () => {
    expect(truncateAtWord("hello", 5)).toBe("hello");
  });

  it("truncates at word boundary and adds ellipsis", () => {
    const result = truncateAtWord("hello world foo bar baz", 15);
    expect(result).toBe("hello world...");
  });

  it("falls back to hard cut when no good word boundary", () => {
    const result = truncateAtWord("abcdefghijklmnopqrstuvwxyz", 10);
    expect(result).toBe("abcdefghij...");
    expect(result.length).toBe(13);
  });

  it("handles single word longer than max", () => {
    const result = truncateAtWord("superlongword", 5);
    expect(result).toBe("super...");
  });

  it("handles text with trailing space at boundary", () => {
    const result = truncateAtWord("aa bb cc dd ee ff", 8);
    expect(result).toBe("aa bb cc...");
  });
});

describe("createForumTopic", () => {
  it("creates a forum topic and returns messageThreadId and name", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_thread_id: 42, name: "Run abc123" } }),
    });
    const ctx = mockCtx(fetch);
    const result = await createForumTopic(ctx, "tok", "-100123", "Run abc123");
    expect(result).toEqual({ messageThreadId: 42, name: "Run abc123" });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/createForumTopic"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("passes iconEmojiId when provided", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, result: { message_thread_id: 7, name: "Session" } }),
    });
    const ctx = mockCtx(fetch);
    await createForumTopic(ctx, "tok", "-100123", "Session", "5368324170671202286");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.icon_emoji_id).toBe("5368324170671202286");
  });

  it("throws a friendly error when chat is not a forum supergroup", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error_code: 400, description: "Bad Request: chat is not a supergroup" }),
    });
    const ctx = mockCtx(fetch);
    await expect(createForumTopic(ctx, "tok", "123", "Test")).rejects.toThrow("tópicos");
  });

  it("throws a friendly error when bot lacks admin permissions", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error_code: 403, description: "Forbidden: bot is not a member" }),
    });
    const ctx = mockCtx(fetch);
    await expect(createForumTopic(ctx, "tok", "123", "Test")).rejects.toThrow("permissão");
  });

  it("throws generic error for unknown API failures", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error_code: 500, description: "Internal Server Error" }),
    });
    const ctx = mockCtx(fetch);
    await expect(createForumTopic(ctx, "tok", "123", "Test")).rejects.toThrow("Internal Server Error");
  });
});

describe("checkForumOrError", () => {
  it("returns true and does not send a message when chat is a forum", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        // getChat response
        json: () => Promise.resolve({ ok: true, result: { is_forum: true } }),
      });
    const ctx = mockCtx(fetch);
    const result = await checkForumOrError(ctx, "tok", "-100123");
    expect(result).toBe(true);
    // sendMessage should NOT have been called (only getChat was called)
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain("getChat");
  });

  it("returns false and sends error message when chat is not a forum", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        // getChat response
        json: () => Promise.resolve({ ok: true, result: { is_forum: false } }),
      })
      .mockResolvedValueOnce({
        // sendMessage response
        json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
      });
    const ctx = mockCtx(fetch);
    // Use a unique chatId so it bypasses the in-memory forum cache
    const result = await checkForumOrError(ctx, "tok", "-100not-forum-1");
    expect(result).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    const sendBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(sendBody.text).toMatch(/forum/i);
  });

  it("passes messageThreadId when provided", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, result: { is_forum: false } }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ ok: true, result: { message_id: 1 } }),
      });
    const ctx = mockCtx(fetch);
    // Use a unique chatId so it bypasses the in-memory forum cache
    await checkForumOrError(ctx, "tok", "-100not-forum-2", 42);
    const sendBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(sendBody.message_thread_id).toBe(42);
  });
});
