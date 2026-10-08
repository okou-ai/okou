import { vncHostSchema } from "@okouai/api-contracts/contracts/vnc-access";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { and, asc, eq } from "drizzle-orm";

import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import type { VncOwner } from "./vnc-owner-lifecycle.service";
import {
  runThreadExists,
  runThreadSshAccess,
  runThreadVncAccess,
} from "./run-thread-remote-access.service";

export const listRunVncHosts$ = command(
  async (
    { set },
    owner: VncOwner & { readonly runId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    // The left joins preserve an authorized empty inventory in the same snapshot.
    const rows = await db
      .select({
        id: vncConnections.id,
        transportType: vncConnections.transportType,
        sshNeedsRebind: sshConnections.needsRebind,
        sshAllowed: runThreadSshAccess(),
        displayName: vncConnections.displayName,
        host: vncConnections.host,
        port: vncConnections.port,
        authMethod: vncConnections.authMethod,
        securityType: vncConnections.securityType,
      })
      .from(agentRuns)
      .innerJoin(
        agentSessions,
        and(
          eq(agentSessions.id, agentRuns.sessionId),
          eq(agentSessions.orgId, agentRuns.orgId),
          eq(agentSessions.userId, agentRuns.userId),
        ),
      )
      .innerJoin(
        agents,
        and(
          eq(agents.id, agentSessions.agentId),
          eq(agents.orgId, agentRuns.orgId),
          visibleJoinedAgentCondition(owner.userId),
        ),
      )
      .leftJoin(
        vncConnections,
        and(
          eq(vncConnections.orgId, agentRuns.orgId),
          eq(vncConnections.userId, agentRuns.userId),
          runThreadVncAccess(),
        ),
      )
      .leftJoin(
        sshConnections,
        and(
          eq(sshConnections.id, vncConnections.sshConnectionId),
          eq(sshConnections.orgId, agentRuns.orgId),
          eq(sshConnections.userId, agentRuns.userId),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, owner.runId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.status, "running"),
          runThreadExists(),
        ),
      )
      .orderBy(asc(vncConnections.displayName), asc(vncConnections.id));
    signal.throwIfAborted();
    if (rows.length === 0) {
      return null;
    }
    return {
      hosts: rows.flatMap((row) => {
        if (row.id === null) {
          return [];
        }
        if (row.transportType === "ssh" && !row.sshAllowed) {
          return [];
        }
        // The owner-scoped FK and transport check require this join to exist.
        if (row.transportType === "ssh" && row.sshNeedsRebind === null) {
          throw new Error("VNC SSH connection reference is missing");
        }
        return [
          vncHostSchema.parse({
            id: row.id,
            displayName: row.displayName,
            host: row.host,
            port: row.port,
            authMethod: row.authMethod,
            securityType: row.securityType,
            availability:
              row.transportType === "ssh" && row.sshNeedsRebind
                ? { status: "blocked", reason: "needs_rebind" }
                : { status: "ready" },
          }),
        ];
      }),
    };
  },
);
