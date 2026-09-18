import { computed } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";
import { agents$ } from "../../agent.ts";
import { vncSummary$, vncClients$ } from "../../vnc.ts";
import { vncAgentAccessRows$ } from "../../vnc-access.ts";
import {
  connectorsCategoryFilter$,
  connectorsConnectionFilter$,
  connectorsSearch$,
} from "./connectors.ts";

import { REMOTE_ACCESS_CATEGORY } from "./ssh-connector.ts";

export const filteredVncSummary$ = computed(async (get) => {
  const category = get(connectorsCategoryFilter$);
  if (category !== null && category !== REMOTE_ACCESS_CATEGORY) {
    return null;
  }
  const filter = get(connectorsConnectionFilter$);
  const search = get(connectorsSearch$).trim().toLowerCase();
  const description = i18n.t(($) => {
    return $.vnc.description;
  });
  if (!`vnc ${description}`.toLowerCase().includes(search)) {
    return null;
  }
  const summary = await get(vncSummary$);
  if (!summary) {
    return null;
  }
  if (filter.kind === "connected" && summary.configuredCount === 0) {
    return null;
  }
  if (filter.kind === "not-connected" && summary.configuredCount > 0) {
    return null;
  }
  if (filter.kind === "unshared") {
    const rows = await get(vncAgentAccessRows$);
    if (
      rows === null ||
      rows.some((row) => {
        return row.enabled;
      })
    ) {
      return null;
    }
  }
  if (filter.kind === "agent") {
    const agents = await get(agents$);
    if (
      !agents.some((agent) => {
        return agent.agentId === filter.agentId;
      })
    ) {
      return null;
    }
    const result = await accept(
      (await get(vncClients$)).access.get({
        params: { agentId: filter.agentId },
      }),
      [200, 404],
      undefined,
      { showErrorToast: false },
    );
    if (result.status === 404 || !result.body.enabled) {
      return null;
    }
  }
  return summary;
});
