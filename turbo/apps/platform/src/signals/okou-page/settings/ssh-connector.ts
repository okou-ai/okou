import { computed } from "ccstate";
import { agentSshAccessContract } from "@okouai/api-contracts/contracts/ssh-access";
import { accept } from "../../../lib/accept.ts";
import { i18n } from "../../../i18n/index.ts";
import { agents$ } from "../../agent.ts";
import { apiClient$ } from "../../api-client.ts";
import { sshAgentAccessRows$, sshSummary$ } from "../../ssh.ts";
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
  if (filter.kind === "unshared") {
    const rows = await get(sshAgentAccessRows$);
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
      get(apiClient$)(agentSshAccessContract).get({
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
