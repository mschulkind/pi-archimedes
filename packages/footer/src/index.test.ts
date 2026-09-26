import { describe, expect, it } from "vitest";
import { stripAnsi } from "@pi-archimedes/core/text";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerFooter } from "./index.js";

describe("custom footer rendering", () => {
  it("keeps session name, latest prompt cache hit and OR status with the provider/model", () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    let factory: any;
    const pi = {
      on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
      getThinkingLevel: () => "medium",
    } as any;
    const ctx = {
      ui: { setFooter: (next: unknown) => { factory = next; } },
      model: { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 266_000 },
      sessionManager: {
        getSessionName: () => "School Series Friends' Grand Entrance",
        getEntries: () => [{ type: "message", message: {
          role: "assistant",
          usage: { input: 750, output: 100, cacheRead: 250, cacheWrite: 0, cost: { total: 0.01 } },
        } }],
      },
      getContextUsage: () => ({ percent: 5, contextWindow: 266_000 }),
    } as any;
    registerFooter(pi);
    handlers.get("session_start")?.({}, ctx);
    expect(factory).toBeTypeOf("function");
    const component = factory(
      { requestRender() {} },
      { fg: (_token: string, value: string) => value },
      { onBranchChange: () => () => {}, getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([["or-route", "OR 6h: Tog 2 · cache 25%"]]) },
    );
    const text = stripAnsi(component.render(300).join("\n"));
    expect(text).toContain("School Series Friends' Grand Entrance");
    expect(text).toContain("openai-codex/gpt-6-sol");
    expect(text).toContain("CH25.0%");
    expect(text).toContain("│ OR 6h: Tog 2 · cache 25%");
    component.dispose?.();
    handlers.get("session_shutdown")?.({}, ctx);
  });

  it("compresses MCP status and keeps a short bar on wrapped lines", () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    let factory: any;
    const pi = {
      on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
      getThinkingLevel: () => "high",
    } as any;
    const ctx = {
      ui: { setFooter: (next: unknown) => { factory = next; } },
      model: { provider: "openai-codex", id: "gpt-6-sol", contextWindow: 266_000 },
      sessionManager: { getSessionName: () => "Researching Rock Electronic Keys Plugins", getEntries: () => [] },
      getContextUsage: () => ({ percent: 62, contextWindow: 266_000 }),
    } as any;
    registerFooter(pi);
    handlers.get("session_start")?.({}, ctx);
    const statuses = new Map([["mcp", "🔌 MCP: 1 server enabled"]]);
    const component = factory(
      { requestRender() {} },
      { fg: (_token: string, value: string) => value },
      { onBranchChange: () => () => {}, getGitBranch: () => "master",
        getExtensionStatuses: () => statuses },
    );
    const lines = component.render(100).map(stripAnsi);
    expect(lines.join(" ")).toContain("master");
    expect(lines.join(" ")).toContain("MCP 1");
    expect(lines.join(" ")).not.toContain("server enabled");
    expect(lines.every((line: string) => visibleWidth(line) <= 100)).toBe(true);
    expect(lines.at(-1)).toMatch(/━{1,24} 62%$/);
    expect(visibleWidth(lines.at(-1)!)).toBeLessThan(100);
    statuses.set("mcp", "\u001b[32m🔌 MCP: 12 servers enabled\u001b[0m");
    expect(component.render(100).map(stripAnsi).join(" ")).toContain("MCP 12");
    component.dispose?.();
    handlers.get("session_shutdown")?.({}, ctx);
  });
});
