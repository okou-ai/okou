// Web has no context table, so contextType scopes these reserved UUID values
// to Web launch identity without widening the strict payload JSONB. Writers
// use the first ID; the second was written by VM0-era APIs and decodes the
// same way.
const WEB_CONTEXT_IDS = [
  "0bdfae9e-63be-43dd-8193-a96e07787c20",
  "e1884e98-ab77-4eca-a420-90e591078804",
] as const;

/** Encode Web launch identity in the existing raw-event context boundary. */
export function webChatContextId(): string {
  return WEB_CONTEXT_IDS[0];
}

/** Recognize Web launch identity; Official authority comes from the private claim. */
export function isWebChatContextId(contextId: string | null): boolean {
  return WEB_CONTEXT_IDS.some((id) => {
    return id === contextId;
  });
}
