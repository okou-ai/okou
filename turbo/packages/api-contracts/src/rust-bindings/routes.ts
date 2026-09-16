import { runnerRealtimeTokenContract } from "../contracts/realtime";
import { runnerSshContract } from "../contracts/runner-ssh";
import {
  runnersActiveInputsContract,
  runnersCancellationContract,
  runnersConnectorRuntimeSyncContract,
  runnersBuiltinFirewallsResolveContract,
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
  webhookHeartbeatContract,
  webhookSessionOutputContract,
  webhookStoragesCommitContract,
  webhookStoragesPrepareContract,
  webhookTelemetryContract,
} from "../contracts/webhooks";

export interface RouteLike {
  readonly method?: unknown;
  readonly path?: unknown;
  readonly summary?: unknown;
}

export interface RustRouteBinding {
  readonly route: RouteLike;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
}

export const rustRouteBindings = [
  {
    route: runnersCancellationContract.get,
    rustModulePath: ["runners", "runs", "by_run_id", "cancellation"],
    rustConstName: "GET",
  },
  {
    route: runnerSshContract.observe,
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "observations"],
    rustConstName: "OBSERVE",
  },
  {
    route: runnerSshContract.resolve,
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "resolve"],
    rustConstName: "RESOLVE",
  },
  {
    route: runnerSshContract.pin,
    rustModulePath: ["runners", "runs", "by_run_id", "ssh", "pin"],
    rustConstName: "PIN",
  },
  {
    route: runnersPollContract.poll,
    rustModulePath: ["runners", "poll"],
    rustConstName: "POLL",
  },
  {
    route: runnersJobClaimContract.release,
    rustModulePath: ["runners", "jobs", "by_id", "release"],
    rustConstName: "RELEASE",
  },
  {
    route: runnersJobClaimContract.claim,
    rustModulePath: ["runners", "jobs", "by_id", "claim"],
    rustConstName: "CLAIM",
  },
  {
    route: runnersActiveInputsContract.reserve,
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "reserve",
    ],
    rustConstName: "RESERVE",
  },
  {
    route: runnersActiveInputsContract.receipt,
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "deliveries",
      "by_delivery_id",
      "receipt",
    ],
    rustConstName: "RECEIPT",
  },
  {
    route: runnersModelProviderFailuresContract.report,
    rustModulePath: ["runners", "runs", "by_run_id", "model_provider_failures"],
    rustConstName: "REPORT",
  },
  {
    route: runnersConnectorRuntimeSyncContract.sync,
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "connector_runtime",
      "sync",
    ],
    rustConstName: "SYNC",
  },
  {
    route: runnersBuiltinFirewallsResolveContract.resolve,
    rustModulePath: ["runners", "builtin_firewalls", "resolve"],
    rustConstName: "RESOLVE",
  },
  {
    route: runnersHeartbeatContract.heartbeat,
    rustModulePath: ["runners", "heartbeat"],
    rustConstName: "HEARTBEAT",
  },
  {
    route: runnerRealtimeTokenContract.create,
    rustModulePath: ["runners", "realtime", "token"],
    rustConstName: "CREATE",
  },
  {
    route: webhookEventsContract.send,
    rustModulePath: ["webhooks", "agent", "events"],
    rustConstName: "SEND",
  },
  {
    route: webhookSessionOutputContract.send,
    rustModulePath: ["webhooks", "agent", "session_output"],
    rustConstName: "SEND",
  },
  {
    route: webhookCheckpointsContract.create,
    rustModulePath: ["webhooks", "agent", "checkpoints"],
    rustConstName: "CREATE",
  },
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    rustModulePath: ["webhooks", "agent", "checkpoints", "prepare_history"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookCompleteContract.complete,
    rustModulePath: ["webhooks", "agent", "complete"],
    rustConstName: "COMPLETE",
  },
  {
    route: webhookHeartbeatContract.send,
    rustModulePath: ["webhooks", "agent", "heartbeat"],
    rustConstName: "SEND",
  },
  {
    route: webhookTelemetryContract.send,
    rustModulePath: ["webhooks", "agent", "telemetry"],
    rustConstName: "SEND",
  },
  {
    route: webhookStoragesPrepareContract.prepare,
    rustModulePath: ["webhooks", "agent", "storages", "prepare"],
    rustConstName: "PREPARE",
  },
  {
    route: webhookStoragesCommitContract.commit,
    rustModulePath: ["webhooks", "agent", "storages", "commit"],
    rustConstName: "COMMIT",
  },
] as const satisfies readonly RustRouteBinding[];
