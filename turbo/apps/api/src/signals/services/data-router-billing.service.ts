import { randomUUID } from "node:crypto";
import { dataRouterRequests } from "@okouai/db/schema/data-router-request";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { recordDataRouterUsage$ } from "./data-router-usage.service";
import { managedAttributionQuery } from "./managed-usage-attribution";

const billingResponse = z.object({
  result: z.object({
    isError: z.literal(false).optional(),
    structuredContent: z.object({
      records: z.array(
        z.object({
          requestId: z.uuid(),
          credits: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        }),
      ),
    }),
  }),
});

/** One best-effort lookup on the first terminal transition. No reconciliation job. */
export const settleDataRouterRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal) => {
    const url = env("OKOU_DATA_ROUTER_URL");
    const token = env("OKOU_DATA_TOKEN");
    if (!url || !token) {
      return;
    }
    const db = set(writeDb$);
    const requests = await db
      .select({ requestId: dataRouterRequests.requestId })
      .from(dataRouterRequests)
      .where(eq(dataRouterRequests.runId, runId));
    signal.throwIfAborted();
    if (requests.length === 0) {
      return;
    }
    const [attribution] = await db
      .select()
      .from(managedAttributionQuery(runId));
    signal.throwIfAborted();
    if (!attribution) {
      throw new Error("Missing Data Router Run attribution");
    }
    const requestIds = new Set(
      requests.map((request) => {
        return request.requestId;
      }),
    );
    // The lookup owns its timeout; only caller cancellation aborts later billing.
    const lookup = await settleIncludingAbort(
      (async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "tools/call",
            params: {
              name: "billing_get",
              arguments: { requestIds: [...requestIds] },
            },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        if (!response.ok) {
          throw new Error(
            `Data Router billing lookup failed: ${response.status}`,
          );
        }
        return billingResponse.parse(await response.json());
      })(),
    );
    signal.throwIfAborted();
    if (!lookup.ok) {
      throw new Error("Data Router billing lookup failed", {
        cause: lookup.error,
      });
    }
    const result = lookup.value;
    let credits = 0;
    const observed = new Set<string>();
    for (const receipt of result.result.structuredContent.records) {
      if (
        !requestIds.has(receipt.requestId) ||
        observed.has(receipt.requestId)
      ) {
        throw new Error(
          "Data Router returned an unexpected or duplicate request",
        );
      }
      observed.add(receipt.requestId);
      credits += receipt.credits;
      if (!Number.isSafeInteger(credits)) {
        throw new Error("Data Router credits exceed the supported range");
      }
    }
    if (credits === 0) {
      return;
    }
    await set(recordDataRouterUsage$, attribution, credits, signal);
    signal.throwIfAborted();
  },
);
