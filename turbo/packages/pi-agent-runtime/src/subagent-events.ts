import {
  toJsonEvent,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

/** Use the RPC wire projection, not native cumulative session snapshots. */
export function serializePiSubagentEvent(event: AgentSessionEvent): string {
  return `${JSON.stringify(toJsonEvent(event))}\n`;
}
