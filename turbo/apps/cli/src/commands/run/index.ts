import { Command } from "commander";

import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import type { RunUsageCliOutcome, RunUsageResult } from "./protocol";
import { queryRunUsage } from "./rpc";

function requireCapability(): void {
  if (!decodeSandboxTokenPayload()?.capabilities.includes("run-usage:read")) {
    throw new Error(
      "This command requires a current Run token with run-usage:read. Start a new Run after the feature is enabled.",
    );
  }
}

function sampleTime(milliseconds: number): string {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime())
    ? `${milliseconds} ms since epoch`
    : `${milliseconds} (${date.toISOString()})`;
}

function tokenLines(
  tokens: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheCreation: number;
    readonly output: number;
    readonly total: number;
  },
  lowerBound: boolean,
): string[] {
  const suffix = lowerBound ? "+" : "";
  return [
    `  Input: ${tokens.input}${suffix}`,
    `  Cache read: ${tokens.cacheRead}${suffix}`,
    `  Cache creation: ${tokens.cacheCreation}${suffix}`,
    `  Output: ${tokens.output}${suffix}`,
    `  Total: ${tokens.total}${suffix}`,
  ];
}

function nullableToken(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

function printUsage(result: RunUsageResult): void {
  console.log(`Run: ${result.runId}`);
  if (result.combined.state === "observed") {
    console.log(
      `Observed token usage (${result.combined.coverage}${
        result.combined.coverage === "partial"
          ? "; lower bounds, not a final provider total"
          : ""
      }):`,
    );
    for (const line of tokenLines(
      result.combined.observedTokens,
      result.combined.coverage === "partial",
    )) {
      console.log(line);
    }
  } else if (result.combined.state === "overflow") {
    console.log(
      `Observed token usage: combined ${result.combined.coverage} quantities exceed JavaScript's safe-integer range; inspect source categories below.`,
    );
  } else {
    console.log(
      "Observed token usage: unavailable; neither source established a numeric observation.",
    );
  }

  const api = result.sources.apiFirstTurn;
  if (api.state === "unavailable") {
    console.log(`API first turn: unavailable (${api.reason}).`);
  } else if (api.state === "no-inference") {
    console.log(
      `API first turn: no inference before ownership transfer; sampled at ${sampleTime(api.sampledAt)}.`,
    );
  } else {
    console.log(
      `API first turn: observed ${api.coverage}; sampled at ${sampleTime(api.sampledAt)}; handoff-time only.`,
    );
    console.log(
      `  Input: ${nullableToken(api.tokens.input)}; cache read: ${nullableToken(api.tokens.cacheRead)}; cache creation: ${nullableToken(api.tokens.cacheCreation)}; output: ${nullableToken(api.tokens.output)}; total: ${nullableToken(api.tokens.total)}`,
    );
  }

  const proxy = result.sources.sandboxProxy;
  if (proxy.state === "unavailable") {
    console.log(`Sandbox proxy: unavailable (${proxy.reason}).`);
  } else {
    console.log(
      `Sandbox proxy: observed ${proxy.coverage}; sampled at ${sampleTime(proxy.sampledAtMs)}; revision ${proxy.revision}.`,
    );
    console.log(
      `  Responses: ${proxy.observedResponses} observed, ${proxy.outstandingResponses} outstanding; reasons: ${proxy.reasons.length === 0 ? "none" : proxy.reasons.join(", ")}.`,
    );
    for (const line of tokenLines(proxy.tokens, false)) {
      console.log(line);
    }
  }
}

function errorMessage(
  outcome: Extract<RunUsageCliOutcome, { status: "error" }>,
): string {
  const message: Record<typeof outcome.error.kind, string> = {
    "unsupported-runner":
      "This Runner does not support run.usage; start a new Run after Runner promotion.",
    "feature-unavailable":
      "Current-run usage is unavailable for this assignment; start a new Run after the feature is enabled.",
    busy: "Current-run usage is busy; no result was fabricated.",
    "timed-out": "Current-run usage timed out.",
    cancelled: "Current-run usage was cancelled.",
    "invalid-response": "Runner returned an invalid run usage response.",
    transport:
      "The packaged Runner RPC helper could not complete the usage query.",
  };
  return `${message[outcome.error.kind]} Delivery: ${outcome.error.delivery}. No fallback or automatic retry was used.`;
}

const usageCommand = new Command("usage")
  .description("Query observed provider-token usage for this assigned Run")
  .option("--json", "Print the strict versioned outcome")
  .addHelpText(
    "after",
    `
This read-only query is bound to the current Sandbox assignment. It accepts no Run ID, endpoint or source input and requires no SSH access.

Values are observations, not billing or settlement. Partial values are lower bounds. API-first usage is immutable at ownership transfer and cannot include provider usage first observed later. Source times are independent. The command never falls back to billing rows, logs or history and never retries automatically.`,
  )
  .action(
    withErrorHandler(async (options: { readonly json?: boolean }) => {
      requireCapability();
      const outcome = await queryRunUsage();
      if (options.json) {
        console.log(JSON.stringify(outcome));
      } else if (outcome.status === "ok") {
        printUsage(outcome.usage);
      } else {
        console.error(errorMessage(outcome));
      }
      if (outcome.status === "error") process.exitCode = 1;
    }),
  );

export const runCommand = new Command("run")
  .description("Inspect the current assigned Run")
  .addCommand(usageCommand);
