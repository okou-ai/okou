import { computed } from "ccstate";
import { i18n } from "../../../i18n/index.ts";
import { sshSummary$ } from "../../ssh.ts";
import {
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  connectorsSearch$,
} from "./connectors.ts";

export const REMOTE_ACCESS_CATEGORY = "remote-access";

export const filteredSshSummary$ = computed(async (get) => {
  const category = get(connectorsCategoryFilter$);
  if (category !== null && category !== REMOTE_ACCESS_CATEGORY) {
    return null;
  }
  const filter = get(connectorsConnectionFilter$);
  if (filter.kind === "agent" || filter.kind === "unshared") {
    return null;
  }
  const search = get(connectorsSearch$).trim().toLowerCase();
  const summary = await get(sshSummary$);
  if (!summary) {
    return null;
  }
  const description = i18n.t(($) => {
    return $.ssh.description;
  });
  if (!`ssh ${description}`.toLowerCase().includes(search)) {
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
