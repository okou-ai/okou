import { command } from "ccstate";
import type { RunnerVncResolveRequest } from "@okouai/api-contracts/contracts/runner-vnc";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  sshConnectionNeedsRebind,
  sshConnections,
} from "@okouai/db/runtime/ssh-connection";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { and, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { vncCreationTimestamp } from "./remote-connection-creation-timestamp.utils";
import {
  vncNetworkAliases,
  visibleVncNetworkConfig,
} from "./vnc-network-authority";
import {
  runThreadSshAccess,
  runThreadVncAccess,
} from "./run-thread-remote-access.service";

type RunnerVncInput = Pick<
  RunnerVncResolveRequest,
  "connectionId" | "runnerIdentity"
> & { readonly runId: string };
const kdcSsh = alias(sshConnections, "vnc_kdc_ssh");
const { rfbAccess, rfbTailscale, kdcAccess, kdcTailscale } = vncNetworkAliases;
const kdcSshNeedsRebind =
  sql`(${kdcSsh.connectionMode} = 'cloudflare_access' AND ${kdcSsh.cloudflareAccessId} IS NULL) OR
          (${kdcSsh.connectionMode} IN ('tailscale', 'tailscale_ssh') AND ${kdcSsh.tailscaleId} IS NULL)`.mapWith(
    nullableDriverValueDecoder(pgBooleanDecoder),
  );

const currentVncSelection = Object.freeze({
  generation: vncConnections.generation,
  createdAt: vncCreationTimestamp,
  orgId: agentRuns.orgId,
  userId: agentRuns.userId,
  host: vncConnections.host,
  port: vncConnections.port,
  transportType: vncConnections.transportType,
  sshConnectionId: vncConnections.sshConnectionId,
  cloudflareAccessId: vncConnections.cloudflareAccessId,
  tailscaleId: vncConnections.tailscaleId,
  originTlsServerName: vncConnections.originTlsServerName,
  originTlsTrustMode: vncConnections.originTlsTrustMode,
  originTlsCaBundle: vncConnections.originTlsCaBundle,
  kdcCloudflareAccessId: vncConnections.kdcCloudflareAccessId,
  kdcTailscaleId: vncConnections.kdcTailscaleId,
  rfbAccess: {
    id: rfbAccess.id,
    generation: rfbAccess.generation,
    encryptedClientId: rfbAccess.encryptedClientId,
    encryptedClientSecret: rfbAccess.encryptedClientSecret,
  },
  rfbTailscale: {
    id: rfbTailscale.id,
    generation: rfbTailscale.generation,
    encryptedClientId: rfbTailscale.encryptedClientId,
    encryptedClientSecret: rfbTailscale.encryptedClientSecret,
    tags: rfbTailscale.tags,
  },
  kdcAccess: {
    id: kdcAccess.id,
    generation: kdcAccess.generation,
    encryptedClientId: kdcAccess.encryptedClientId,
    encryptedClientSecret: kdcAccess.encryptedClientSecret,
  },
  kdcTailscale: {
    id: kdcTailscale.id,
    generation: kdcTailscale.generation,
    encryptedClientId: kdcTailscale.encryptedClientId,
    encryptedClientSecret: kdcTailscale.encryptedClientSecret,
    tags: kdcTailscale.tags,
  },
  sshGeneration: sshConnections.generation,
  sshNeedsRebind: sql`${sshConnectionNeedsRebind}`.mapWith(
    nullableDriverValueDecoder(pgBooleanDecoder),
  ),
  sshAllowed: runThreadSshAccess(),
  x509ServerName: vncConnections.x509ServerName,
  securityType: vncConnections.securityType,
  trustMode: vncConnections.trustMode,
  caBundle: vncConnections.caBundle,
  rsaServerKeySha256: vncConnections.rsaServerKeySha256,
  authMethod: vncConnections.authMethod,
  credentialId: vncConnections.credentialId,
  joinedCredentialId: vncCredentials.id,
  username: vncCredentials.username,
  encryptedPassword: vncCredentials.encryptedPassword,
  encryptedClientIdentity: vncCredentials.encryptedClientIdentity,
  credentialRevision: vncCredentials.revision,
  encryptedKerberosCredential: vncCredentials.encryptedKerberosCredential,
  kerberosInitiator: vncCredentials.kerberosInitiator,
  kerberosCredentialService: vncCredentials.kerberosService,
  kerberosDeclaredExpiresAt: vncCredentials.kerberosDeclaredExpiresAt,
  kerberosService: vncConnections.kerberosService,
  kdcHost: vncConnections.kdcHost,
  kdcPort: vncConnections.kdcPort,
  kdcTransportType: vncConnections.kdcTransportType,
  kdcSshConnectionId: vncConnections.kdcSshConnectionId,
  kerberosTicketLifetimeSeconds: vncConnections.kerberosTicketLifetimeSeconds,
  kerberosRenewableLifetimeSeconds:
    vncConnections.kerberosRenewableLifetimeSeconds,
  kdcSshGeneration: kdcSsh.generation,
  kdcSshAllowed: runThreadSshAccess(kdcSsh),
  kdcSshNeedsRebind,
});

/** Always read current authorization from the primary database. */
export const currentRunnerVncAuthority$ = command(
  async ({ get }, input: RunnerVncInput, signal: AbortSignal) => {
    const db = get(db$);
    const [row] = await db
      .select(currentVncSelection)
      .from(agentRuns)

      .innerJoin(
        agents,
        and(
          eq(agents.id, agentRuns.agentId),
          eq(agents.orgId, agentRuns.orgId),
          or(
            eq(agents.visibility, "public"),
            eq(agents.owner, agentRuns.userId),
          ),
        ),
      )
      .innerJoin(
        vncConnections,
        and(
          eq(vncConnections.id, input.connectionId),
          eq(vncConnections.orgId, agentRuns.orgId),
          eq(vncConnections.userId, agentRuns.userId),
        ),
      )
      .leftJoin(
        vncCredentials,
        and(
          eq(vncCredentials.id, vncConnections.credentialId),
          eq(vncCredentials.orgId, agentRuns.orgId),
          eq(vncCredentials.userId, agentRuns.userId),
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
      .leftJoin(
        kdcSsh,
        and(
          eq(kdcSsh.id, vncConnections.kdcSshConnectionId),
          eq(kdcSsh.orgId, agentRuns.orgId),
          eq(kdcSsh.userId, agentRuns.userId),
        ),
      )
      .leftJoin(
        rfbAccess,
        visibleVncNetworkConfig(rfbAccess, vncConnections.cloudflareAccessId),
      )
      .leftJoin(
        rfbTailscale,
        visibleVncNetworkConfig(rfbTailscale, vncConnections.tailscaleId),
      )
      .leftJoin(
        kdcAccess,
        visibleVncNetworkConfig(
          kdcAccess,
          vncConnections.kdcCloudflareAccessId,
        ),
      )
      .leftJoin(
        kdcTailscale,
        visibleVncNetworkConfig(kdcTailscale, vncConnections.kdcTailscaleId),
      )
      .where(
        and(
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, "running"),
          eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
          eq(
            agentRuns.runnerHeartbeatGeneration,
            input.runnerIdentity.heartbeatGeneration,
          ),
          runThreadVncAccess(),
        ),
      );
    signal.throwIfAborted();
    return row ?? null;
  },
);

export type CurrentVncAuthority = NonNullable<
  Awaited<ReturnType<(typeof currentRunnerVncAuthority$)["write"]>>
>;
