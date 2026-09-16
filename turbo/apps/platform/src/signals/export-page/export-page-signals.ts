import { command, computed, state } from "ccstate";
import {
  userExportContract,
  type UserExportStatusResponse,
} from "@okouai/api-contracts/contracts/user-export";
import { accept } from "../../lib/accept.ts";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { onRef, setLoop } from "../utils.ts";

const POLL_INTERVAL_MS = 5000;

const statusReload$ = state(0);
const exportStartError$ = state<string | null>(null);

function isStatusInProgress(status: UserExportStatusResponse): boolean {
  return status.job?.status === "pending" || status.job?.status === "running";
}

export const userExportStartError$ = computed((get) => {
  return get(exportStartError$);
});

export const userExportStatus$ = computed(
  async (get): Promise<UserExportStatusResponse> => {
    get(statusReload$);
    const client = get(apiClient$)(userExportContract);
    const result = await accept(client.get(), [200]);
    return result.body;
  },
);

const reloadUserExportStatus$ = command(({ set }) => {
  set(statusReload$, (value) => {
    return value + 1;
  });
});

const watchUserExportStatus$ = command(
  ({ get, set }, signal: AbortSignal): void => {
    setLoop(
      async (loopSignal) => {
        set(reloadUserExportStatus$);
        const status = await get(userExportStatus$);
        loopSignal.throwIfAborted();
        return !isStatusInProgress(status);
      },
      POLL_INTERVAL_MS,
      signal,
    );
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
      set(reloadUserExportStatus$);
      return;
    }

    set(
      exportStartError$,
      i18n.t(($) => {
        return $.settings.export.errors.rateLimited;
      }),
    );
    set(reloadUserExportStatus$);
  },
);

export const userExportStatusPollingRef$ = onRef(
  command(({ set }, _el: HTMLElement, signal: AbortSignal) => {
    set(watchUserExportStatus$, signal);
  }),
);
