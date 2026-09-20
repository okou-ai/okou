import { command } from "ccstate";
import { morningBriefDebugTriggerContract } from "@okouai/api-contracts/contracts/morning-brief-debug-trigger";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";

/**
 * Bring the signed-in member's native Morning Brief forward from Settings >
 * Debug. The caller passes the Settings action signal, so dismissal cancels the
 * request. The endpoint only queues the obligation; the ordinary cron delivers
 * the brief within a minute, so there is nothing to navigate to here.
 */
export const triggerMorningBrief$ = command(
  async ({ get }, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(morningBriefDebugTriggerContract).trigger({
        body: {},
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
  },
);
