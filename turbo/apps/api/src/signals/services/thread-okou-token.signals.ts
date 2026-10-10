import { command, type Computed } from "ccstate";
import { generateOkouToken } from "../auth/tokens";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { emptyEnvironment, type Environment } from "./run-environment";
import type { ThreadContext } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

/**
 * Issue the Run's Okou token. It is the last environment source: a command,
 * because each call signs a fresh token for the claim's run identity.
 */
export const prepareOkouTokenEnvironment$ = command(
  async (
    { get },
    bootstrap: AgentRunContextSignals,
    pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
    threadContext: Pick<
      ThreadContext,
      "computerUseHostGrant$" | "connectorSnapshot$" | "runIds$"
    >,
    signal: AbortSignal,
  ): Promise<Environment> => {
    const [event, features, hostGrant, snapshot] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.featureSwitches$),
      get(threadContext.computerUseHostGrant$),
      get(threadContext.connectorSnapshot$),
    ]);
    signal.throwIfAborted();
    if (!event) {
      throw new Error("The Okou run token requires a picked event");
    }
    if ("status" in snapshot) {
      throw new Error("The Okou run token requires a connector snapshot");
    }
    const customConnectorSourceIds = Object.fromEntries(
      snapshot.customConnectorContext.targets.flatMap((target) => {
        return target.kind === "custom" && target.sourceId
          ? [[target.customConnectorId, target.sourceId] as const]
          : [];
      }),
    );
    const { mcpConnectorSlugs, connectorSourceIdBySlug } =
      snapshot.storedConnectorMetadataContext;
    const builtinConnectorSourceIds = Object.fromEntries(
      mcpConnectorSlugs.flatMap((connectorSlug) => {
        const sourceId = connectorSourceIdBySlug[connectorSlug];
        return sourceId === undefined ? [] : [[connectorSlug, sourceId]];
      }),
    );
    const okouToken = generateOkouToken(
      bootstrap.userId,
      get(threadContext.runIds$).runId,
      bootstrap.orgId,
      features.overrides,
      {
        ...(hostGrant ? { computerUseHostId: hostGrant.hostId } : {}),
        cloudBrowserEnabled: event.thread.cloudBrowserEnabled,
        ...(Object.keys(customConnectorSourceIds).length === 0
          ? {}
          : { customConnectorSourceIds }),
        ...(Object.keys(builtinConnectorSourceIds).length === 0
          ? {}
          : { builtinConnectorSourceIds }),
      },
    );
    return {
      ...emptyEnvironment(),
      secrets: { OKOU_TOKEN: okouToken },
      platformEnvironment: { OKOU_TOKEN: okouToken },
    };
  },
);
