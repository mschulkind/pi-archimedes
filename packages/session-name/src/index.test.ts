import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const { complete, loadConfig } = vi.hoisted(() => ({
  complete: vi.fn(),
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete }));
vi.mock("@pi-archimedes/core/settings-io", () => ({ loadConfig }));

const { registerSessionName } = await import("./index.js");

type Handler = (event: any, ctx?: ExtensionContext) => unknown;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(existingName?: string) {
  const names: string[] = [];
  let existing = existingName;
  let stale = false;
  const handlers = new Map<string, Handler>();
  const assertLive = () => {
    if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
  };
  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    getSessionName: () => {
      assertLive();
      return existing;
    },
    setSessionName: (name: string) => {
      assertLive();
      names.push(name);
      existing = name;
      handlers.get("session_info_changed")?.({ type: "session_info_changed", name });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "the zai chip is broken again" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "the credential file moved out from under it" }] } },
      ],
      getSessionFile: () => "/tmp/session.jsonl",
    },
    model: { provider: "test", id: "test-model" },
    modelRegistry: {
      getAll: () => [{ provider: "test", id: "test-model" }],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
  } as unknown as ExtensionContext;

  registerSessionName(api);

  return {
    names,
    endTurn: async () => {
      await handlers.get("agent_end")?.({}, ctx);
      await settle();
    },
    setManualName: (name: string) => {
      existing = name;
      handlers.get("session_info_changed")?.({ type: "session_info_changed", name });
    },
    replaceSession: () => { stale = true; },
  };
}

describe("session naming", () => {
  let reported: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    complete.mockReset();
    loadConfig.mockReturnValue({});
    complete.mockResolvedValue({ content: [{ type: "text", text: "Fix a stale session ctx" }] });
    reported = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => reported.mockRestore());

  it("keeps the default recomputeEvery: 0 one-shot", async () => {
    const { names, endTurn } = harness();

    await endTurn();
    await endTurn();
    await endTurn();

    expect(names).toEqual(["Fix a stale session ctx"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("leaves a name the user set by hand alone", async () => {
    const { names, endTurn } = harness("Hand-picked");

    await endTurn();

    expect(names).toEqual([]);
    expect(reported).not.toHaveBeenCalled();
  });

  it("recomputes on the configured Nth completed exchange and not before", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 3 });
    const { names, endTurn } = harness();

    await endTurn();
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(1);
    await endTurn();

    expect(names).toEqual(["Fix a stale session ctx", "Fix a stale session ctx"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("never replaces a manual name at any cadence", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    const naming = harness();

    await naming.endTurn();
    naming.setManualName("Hand-picked");
    await naming.endTurn();
    await naming.endTurn();

    expect(naming.names).toEqual(["Fix a stale session ctx"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("drops the title without reporting an error when the session moved on", async () => {
    const naming = harness();
    complete.mockImplementation(async () => {
      naming.replaceSession();
      return { content: [{ type: "text", text: "Fix a stale session ctx" }] };
    });

    await naming.endTurn();

    expect(naming.names).toEqual([]);
    expect(reported).not.toHaveBeenCalled();
  });

  it("does not start a second title call while one is in flight", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    let resolveComplete!: (value: unknown) => void;
    complete.mockReturnValue(new Promise((resolve) => { resolveComplete = resolve; }));
    const { endTurn, names } = harness();

    await endTurn();
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(1);

    resolveComplete({ content: [{ type: "text", text: "Eventually named" }] });
    await settle();
    expect(names).toEqual(["Eventually named"]);
  });

  it("gives up after three failed title attempts", async () => {
    complete.mockRejectedValue(new Error("provider failed"));
    const { endTurn } = harness();

    await endTurn();
    await endTurn();
    await endTurn();
    await endTurn();

    expect(complete).toHaveBeenCalledTimes(3);
    expect(reported).toHaveBeenCalledTimes(3);
  });
});
