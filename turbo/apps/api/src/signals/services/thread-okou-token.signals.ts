import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { command, computed, type Computed } from "ccstate";
import { generateOkouToken } from "../auth/tokens";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { ThreadContext } from "./thread-context.signals";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

interface OkouTokenInput {
  readonly userId: string;
  readonly runId: string;
  readonly orgId: string;
  readonly email: FeatureSwitchContext["email"];
  readonly featureOverrides: FeatureSwitchContext["overrides"];
  readonly options: Parameters<typeof generateOkouToken>[4];
}

/** Capture token facts from the owning picked-event graph before signing. */
export function createOkouTokenInputSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<OkouTokenInput> => {
    const [event, features, hostGrant, snapshot, agent] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.featureSwitches$),
      get(threadContext.computerUseHostGrant$),
      get(threadContext.connectorSnapshot$),
      get(bootstrap.agent$),
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
      email: features.email,
      featureOverrides: features.overrides,
      options: {
        isDefaultAgent: agent !== null && agent.id === agent.defaultAgentId,
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

/** Sign the authorization receipt from the selected admission facts. */
export const prepareOkouToken$ = command(
  (_store, input: OkouTokenInput, signal: AbortSignal): string => {
    signal.throwIfAborted();
    const features = {
      userId: input.userId,
      orgId: input.orgId,
      email: input.email,
      overrides: input.featureOverrides,
    };
    return generateOkouToken(
      input.userId,
      input.runId,
      input.orgId,
      (key) => {
        return isFeatureEnabled(key, features);
      },
      input.options,
    );
  },
);
