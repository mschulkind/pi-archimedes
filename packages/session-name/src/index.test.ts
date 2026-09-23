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

function harness(existingName?: string, hasAuth: () => boolean = () => true) {
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
      hasConfiguredAuth: hasAuth,
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

  afterEach(() => {
    reported.mockRestore();
    vi.restoreAllMocks();
  });

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

  it("recomputes after N further completed exchanges, not N total", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 3 });
    const { names, endTurn } = harness();

    await endTurn();
    await endTurn();
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(1);
    await endTurn();

    expect(names).toEqual(["Fix a stale session ctx", "Fix a stale session ctx"]);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("waits for both five exchanges and one hour, retrying on the next exchange after the hour", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 5, minRecomputeMinutes: 60 });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { endTurn } = harness();

    await endTurn(); // first title, immediately
    expect(complete).toHaveBeenCalledTimes(1);
    now += 3_600_000 - 1;
    for (let i = 0; i < 5; i++) await endTurn();
    expect(complete).toHaveBeenCalledTimes(1); // five exchanges, but not an hour
    now++;
    await endTurn(); // next exchange, now both limits met
    expect(complete).toHaveBeenCalledTimes(2);

    now += 3_600_000;
    for (let i = 0; i < 4; i++) await endTurn();
    expect(complete).toHaveBeenCalledTimes(2); // an hour, but only four exchanges
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("does not retry a failed title call within the hourly floor", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 5, minRecomputeMinutes: 60 });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    complete.mockRejectedValueOnce(new Error("temporary failure"));
    const { endTurn } = harness();

    await endTurn();
    now += 3_600_000 - 1;
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(1);
    now++;
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not start the hour clock if auth was missing and no request was sent", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 5, minRecomputeMinutes: 60 });
    let authorized = false;
    const { endTurn } = harness(undefined, () => authorized);

    await endTurn();
    expect(complete).toHaveBeenCalledTimes(0);
    authorized = true;
    await endTurn();
    expect(complete).toHaveBeenCalledTimes(1);
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

  it("defers a tick that lands while a call is in flight instead of losing it", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    let resolveComplete!: (value: unknown) => void;
    complete.mockReturnValue(new Promise((resolve) => { resolveComplete = resolve; }));
    const { endTurn } = harness();

    await endTurn();
    await endTurn();
    // The second tick cannot start a call while the first is in flight, but it is
    // a due cadence tick and must not be dropped: with recomputeEvery: 1 the old
    // code discarded it for good, so an exchange that ended mid-call went unnamed.
    expect(complete).toHaveBeenCalledTimes(1);

    resolveComplete({ content: [{ type: "text", text: "Eventually named" }] });
    await settle();

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("rejects an in-flight title when the user renames mid-call", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    let resolveComplete!: (value: unknown) => void;
    complete.mockReturnValue(new Promise((resolve) => { resolveComplete = resolve; }));
    const naming = harness();

    await naming.endTurn();
    naming.setManualName("Hand-picked");
    resolveComplete({ content: [{ type: "text", text: "Too late" }] });
    await settle();

    expect(naming.names).toEqual([]);
  });

  it("cannot tell a same-string rename from its own write, so updates continue", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    const naming = harness();

    await naming.endTurn();
    // The event payload is `name` alone, so this is byte-identical to the write
    // the extension just made. Reading it as manual would disable recompute, so
    // the documented trade is that a rename to the identical string is lost.
    naming.setManualName("Fix a stale session ctx");
    await naming.endTurn();

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("gives up after three failed recurrences, not just three initial attempts", async () => {
    loadConfig.mockReturnValue({ recomputeEvery: 1 });
    const naming = harness();

    await naming.endTurn();
    complete.mockRejectedValue(new Error("provider failed"));
    await naming.endTurn();
    await naming.endTurn();
    await naming.endTurn();
    await naming.endTurn();

    // One success, then exactly three failures before the budget closes.
    expect(complete).toHaveBeenCalledTimes(4);
    expect(reported).toHaveBeenCalledTimes(3);
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
