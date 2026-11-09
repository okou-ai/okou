import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { settleIncludingAbort } from "../utils";

interface BrowserLifecycleFact {
  readonly lifecycleEvent:
    | "retirement-claimed"
    | "retirement-resumed"
    | "native-close-requested"
    | "binding-released"
    | "provider-gone"
    | "provider-stop-requested"
    | "provider-stop-confirmed"
    | "unpublished-native-close-requested";
  /** Okou's non-secret instance UUID, never the provider session ID. */
  readonly instanceId: string | null;
  readonly primaryWindowId?: number | null;
  readonly idleExpired?: boolean;
  readonly instanceExpired?: boolean;
  readonly threadDeleted?: boolean;
  readonly nativeMissing?: boolean;
  readonly providerStatus?: "missing" | "stopped";
}

/** Queue before the native effect; the request lifecycle owns the final flush. */
export function recordBrowserLifecycleFact(fact: BrowserLifecycleFact): void {
  waitUntil(
    settleIncludingAbort(() => {
      return ingestToAxiom(getDatasetName("web-logs"), [
        {
          _time: nowDate().toISOString(),
          type: "managed_browser_lifecycle",
          source: "api",
          api_commit_sha: env("GIT_COMMIT_SHA"),
          ...fact,
        },
      ]);
    }),
  );
}
