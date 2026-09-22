import { complete } from "@earendil-works/pi-ai/compat";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@pi-archimedes/core/settings-io";
import type { SettingItem } from "@earendil-works/pi-tui";

// ── Config ──────────────────────────────────────────────────────────────────

export interface SessionNameSettings {
  // suite-managed by meta's plugin gate (archimedes.sessionName.enabled — see ADR 0012); session-name never reads this
  enabled?: boolean | undefined;
  model?: string | undefined;
  /** Recompute an extension-owned title every N completed exchanges; 0 is one-shot. */
  recomputeEvery?: number | undefined;
}

const DEFAULT_SESSION_NAME_CONFIG: SessionNameSettings = {
  model: undefined,
  recomputeEvery: 0,
};

const NAMESPACE = "archimedes.sessionName";

export function loadSessionNameConfig(): SessionNameSettings {
  return loadConfig(NAMESPACE, DEFAULT_SESSION_NAME_CONFIG);
}

function recomputeInterval(value: number | undefined): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : 0;
}

// ── Model resolution ────────────────────────────────────────────────────────

/**
 * Find a model by reference string.
 *
 * Resolution order:
 *   1. Canonical "provider/id" (case-insensitive)
 *   2. Bare "id" (case-insensitive) — only if unique across providers
 *   3. Thinking-suffix tolerance: strip everything after the last colon and retry
 */
function findMatch<T extends { provider: string; id: string }>(
  ref: string,
  models: readonly T[],
): T | undefined {
  const lower = ref.toLowerCase();
  if (!lower) return undefined;

  const canonical = models.find(
    (m) => `${m.provider}/${m.id}`.toLowerCase() === lower,
  );
  if (canonical) return canonical;

  const idMatches = models.filter((m) => m.id.toLowerCase() === lower);
  if (idMatches.length === 1) return idMatches[0];

  if (ref.includes(":")) {
    const prefix = ref.slice(0, ref.lastIndexOf(":"));
    if (prefix) return findMatch(prefix, models);
  }

  return undefined;
}

/** Resolve a model reference against the available models. */
export function resolveModel<T extends { provider: string; id: string }>(
  modelRef: string | undefined,
  models: readonly T[],
): T | undefined {
  if (!modelRef || !modelRef.trim()) return undefined;
  return findMatch(modelRef.trim(), models);
}

// ── Title generation (runs in background) ───────────────────────────────────

/**
 * Generate and set a session title. Runs asynchronously without blocking the
 * agent_end handler so the UI stays responsive.
 */
async function generateTitle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  onWriting: (title: string) => boolean,
  onSuccess: () => void,
  onFailure: () => void,
  onFinish: () => void,
) {
  try {
    const settings = loadSessionNameConfig();

    // Use the latest complete user + assistant exchange. The first title is
    // therefore unchanged, while a cadence-based recomputation reflects where
    // the conversation has drifted since then.
    const branch = ctx.sessionManager.getBranch();
    let latestUser: string | undefined;
    let conversationText: string | undefined;

    for (const entry of branch) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const texts = typeof msg.content === "string"
        ? [msg.content]
        : Array.isArray(msg.content)
          ? msg.content
              .filter((b: any) => b?.type === "text" && typeof b.text === "string")
              .map((b: any) => b.text)
          : [];
      const text = texts.join("\n").trim().slice(0, 500);
      if (!text) continue;

      if (msg.role === "user") {
        latestUser = text;
      } else if (latestUser) {
        conversationText = `User: ${latestUser}\nAssistant: ${text}`;
      }
    }

    if (!conversationText) return;

    const titlePrompt = [
      "Generate a concise title (3-8 words) for this conversation.",
      "The title should capture what the user is working on.",
      "Return only the title, nothing else.",
      "",
      "<conversation>",
      conversationText,
      "</conversation>",
    ].join("\n");

    const settingsModel = resolveModel(settings.model, ctx.modelRegistry.getAll());
    const model = settingsModel ?? ctx.model;
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return;

    const opts: { reasoning: "minimal"; cacheRetention: "none"; sessionId: string; apiKey?: string; headers?: ProviderHeaders } = {
      reasoning: "minimal",
      cacheRetention: "none",
      sessionId: crypto.randomUUID(),
    };
    if (auth.apiKey) opts.apiKey = auth.apiKey;
    if (auth.headers) opts.headers = auth.headers;

    const response = await complete(model, {
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: titlePrompt }],
        timestamp: Date.now(),
      }],
    }, opts);

    const title = response.content
      .filter((c: any): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(\"|')((?:(?!\1).)*)\1$/, "$2")
      .slice(0, 80);

    if (!title) {
      onFailure();
      return;
    }

    if (!onWriting(title)) return;
    onSuccess();
  } catch (e) {
    console.error("[archimedes] session-name failed:", e);
    onFailure();
  } finally {
    onFinish();
  }
}

// ── Registration ────────────────────────────────────────────────────────────

export function registerSessionName(pi: ExtensionAPI) {
  let hasNamed = false;
  let failCount = 0;
  let exchangeCount = 0;
  let inFlight = false;
  let extensionName: string | undefined;
  let hasManualName = false;

  pi.on("session_start", () => {
    hasNamed = false;
    failCount = 0;
    exchangeCount = 0;
    inFlight = false;
    extensionName = undefined;
    hasManualName = false;
  });

  // Pi sends this for both our setSessionName call and --name / /name. Keeping
  // the last title we wrote lets us distinguish them without another mechanism.
  pi.on("session_info_changed", (event) => {
    if (event.name !== extensionName) hasManualName = true;
  });

  pi.on("agent_end", (_event, ctx: ExtensionContext) => {
    exchangeCount++;
    const interval = recomputeInterval(loadSessionNameConfig().recomputeEvery);

    if (inFlight || failCount >= 3 || hasManualName) return;
    if (hasNamed && (interval === 0 || exchangeCount % interval !== 0)) return;

    // An existing non-extension title may predate this extension's listener.
    const currentName = pi.getSessionName();
    if (currentName && currentName !== extensionName) {
      hasManualName = true;
      return;
    }
    if (!ctx.sessionManager.getSessionFile()) return;

    inFlight = true;
    void generateTitle(
      pi,
      ctx,
      (title) => {
        if (hasManualName) return false;
        try {
          const current = pi.getSessionName();
          if (current && current !== extensionName) {
            hasManualName = true;
            return false;
          }
          // Set before Pi emits session_info_changed, which may be synchronous.
          extensionName = title;
          pi.setSessionName(title);
          return true;
        } catch {
          return false;
        }
      },
      () => { hasNamed = true; },
      () => { failCount++; },
      () => { inFlight = false; },
    );
  });
}

export default registerSessionName;

// ── Settings UI ─────────────────────────────────────────────────────────────

/** Build settings UI items for the session-name package. */
export function getSessionNameSettingsItems(config: SessionNameSettings): SettingItem[] {
  return [
    {
      id: "sessionNameModel",
      label: "Model for naming",
      description: "Model used for title generation (leave empty for current model)",
      currentValue: config.model || "(current model)",
    },
  ];
}
