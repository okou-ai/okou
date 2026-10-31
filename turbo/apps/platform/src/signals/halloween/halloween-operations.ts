import { command, computed, state } from "ccstate";
import { halloweenOperationsContract } from "@okouai/api-contracts/client/halloween";
import type { HalloweenParticipant } from "@okouai/api-contracts/contracts/halloween";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { searchParams$, updateSearchParams$ } from "../route.ts";

interface Batch {
  id: string;
  capturedAt: string;
  participants: HalloweenParticipant[];
}
const batchState$ = state<Batch | null>(null);
const pendingBatchId$ = state<string | null>(null);
const reviewedState$ = state<
  Partial<Record<string, "winner" | "not_selected">>
>({});
export const halloweenBatch$ = computed((get) => {
  return get(batchState$);
});
export const halloweenReviewed$ = computed((get) => {
  return get(reviewedState$);
});
export const initializeHalloweenOperations$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(batchState$, null);
    set(reviewedState$, {});
    set(pendingBatchId$, null);
    const id = get(searchParams$).get("batch");
    if (!id) {
      return;
    }
    const result = await accept(
      get(apiClient$)(halloweenOperationsContract).batch({
        params: { id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(batchState$, result.body);
  },
);
export const captureHalloweenBatch$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const id = get(pendingBatchId$) ?? crypto.randomUUID();
    set(pendingBatchId$, id);
    const result = await accept(
      get(apiClient$)(halloweenOperationsContract).capture({
        body: { id },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(batchState$, result.body);
    set(reviewedState$, {});
    set(pendingBatchId$, null);
    set(updateSearchParams$, new URLSearchParams({ batch: id }));
  },
);
export const reviewHalloweenAccount$ = command(
  async (
    { get, set },
    userId: string,
    decision: "winner" | "not_selected",
    signal: AbortSignal,
  ) => {
    const batch = get(batchState$);
    if (!batch) {
      return;
    }
    await accept(
      get(apiClient$)(halloweenOperationsContract).review({
        body: { batchId: batch.id, userId, decision },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    set(reviewedState$, { ...get(reviewedState$), [userId]: decision });
  },
);
function csvCell(value: unknown) {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export const downloadHalloweenBatch$ = command(
  ({ get }, format: "csv" | "json") => {
    const batch = get(batchState$);
    if (!batch) {
      return;
    }
    const columns = [
      "batchId",
      "capturedAt",
      "userId",
      "email",
      "orgId",
      "firstPlayedAt",
      "lastPlayedAt",
      "decision",
      "notifiedAt",
      "rewardedAt",
      "rounds",
    ];
    const rows = batch.participants.map((p) => {
      return [
        batch.id,
        batch.capturedAt,
        p.userId,
        p.email,
        p.orgId,
        p.firstPlayedAt,
        p.lastPlayedAt,
        p.decision,
        p.notifiedAt,
        p.rewardedAt,
        JSON.stringify(p.rounds),
      ];
    });
    const text =
      format === "json"
        ? JSON.stringify(batch, null, 2)
        : "\uFEFF" +
          [columns, ...rows]
            .map((row) => {
              return row.map(csvCell).join(",");
            })
            .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([text], {
        type: format === "json" ? "application/json" : "text/csv;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `halloween-${batch.id}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  },
);
