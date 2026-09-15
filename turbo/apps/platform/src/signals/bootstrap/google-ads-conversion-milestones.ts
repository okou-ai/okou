import { GOOGLE_ADS_ADSMARCH_ACCOUNT_ID } from "@okouai/core/google-ads-account";
import { command, state } from "ccstate";
import {
  acquisitionAttributionContract,
  type GoogleAdsConversionMilestoneKind,
} from "@okouai/api-contracts/contracts/acquisition-attribution";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { user$ } from "../auth.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { jsonParseOr } from "../utils.ts";
import {
  fireGoogleAdsConversion,
  GOOGLE_ADS_ADSMARCH_FIRST_RUN_COMPLETED_SEND_TO,
  GOOGLE_ADS_ADSMARCH_FREE_TRIAL_COMPLETED_SEND_TO,
  GOOGLE_ADS_ADSMARCH_MULTI_DAY_RUN_COMPLETED_SEND_TO,
  GOOGLE_ADS_ADSMARCH_ONE_CONNECTOR_CONNECTED_SEND_TO,
  GOOGLE_ADS_ADSMARCH_SECOND_RUN_COMPLETED_SEND_TO,
  GOOGLE_ADS_ADSMARCH_TWO_CONNECTORS_CONNECTED_SEND_TO,
} from "./google-ads-conversion.ts";

const GOOGLE_ADS_MILESTONE_STORAGE_KEY =
  "googleAds.18407336975.conversionMilestones";

const milestoneStorage = localStorageSignals(GOOGLE_ADS_MILESTONE_STORAGE_KEY);
const bootstrappedUserIds$ = state<ReadonlySet<string>>(new Set());

interface StoredMilestoneState {
  readonly transactionIds: readonly string[];
}

type StoredMilestonesByUser = Readonly<Record<string, StoredMilestoneState>>;

const MILESTONE_CONFIG = {
  free_trial_completed: {
    sendTo: GOOGLE_ADS_ADSMARCH_FREE_TRIAL_COMPLETED_SEND_TO,
    value: 15,
  },
  first_run_completed: {
    sendTo: GOOGLE_ADS_ADSMARCH_FIRST_RUN_COMPLETED_SEND_TO,
    value: 5,
  },
  second_run_completed: {
    sendTo: GOOGLE_ADS_ADSMARCH_SECOND_RUN_COMPLETED_SEND_TO,
    value: 10,
  },
  multi_day_run_completed: {
    sendTo: GOOGLE_ADS_ADSMARCH_MULTI_DAY_RUN_COMPLETED_SEND_TO,
    value: 15,
  },
  one_connector_connected: {
    sendTo: GOOGLE_ADS_ADSMARCH_ONE_CONNECTOR_CONNECTED_SEND_TO,
    value: 8,
  },
  two_connectors_connected: {
    sendTo: GOOGLE_ADS_ADSMARCH_TWO_CONNECTORS_CONNECTED_SEND_TO,
    value: 15,
  },
} satisfies Readonly<
  Record<
    GoogleAdsConversionMilestoneKind,
    { readonly sendTo: string; readonly value: number }
  >
>;

function storedMilestonesByUser(raw: string | null): StoredMilestonesByUser {
  if (!raw) {
    return {};
  }
  const parsed = jsonParseOr<unknown>(raw, null);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const result: Record<string, StoredMilestoneState> = {};
  for (const [userId, value] of Object.entries(parsed)) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !("transactionIds" in value) ||
      !Array.isArray(value.transactionIds) ||
      !value.transactionIds.every((transactionId: unknown) => {
        return typeof transactionId === "string";
      })
    ) {
      continue;
    }
    result[userId] = { transactionIds: value.transactionIds };
  }
  return result;
}

function writeUserMilestoneState(
  stored: StoredMilestonesByUser,
  userId: string,
  transactionIds: Iterable<string>,
): string {
  return JSON.stringify({
    ...stored,
    [userId]: { transactionIds: [...transactionIds] },
  });
}

export const syncGoogleAdsConversionMilestones$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
    const user = await get(user$);
    signal.throwIfAborted();
    if (!user) {
      return false;
    }

    const client = get(apiClient$)(acquisitionAttributionContract);
    const response = await accept(
      client.googleAdsMilestones({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();

    // Old-account milestones use UPLOAD_CLICKS, not these website actions.
    // Unresolved ownership must not initialize or advance the delivery state.
    if (response.body.googleAdsAccountId !== GOOGLE_ADS_ADSMARCH_ACCOUNT_ID) {
      return false;
    }

    const stored = storedMilestonesByUser(get(milestoneStorage.get$));
    const previous = stored[user.id];
    if (!previous) {
      set(
        milestoneStorage.set$,
        writeUserMilestoneState(
          stored,
          user.id,
          response.body.milestones.map((item) => {
            return item.transactionId;
          }),
        ),
      );
      return true;
    }

    const deliveredTransactionIds = new Set(previous.transactionIds);
    let changed = false;
    for (const item of response.body.milestones) {
      if (deliveredTransactionIds.has(item.transactionId)) {
        continue;
      }
      const config = MILESTONE_CONFIG[item.kind];
      const fired = fireGoogleAdsConversion({
        accountId: response.body.googleAdsAccountId,
        sendTo: config.sendTo,
        dedupeValue: item.transactionId,
        value: config.value,
        storedDedupeValue: null,
        transactionId: item.transactionId,
      });
      if (fired) {
        deliveredTransactionIds.add(item.transactionId);
        changed = true;
      }
    }
    if (changed) {
      set(
        milestoneStorage.set$,
        writeUserMilestoneState(stored, user.id, deliveredTransactionIds),
      );
    }
    return true;
  },
);

export const bootstrapGoogleAdsConversionMilestones$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const user = await get(user$);
    signal.throwIfAborted();
    if (!user || get(bootstrappedUserIds$).has(user.id)) {
      return;
    }
    const resolved = await set(syncGoogleAdsConversionMilestones$, signal);
    signal.throwIfAborted();
    if (!resolved) {
      return;
    }
    set(bootstrappedUserIds$, (previous) => {
      return new Set([...previous, user.id]);
    });
  },
);
