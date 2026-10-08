// Web has no context table, so contextType scopes these reserved UUID values
// to Web launch identity without widening the strict payload JSONB. Writers
// use the first ID; the second was written by VM0-era APIs and decodes the
// same way.
const WEB_CONTEXT_IDS = [
  "0bdfae9e-63be-43dd-8193-a96e07787c20",
  "e1884e98-ab77-4eca-a420-90e591078804",
] as const;

// Persisted queue compatibility (#29908): writers retain these markers while
// readers prepare to accept normal Web IDs with the private Official claim.
// Cut writers over only after marker-only readers drain and exit rollback.
// Retire marker decoding in a later release after marker writers are excluded
// from serving/rollback, no unrevoked runless marker prompts remain, and stale
// recovery is verified. Immutable raw/snapshot history must stay readable.
// Writers use the first marker; the second was written by VM0-era APIs.
const OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS = [
  "3f713f81-d611-47ec-a427-5a4844078890",
  "d4f079af-190a-4a32-bf49-73175aa2d727",
] as const;

interface WebChatQueueContext {
  readonly officialWorkflowClaimRequired: boolean;
}

/** Encode Web launch identity in the existing raw-event context boundary. */
export function webChatContextId(): string {
  return WEB_CONTEXT_IDS[0];
}

/** Mark a queued Web prompt whose later Run requires Official source authority. */
export function officialWorkflowQueueContextId(): string {
  return OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS[0];
}

function includesContextId(
  ids: readonly string[],
  contextId: string | null,
): boolean {
  return contextId !== null && ids.includes(contextId);
}

/** Decode a Web context ID or Official queue marker; an ordinary agent source pointer is neither. */
export function webChatQueueContextFromContextId(
  contextId: string | null,
): WebChatQueueContext | null {
  if (includesContextId(WEB_CONTEXT_IDS, contextId)) {
    return { officialWorkflowClaimRequired: false };
  }
  if (includesContextId(OFFICIAL_WORKFLOW_QUEUE_CONTEXT_IDS, contextId)) {
    return { officialWorkflowClaimRequired: true };
  }
  return null;
}
