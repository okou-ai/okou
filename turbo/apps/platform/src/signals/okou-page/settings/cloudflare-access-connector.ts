import { computed } from "ccstate";

import { i18n } from "../../../i18n/index.ts";
import { cloudflareAccessSummary$ } from "../../cloudflare-access.ts";
import {
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  connectorsSearch$,
} from "./connectors.ts";
import { REMOTE_ACCESS_CATEGORY } from "./ssh-connector.ts";

export const filteredCloudflareAccessSummary$ = computed(async (get) => {
  const category = get(connectorsCategoryFilter$);
  if (category !== null && category !== REMOTE_ACCESS_CATEGORY) {
    return null;
  }
  const filter = get(connectorsConnectionFilter$);
  if (filter.kind === "agent" || filter.kind === "unshared") {
    return null;
  }
  const search = get(connectorsSearch$).trim().toLowerCase();
  const description = i18n.t(($) => {
    return $.cloudflareAccess.description;
  });
  if (!`cloudflare access ${description}`.toLowerCase().includes(search)) {
    return null;
  }
  const summary = await get(cloudflareAccessSummary$);
  if (!summary) {
    return null;
  }
  if (filter.kind === "connected" && summary.configuredCount === 0) {
    return null;
  }
  if (filter.kind === "not-connected" && summary.configuredCount > 0) {
    return null;
  }
  return summary;
});
