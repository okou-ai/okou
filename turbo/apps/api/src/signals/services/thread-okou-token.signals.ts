import { command, computed, type Computed } from "ccstate";
import { generateOkouToken } from "../auth/tokens";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { emptyEnvironment, type Environment } from "./run-environment";
import type { ThreadContext } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

interface OkouTokenInput {
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
  readonly featureOverrides: Parameters<typeof generateOkouToken>[3];
  readonly options: Parameters<typeof generateOkouToken>[4];
}

/** Capture token facts from the owning picked-event graph before signing. */
export function createOkouTokenInputSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<OkouTokenInput> => {
    const [event, features, hostGrant, snapshot] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.featureSwitches$),
      get(threadContext.computerUseHostGrant$),
      get(threadContext.connectorSnapshot$),
    ]);
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
    return {
      userId: bootstrap.userId,
      runId: get(threadContext.runIds$).runId,
      orgId: bootstrap.orgId,
      featureOverrides: features.overrides,
      options: {
        ...(hostGrant ? { computerUseHostId: hostGrant.hostId } : {}),
        cloudBrowserEnabled: event.thread.cloudBrowserEnabled,
        ...(Object.keys(customConnectorSourceIds).length === 0
          ? {}
          : { customConnectorSourceIds }),
        ...(Object.keys(builtinConnectorSourceIds).length === 0
          ? {}
          : { builtinConnectorSourceIds }),
      },
    };
  });
}

/** Sign a fresh token as the final environment source using captured facts. */
export const prepareOkouTokenEnvironment$ = command(
  (_store, input: OkouTokenInput, signal: AbortSignal): Environment => {
    signal.throwIfAborted();
    const okouToken = generateOkouToken(
      input.userId,
      input.runId,
      input.orgId,
      input.featureOverrides,
      input.options,
    );
    return {
      ...emptyEnvironment(),
      secrets: { OKOU_TOKEN: okouToken },
      platformEnvironment: { OKOU_TOKEN: okouToken },
    };
  },
);
