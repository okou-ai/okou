import { runnerRealtimeTokenContract } from "../contracts/realtime";
import {
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersHeartbeatContract,
  runnersJobClaimContract,
  runnersModelProviderFailuresContract,
  runnersPollContract,
} from "../contracts/runners";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
  webhookCompleteContract,
  webhookEventsContract,
  webhookFirewallAuthContract,
  webhookHeartbeatContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
  webhookUsageEventContract,
} from "../contracts/webhooks";

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

export interface RuntimeApiRouteBinding {
  readonly id: string;
  readonly owner: "runner" | "guest-agent" | "mitm-addon";
  readonly route: RuntimeApiRouteLike;
}

export const runtimeApiRouteBindings = [
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
    id: "runners.runs.modelProviderFailures",
    owner: "mitm-addon",
    route: runnersModelProviderFailuresContract.report,
  },
  {
    id: "webhooks.agent.events",
    owner: "guest-agent",
    route: webhookEventsContract.send,
  },
  {
    id: "webhooks.agent.checkpoints",
    owner: "guest-agent",
    route: webhookCheckpointsContract.create,
  },
  {
    id: "webhooks.agent.checkpoints.prepareHistory",
    owner: "guest-agent",
    route: webhookCheckpointsPrepareHistoryContract.prepare,
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
