import { describe, it, expect } from "vitest";
import {
  normalizeCompanyConfigV2,
  extractGlobalConfig,
  companyHasToken,
  stripTokenFromCompanyConfig,
  DEFAULT_COMPANY_CONFIG_V2,
} from "../src/company-config.js";

describe("normalizeCompanyConfigV2", () => {
  it("returns defaults for null input", () => {
    const result = normalizeCompanyConfigV2(null);
    expect(result.telegramBotToken).toBe("");
    expect(result.defaultChatId).toBe("");
    expect(result.topicRouting).toBe(false);
    expect(result.notifyOnIssueCreated).toBe(true);
    expect(result.digestMode).toBe("off");
    expect(result.maxAgentsPerThread).toBe(5);
    expect(result.escalationTimeoutMs).toBe(900_000);
  });

  it("returns defaults for empty object", () => {
    const result = normalizeCompanyConfigV2({});
    expect(result).toEqual(DEFAULT_COMPANY_CONFIG_V2);
  });

  it("preserves valid fields and coerces invalid ones", () => {
    const raw = {
      telegramBotToken: "my-secret-token",
      defaultChatId: "-100123456",
      topicRouting: "yes",
      maxAgentsPerThread: "not-a-number",
      notifyOnIssueCreated: 1,
      digestMode: "daily",
      dailyDigestTime: "08:00",
      allowedTelegramUserIds: ["123", null, "456"],
      allowedTelegramChatIds: "should-be-array",
    };
    const result = normalizeCompanyConfigV2(raw);
    expect(result.telegramBotToken).toBe("my-secret-token");
    expect(result.defaultChatId).toBe("-100123456");
    expect(result.topicRouting).toBe(false); // coerced from string
    expect(result.maxAgentsPerThread).toBe(5); // fallback
    expect(result.notifyOnIssueCreated).toBe(true); // truthy number
    expect(result.digestMode).toBe("daily");
    expect(result.dailyDigestTime).toBe("08:00");
    expect(result.allowedTelegramUserIds).toEqual(["123", "456"]);
    expect(result.allowedTelegramChatIds).toEqual([]); // invalid array
  });

  it("normalizes booleans correctly", () => {
    expect(normalizeCompanyConfigV2({ notifyOnIssueDone: false }).notifyOnIssueDone).toBe(false);
    expect(normalizeCompanyConfigV2({ notifyOnIssueDone: true }).notifyOnIssueDone).toBe(true);
    expect(normalizeCompanyConfigV2({ notifyOnIssueDone: undefined }).notifyOnIssueDone).toBe(true);
  });

  it("normalizes escalation default action", () => {
    expect(normalizeCompanyConfigV2({ escalationDefaultAction: "auto_reply" }).escalationDefaultAction).toBe("auto_reply");
    expect(normalizeCompanyConfigV2({ escalationDefaultAction: "invalid" }).escalationDefaultAction).toBe("defer");
  });

  it("never includes non-V2 fields", () => {
    const raw = { unknownField: "value", telegramBotToken: "tok" };
    const result = normalizeCompanyConfigV2(raw);
    expect(result).not.toHaveProperty("unknownField");
  });
});

describe("extractGlobalConfig", () => {
  it("extracts URLs with defaults", () => {
    expect(extractGlobalConfig(null)).toEqual({
      paperclipBaseUrl: "http://localhost:3100",
      paperclipPublicUrl: "",
    });
  });

  it("extracts provided URLs", () => {
    expect(extractGlobalConfig({
      paperclipBaseUrl: "https://api.example.com",
      paperclipPublicUrl: "https://app.example.com",
    })).toEqual({
      paperclipBaseUrl: "https://api.example.com",
      paperclipPublicUrl: "https://app.example.com",
    });
  });

  it("ignores unrelated fields", () => {
    const result = extractGlobalConfig({
      paperclipBaseUrl: "http://localhost:3200",
      telegramBotToken: "secret",
    });
    expect(result).toEqual({
      paperclipBaseUrl: "http://localhost:3200",
      paperclipPublicUrl: "",
    });
  });
});

describe("companyHasToken", () => {
  it("returns false for null", () => {
    expect(companyHasToken(null)).toBe(false);
  });

  it("returns false for empty token", () => {
    expect(companyHasToken({ ...DEFAULT_COMPANY_CONFIG_V2, telegramBotToken: "" })).toBe(false);
    expect(companyHasToken({ ...DEFAULT_COMPANY_CONFIG_V2, telegramBotToken: "   " })).toBe(false);
  });

  it("returns true for non-empty token", () => {
    expect(companyHasToken({ ...DEFAULT_COMPANY_CONFIG_V2, telegramBotToken: "abc123" })).toBe(true);
  });
});

describe("stripTokenFromCompanyConfig", () => {
  it("removes token and adds hasToken flag", () => {
    const config = { ...DEFAULT_COMPANY_CONFIG_V2, telegramBotToken: "secret" };
    const publicConfig = stripTokenFromCompanyConfig(config);
    expect(publicConfig).not.toHaveProperty("telegramBotToken");
    expect(publicConfig.hasToken).toBe(true);
    expect(publicConfig.defaultChatId).toBe(config.defaultChatId);
  });

  it("hasToken false when token is empty", () => {
    const config = { ...DEFAULT_COMPANY_CONFIG_V2, telegramBotToken: "" };
    const publicConfig = stripTokenFromCompanyConfig(config);
    expect(publicConfig.hasToken).toBe(false);
  });
});
