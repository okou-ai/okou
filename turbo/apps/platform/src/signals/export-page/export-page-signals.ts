import { command, computed, state } from "ccstate";
import {
  userExportContract,
  type UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { resetSignal, setLoop } from "../utils.ts";

const POLL_INTERVAL_MS = 5000;

const statusRequest$ = state<Promise<UserExportStatusResponse> | null>(null);
const exportStartError$ = state<string | null>(null);
const resetStatusPolling$ = resetSignal();

function isStatusInProgress(status: UserExportStatusResponse): boolean {
  return status.job?.status === "pending" || status.job?.status === "running";
}

export const userExportStartError$ = computed((get) => {
  return get(exportStartError$);
});

export const userExportStatus$ = computed(async (get) => {
  return await get(statusRequest$);
});

const fetchUserExportStatus$ = command(
  async ({ get }, signal: AbortSignal): Promise<UserExportStatusResponse> => {
    signal.throwIfAborted();
    const client = get(apiClient$)(userExportContract);
    const response = await accept(
      client.get({ fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    return response.body;
  },
);

const refreshUserExportStatus$ = command(
  async ({ set }, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const request = set(fetchUserExportStatus$, signal);
    set(statusRequest$, request);
    const status = await request;
    signal.throwIfAborted();
    return !isStatusInProgress(status);
  },
);

const watchUserExportStatus$ = command(({ set }, signal: AbortSignal): void => {
  const pollingSignal = set(resetStatusPolling$, signal);
  setLoop(
    (loopSignal) => {
      return set(refreshUserExportStatus$, loopSignal);
    },
    POLL_INTERVAL_MS,
    pollingSignal,
  );
});

export const initializeUserExport$ = command(
  ({ set }, signal: AbortSignal): void => {
    set(exportStartError$, null);
    set(watchUserExportStatus$, signal);
  },
);

export const startUserExport$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    set(exportStartError$, null);

    const client = get(apiClient$)(userExportContract);
    const result = await accept(
      client.post({
        body: undefined,
        fetchOptions: { signal },
      }),
      [202, 429],
    );
    signal.throwIfAborted();

    if (result.status === 202) {
      set(watchUserExportStatus$, signal);
      return;
    }

    set(
      exportStartError$,
      i18n.t(($) => {
        return $.settings.export.errors.rateLimited;
      }),
    );
    set(watchUserExportStatus$, signal);
  },
);
