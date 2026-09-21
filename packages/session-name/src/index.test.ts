import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Mocks ────────────────────────────────────────────────────────────────────
//
// The model call is stubbed because it is the seconds-long await this extension
// spends detached from its `agent_end` handler -- and so the exact window a
// session replacement lands in. Driving that timing is the point of this file.

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete }));
vi.mock("@pi-archimedes/core/settings-io", () => ({ loadConfig: () => ({}) }));

const { registerSessionName } = await import("./index.js");

// ── Harness ──────────────────────────────────────────────────────────────────

// Pi's own wording, as it reaches a detached task.
const STALE_CTX_ERROR =
  "This extension ctx is stale after session replacement or reload.";

type AgentEndHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface HarnessOptions {
  /** A name the user set by hand, via --name or /name. */
  existingName?: string;
}

/**
 * generateTitle is fire-and-forget by design, so the handler resolves before the
 * title does. complete() is an already-resolved stub, which leaves only
 * microtasks behind it: one macrotask drains all of them.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: HarnessOptions = {}) {
  const names: string[] = [];
  let existing = options.existingName;
  let stale = false;

  // Every session-bound method on `pi` throws once the session it was bound to
  // is gone. Standing in for that with one guard keeps the fake honest about
  // the contract under test. `ctx` is deliberately NOT guarded: its reads all
  // happen before the first await, so nothing can replace the session between
  // them -- only an await can be interleaved, and the surviving session-bound
  // calls are the ones after the model responds.
  const assertSessionLive = () => {
    if (stale) throw new Error(STALE_CTX_ERROR);
  };

  const handlers = new Map<string, AgentEndHandler>();
  const api = {
    on: (event: string, handler: AgentEndHandler) => {
      handlers.set(event, handler);
      return () => {};
    },
    getSessionName: () => {
      assertSessionLive();
      return existing;
    },
    setSessionName: (name: string) => {
      assertSessionLive();
      names.push(name);
      existing = name;
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "the zai chip is broken again" }] },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "the credential file moved out from under it" }],
          },
        },
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
    /** The session is replaced, or the runtime reloaded, from here on. */
    replaceSession: () => {
      stale = true;
    },
    endTurn: async () => {
      const handler = handlers.get("agent_end");
      if (!handler) throw new Error("registerSessionName did not register agent_end");
      await handler({}, ctx);
      await settle();
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("session naming", () => {
  let reported: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    complete.mockReset();
    complete.mockResolvedValue({ content: [{ type: "text", text: "Fix a stale session ctx" }] });
    reported = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    reported.mockRestore();
  });

  it("names the session after the first exchange", async () => {
    const { names, endTurn } = harness();

    await endTurn();

    expect(names).toEqual(["Fix a stale session ctx"]);
    expect(reported).not.toHaveBeenCalled();
  });

  it("leaves a name the user set by hand alone", async () => {
    const { names, endTurn } = harness({ existingName: "Hand-picked" });

    await endTurn();

    expect(names).toEqual([]);
    expect(reported).not.toHaveBeenCalled();
  });

  it("drops the title without reporting an error when the session moved on", async () => {
    // The session is replaced while the model is generating the title -- the
    // window this extension is exposed to for seconds at a time. The title has
    // nowhere to land, naming it is meaningless, and this is not a failure of
    // the extension, so nothing should be logged or counted against it.
    const naming = harness();
    complete.mockImplementation(async () => {
      naming.replaceSession();
      return { content: [{ type: "text", text: "Fix a stale session ctx" }] };
    });

    await naming.endTurn();

    expect(naming.names).toEqual([]);
    expect(reported).not.toHaveBeenCalled();
  });
});
