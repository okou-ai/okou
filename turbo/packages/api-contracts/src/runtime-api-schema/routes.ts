import { runnerRealtimeTokenContract } from "../contracts/realtime";
import {
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersPollContract,
} from "../contracts/runners";
import {
  webhookSessionHistoryPrepareContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookFirewallAuthContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "../contracts/webhooks";
import { swiftRouteBindings } from "../swift-bindings/routes";

export interface RuntimeApiRouteLike {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly summary?: unknown;
  readonly headers?: unknown;
  readonly query?: unknown;
  readonly pathParams?: unknown;
  readonly body?: unknown;
  readonly contentType?: unknown;
  readonly responses?: unknown;
}

export const runtimeApiRouteOwners = [
  "runner",
  "guest-agent",
  "mitm-addon",
  "desktop",
] as const;

export type RuntimeApiRouteOwner = (typeof runtimeApiRouteOwners)[number];

export interface RuntimeApiRouteBinding {
  readonly id: string;
  readonly owner: RuntimeApiRouteOwner;
  readonly route: RuntimeApiRouteLike;
}

const runtimeServiceRouteBindings = [
  {
    id: "runners.poll",
    owner: "runner",
    route: runnersPollContract.poll,
  },
  {
    id: "runners.jobs.claim",
    owner: "runner",
    route: runnersJobClaimContract.claim,
  },
  {
    id: "runners.heartbeat",
    owner: "runner",
    route: runnersHeartbeatContract.heartbeat,
  },
  {
    id: "runners.realtime.token",
    owner: "runner",
    route: runnerRealtimeTokenContract.create,
  },
  {
    id: "runners.builtinFirewalls.resolve",
    owner: "runner",
    route: runnersBuiltinFirewallsResolveContract.resolve,
  },
  {
    id: "runners.connectorRuntime.sync",
    owner: "runner",
    route: runnersConnectorRuntimeSyncContract.sync,
  },
  {
    id: "webhooks.agent.events",
    owner: "guest-agent",
    route: webhookEventsContract.send,
  },
  {
    id: "webhooks.agent.sessionHistory.prepare",
    owner: "guest-agent",
    route: webhookSessionHistoryPrepareContract.prepare,
  },
  {
    id: "webhooks.agent.complete",
    owner: "guest-agent",
    route: webhookCompleteContract.complete,
  },
  {
    id: "webhooks.agent.heartbeat",
    owner: "guest-agent",
    route: webhookHeartbeatContract.send,
  },
  {
    id: "webhooks.agent.telemetry",
    owner: "guest-agent",
    route: webhookTelemetryContract.send,
  },
  {
    id: "webhooks.agent.storages.prepare",
    owner: "guest-agent",
    route: webhookStoragesPrepareContract.prepare,
  },
  {
    id: "webhooks.agent.storages.commit",
    owner: "guest-agent",
    route: webhookStoragesCommitContract.commit,
  },
  {
    id: "webhooks.agent.firewall.auth",
    owner: "mitm-addon",
    route: webhookFirewallAuthContract.resolve,
  },
  {
    id: "webhooks.agent.usageEvent",
    owner: "mitm-addon",
    route: webhookUsageEventContract.send,
  },
] as const satisfies readonly RuntimeApiRouteBinding[];

/**
 * Desktop-consumed routes, derived from the Swift binding list so that list
 * stays the single source of truth. Breaking changes on these routes are
 * gated by `cli.ts lint --block-owner desktop`; see
 * docs/deployment-compatibility.md#desktop-contract-gate.
 */
const desktopRouteBindings: readonly RuntimeApiRouteBinding[] =
  swiftRouteBindings.map(({ swiftName, route }) => {
    return { id: `desktop.${swiftName}`, owner: "desktop", route };
  });

export const runtimeApiRouteBindings: readonly RuntimeApiRouteBinding[] = [
  ...runtimeServiceRouteBindings,
  ...desktopRouteBindings,
];
