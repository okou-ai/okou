import { createStore } from "ccstate";
import { z } from "zod";

import { drainCanonicalDiscordIngressForConnections$ } from "../signals/services/canonical-discord-ingress-processor.service";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";
import { configureOfficialWorkflowReconciliationDispatcher$ } from "../signals/services/official-workflow-reconciliation-registration.service";

const ownedConnectionIdsSchema = z.array(z.uuid()).min(1).max(20);

// Drive the real recovery worker for the calling test's owned connections.
// Existing Discord fixtures use development mode, without a Preview request.
export async function recoverDiscordIngressForTest(
  connectionIds: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedConnectionIds = ownedConnectionIdsSchema.parse(connectionIds);
  const store = createStore();
  // Recovery can launch or finish Runs: retain the API's dispatcher wiring.
  store.set(configureChatRunFinishedEventDispatcher$);
  store.set(configureOfficialWorkflowReconciliationDispatcher$);
  const processed = await store.set(
    drainCanonicalDiscordIngressForConnections$,
    ownedConnectionIds,
    signal,
  );
  signal.throwIfAborted();
  return processed;
}
