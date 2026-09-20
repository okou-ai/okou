import {
  clientTelemetryOutcomeForError,
  recordClientTelemetry,
  startClientTelemetryMeasurement,
  type ClientTelemetryOperation,
} from "../../lib/client-telemetry.ts";
import { onRejection } from "../utils.ts";

interface IndexedDbTransactionLike {
  readonly done: Promise<unknown>;
  readonly mode: IDBTransactionMode;
}

interface IndexedDbTransactionDetails {
  readonly database: "chat" | "voice_drafts";
  /** Stable operation shape only. Never include keys, ranges, or values. */
  readonly template: string;
  readonly transaction_mode: IDBTransactionMode;
}

type TrackIndexedDbRequest = <TResult>(
  request: Promise<TResult>,
) => Promise<TResult>;

async function observeTransactionCompletion(
  transaction: IndexedDbTransactionLike,
): Promise<void> {
  await Promise.allSettled([transaction.done]);
}

export async function runIndexedDbTransaction<
  TTransaction extends IndexedDbTransactionLike,
  TResult,
>(
  details: IndexedDbTransactionDetails,
  createTransaction: () => TTransaction,
  execute: (
    transaction: TTransaction,
    trackRequest: TrackIndexedDbRequest,
  ) => Promise<TResult>,
): Promise<TResult> {
  const creationMeasurement = startClientTelemetryMeasurement();
  const creationOperation = {
    event_name: "indexeddb.transaction.create",
    database: details.database,
    template: details.template,
    transaction_mode: details.transaction_mode,
  } satisfies ClientTelemetryOperation;
  const transaction = await onRejection(createTransaction, (error) => {
    recordClientTelemetry(
      creationMeasurement,
      creationOperation,
      clientTelemetryOutcomeForError(error),
    );
  });
  const measurement = startClientTelemetryMeasurement();
  recordClientTelemetry(creationMeasurement, creationOperation, "success");
  let requestCount = 0;
  const trackRequest: TrackIndexedDbRequest = (request) => {
    requestCount += 1;
    return request;
  };

  const result = await onRejection(
    (async () => {
      const result = await execute(transaction, trackRequest);
      await transaction.done;
      return result;
    })(),
    async (error) => {
      // Observe the physical transaction through completion without replacing
      // the operation's original failure.
      await observeTransactionCompletion(transaction);
      recordClientTelemetry(
        measurement,
        {
          event_name: "indexeddb.transaction",
          database: details.database,
          template: details.template,
          transaction_mode: transaction.mode,
          request_count: requestCount,
        },
        clientTelemetryOutcomeForError(error),
      );
    },
  );
  recordClientTelemetry(
    measurement,
    {
      event_name: "indexeddb.transaction",
      database: details.database,
      template: details.template,
      transaction_mode: transaction.mode,
      request_count: requestCount,
    },
    "success",
  );
  return result;
}
