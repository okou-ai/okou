import type { ZodType } from "zod";
import { runnerRealtimeTokenContract } from "../contracts/realtime";
import {
  runnersCancellationContract,
  runnersBuiltinFirewallsResolveContract,
  runnersConnectorRuntimeSyncContract,
  executionContextSchema,
  runnersSteerContract,
} from "../contracts/runners";

export interface RustDecodePathBinding {
  readonly schema: ZodType;
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
    schema: executionContextSchema,
    rustModulePath: ["runners", "execution_publication"],
    rustConstName: "CONTEXT",
    rustDoc: ["Decode-path schema for complete Runner execution input."],
  },
  {
    schema: runnersSteerContract.next.responses[200],
    rustModulePath: [
      "runners",
      "runs",
      "by_run_id",
      "steerable_inputs",
      "next",
    ],
    rustConstName: "RESPONSE",
    rustDoc: ["Decode-path schema for the next steerable input response."],
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
