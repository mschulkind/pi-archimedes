// Pi's active provider is the route Pi sends requests through, not a dynamically
// selected upstream behind a routing service such as OpenRouter.
export function formatModelLabel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no-model";
}

/** Keep generated or manually supplied names on one safe footer line. */
export function formatSessionLabel(name: string | undefined): string | undefined {
  const cleaned = name
    ?.replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}
