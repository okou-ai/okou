import { randomUUID } from "node:crypto";

import { measurePiPreparation } from "@okouai/pi-agent-runtime/api";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { piPreparationObserver } from "../pi-preparation-timing.service";

/**
 * Narrow internal-boundary exception: preparation observations never reach an
 * HTTP response, and no public API can hold a credential lookup open across
 * cancellation. Route suites own which phases real paths emit; this suite pins
 * only the delivery contract the adapter owes every phase in the vocabulary.
 */

const context = testContext();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sandboxOperationRows(runId: string): Record<string, unknown>[] {
  const dataset = `vm0-sandbox-op-log-${env("AXIOM_DATASET_SUFFIX")}`;
  const rows: Record<string, unknown>[] = [];
  const calls = context.mocks.axiom.sdkIngest.mock.calls;
  for (const [actualDataset, events] of calls) {
    if (actualDataset !== dataset || !Array.isArray(events)) {
      continue;
    }
    for (const event of events) {
      if (isRecord(event) && event.run_id === runId) {
        rows.push(event);
      }
    }
  }
  return rows;
}

describe("Pi preparation timing adapter", () => {
  it("emits one cancelled observation for work that finishes after the attempt aborts", async () => {
    const runId = randomUUID();
    const controller = new AbortController();
    const release = createDeferredPromise<void>(context.signal);
    const observed = measurePiPreparation(
      piPreparationObserver(runId),
      "credentials_revalidate",
      async () => {
        await release.promise;
      },
      controller.signal,
    );
    // Work in flight is not a completion; nothing may be published yet.
    expect(sandboxOperationRows(runId)).toStrictEqual([]);

    controller.abort();
    release.resolve(undefined);
    await observed;
    await flushWaitUntilForTest();

    const rows = sandboxOperationRows(runId);
    expect(rows).toHaveLength(1);
    const row: Record<string, unknown> = rows[0] ?? {};
    expect(row).toMatchObject({
      op_type: "pi_prepare_credentials_revalidate",
      outcome: "cancelled",
      success: false,
      run_id: runId,
      source: "api",
      sandbox_type: "runner",
      span_kind: "nested",
    });
    expect(row._time).toBe(row.finished_at);
    expect(typeof row.duration_ms).toBe("number");
    expect(typeof row.started_at).toBe("string");
  });

  it("leaves a phase that never ran without any row rather than a zero duration", async () => {
    const runId = randomUUID();
    await measurePiPreparation(
      piPreparationObserver(runId),
      "activation_authorize",
      () => {
        return Promise.resolve("authorized");
      },
    );
    await flushWaitUntilForTest();

    // A skipped step must be indistinguishable from unreached code, never a
    // free step: reconstruction reads a zero-duration row as measured work.
    expect(
      sandboxOperationRows(runId).map((row) => {
        return row.op_type;
      }),
    ).toStrictEqual(["pi_prepare_activation_authorize"]);
  });
});
