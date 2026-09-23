import { describe, expect, it } from "vitest";
import { formatModelLabel } from "./model-label.js";

describe("footer model label", () => {
  it("shows the active Pi provider beside the model", () => {
    expect(formatModelLabel({ provider: "openai-codex", id: "gpt-6-sol" })).toBe("openai-codex/gpt-6-sol");
    expect(formatModelLabel({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" })).toBe("openrouter/deepseek/deepseek-v4.1-flash");
  });

  it("does not invent a provider when there is no active model", () => {
    expect(formatModelLabel(undefined)).toBe("no-model");
  });
});
