import { type z } from "zod";
import { runnerRealtimeTokenContract } from "../contracts/realtime";
import {
  runnersActiveInputsContract,
  runnersCancellationContract,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  runnersJobClaimContract,
  runnersPollContract,
} from "../contracts/runners";

export interface RustDecodePathBinding {
  readonly schema: z.ZodType;
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly rustDoc: readonly string[];
}

export const rustDecodePathBindings = [
  {
    schema: runnersCancellationContract.get.responses[200],
    rustModulePath: ["runners", "runs", "by_run_id", "cancellation"],
    rustConstName: "RESPONSE",
    rustDoc: [
      "Decode-path schema for Run stop intent and authenticated absence.",
    ],
  },
  {
    schema: runnersPollContract.poll.responses[200],
    rustModulePath: ["runners", "poll"],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the runner poll response."],
  },
  {
    schema: runnersJobClaimContract.claim.responses[200],
    rustModulePath: ["runners", "jobs", "by_id", "claim"],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the runner job claim response."],
  },
  {
    schema: runnersActiveInputsContract.reserve.responses[200],
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "reserve",
    ],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the active-input reserve response."],
  },
  {
    schema: runnersActiveInputsContract.receipt.responses[200],
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "active_inputs",
      "deliveries",
      "by_delivery_id",
      "receipt",
    ],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the active-input receipt response."],
  },
  {
    schema: runnersConnectorRuntimeSyncContract.sync.responses[200],
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "connector_runtime",
      "sync",
    ],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the connector runtime sync response."],
  },
  {
    schema: runnersBuiltinFirewallsResolveContract.resolve.responses[200],
    rustModulePath: ["runners", "builtin_firewalls", "resolve"],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the builtin firewall catalog response."],
  },
  {
    schema: runnerRealtimeTokenContract.create.responses[200],
    rustModulePath: ["runners", "realtime", "token"],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the runner realtime token response."],
  },
] as const satisfies readonly RustDecodePathBinding[];
