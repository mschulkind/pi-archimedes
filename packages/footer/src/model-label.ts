// Pi's active provider is the route Pi sends requests through, not a dynamically
// selected upstream behind a routing service such as OpenRouter.
export function formatModelLabel(model: { provider: string; id: string } | undefined): string {
  return model ? `${model.provider}/${model.id}` : "no-model";
}
