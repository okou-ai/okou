import { randomUUID } from "node:crypto";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, eq, ne, or, sql, type SQL, type Subquery } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import type { createSshUpdateReads } from "./ssh-binding-query";
import type {
  PreparedSshConnectionCreation,
  PreparedSshConnectionUpdate,
} from "./ssh-connection.service";

type Owner = { readonly orgId: string; readonly userId: string };
type PreparedCredential = NonNullable<
  PreparedSshConnectionCreation["preparedCredential"]["create"]
>;
function bindingTransport(
  args: Pick<
    PreparedSshConnectionCreation,
    "preparedTailscale" | "tailscaleId" | "preparedAccess" | "accessId"
  >,
): (typeof sshConnections.$inferSelect)["transport"] {
  return args.preparedTailscale !== undefined || args.tailscaleId !== null
    ? "tailscale"
    : args.preparedAccess !== undefined || args.accessId !== null
      ? "cloudflare_access"
      : "direct";
}
export function sshBindingUpdateValues(
  args: PreparedSshConnectionUpdate,
  current: ReturnType<typeof createSshUpdateReads>["current"],
  credential: SQL,
  access: SQL,
  tailscale: SQL,
) {
  const transport = bindingTransport(args);
  const clear = and(
    eq(current.transport, "direct"),
    sql`${transport === "direct"}`,
    or(ne(current.host, args.host), ne(current.port, args.port)),
  );
  return {
    displayName: args.body.displayName ?? current.displayName,
    host: args.host,
    port: args.port,
    credentialId: credential,
    cloudflareAccessId: access,
    tailscaleId: tailscale,
    transport,
    legacyNeedsRebind: false,
    learnedHostKeyAlgorithm: sql`CASE WHEN ${clear} THEN NULL ELSE ${current.learnedHostKeyAlgorithm} END`,
    learnedHostKeyFingerprint: sql`CASE WHEN ${clear} THEN NULL ELSE ${current.learnedHostKeyFingerprint} END`,
    generation: sql`${current.generation} + 1`,
    updatedAt: nowDate(),
  };
}
// INSERT SELECT requires every schema field, in schema order. Explicit aliases
// preserve both Drizzle's input contract and inspectable runtime column mapping.
export function inlineSshCredentialSource(
  owner: Owner,
  prepared: PreparedCredential,
  ready: Subquery,
) {
  const at = nowDate();
  return new QueryBuilder()
    .select({
      id: sql`${randomUUID()}::uuid`.mapWith(sshCredentials.id).as("id"),
      orgId: sql`${owner.orgId}`.mapWith(sshCredentials.orgId).as("org_id"),
      userId: sql`${owner.userId}`.mapWith(sshCredentials.userId).as("user_id"),
      name: sql`${prepared.name}`.mapWith(sshCredentials.name).as("name"),
      username: sql`${prepared.username}`
        .mapWith(sshCredentials.username)
        .as("username"),
      authMethod: sql`${prepared.authMethod}`
        .mapWith(sshCredentials.authMethod)
        .as("auth_method"),
      encryptedPrivateKey: sql`${prepared.encryptedPrivateKey}`
        .mapWith(sshCredentials.encryptedPrivateKey)
        .as("encrypted_private_key"),
      encryptedPassphrase: sql`${prepared.encryptedPassphrase}`
        .mapWith(sshCredentials.encryptedPassphrase)
        .as("encrypted_passphrase"),
      encryptedPassword: sql`${prepared.encryptedPassword}`
        .mapWith(sshCredentials.encryptedPassword)
        .as("encrypted_password"),
      revision: sql`1`.mapWith(sshCredentials.revision).as("revision"),
      createdAt: sql`${sql.param(at, sshCredentials.createdAt)}`
        .mapWith(sshCredentials.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(at, sshCredentials.updatedAt)}`
        .mapWith(sshCredentials.updatedAt)
        .as("updated_at"),
    })
    .from(ready);
}
export function inlineSshAccessSource(
  owner: Owner,
  prepared: NonNullable<PreparedSshConnectionCreation["preparedAccess"]>,
  ready: Subquery,
) {
  const at = nowDate();
  return new QueryBuilder()
    .select({
      id: sql`${randomUUID()}::uuid`
        .mapWith(cloudflareAccessConfigs.id)
        .as("id"),
      orgId: sql`${owner.orgId}`
        .mapWith(cloudflareAccessConfigs.orgId)
        .as("org_id"),
      userId: sql`${owner.userId}`
        .mapWith(cloudflareAccessConfigs.userId)
        .as("user_id"),
      scope: sql`'personal'`.mapWith(cloudflareAccessConfigs.scope).as("scope"),
      name: sql`${prepared.name}`
        .mapWith(cloudflareAccessConfigs.name)
        .as("name"),
      encryptedClientId: sql`${prepared.encryptedClientId}`
        .mapWith(cloudflareAccessConfigs.encryptedClientId)
        .as("encrypted_client_id"),
      encryptedClientSecret: sql`${prepared.encryptedClientSecret}`
        .mapWith(cloudflareAccessConfigs.encryptedClientSecret)
        .as("encrypted_client_secret"),
      revision: sql`1`.mapWith(cloudflareAccessConfigs.revision).as("revision"),
      generation: sql`1`
        .mapWith(cloudflareAccessConfigs.generation)
        .as("generation"),
      createdAt: sql`${sql.param(at, cloudflareAccessConfigs.createdAt)}`
        .mapWith(cloudflareAccessConfigs.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(at, cloudflareAccessConfigs.updatedAt)}`
        .mapWith(cloudflareAccessConfigs.updatedAt)
        .as("updated_at"),
    })
    .from(ready);
}
export function inlineSshTailscaleSource(
  owner: Owner,
  prepared: NonNullable<PreparedSshConnectionCreation["preparedTailscale"]>,
  ready: Subquery,
) {
  const at = nowDate();
  return new QueryBuilder()
    .select({
      id: sql`${randomUUID()}::uuid`.mapWith(tailscaleConfigs.id).as("id"),
      orgId: sql`${owner.orgId}`.mapWith(tailscaleConfigs.orgId).as("org_id"),
      userId: sql`${owner.userId}`
        .mapWith(tailscaleConfigs.userId)
        .as("user_id"),
      scope: sql`'personal'`.mapWith(tailscaleConfigs.scope).as("scope"),
      name: sql`${prepared.name}`.mapWith(tailscaleConfigs.name).as("name"),
      encryptedClientId: sql`${prepared.encryptedClientId}`
        .mapWith(tailscaleConfigs.encryptedClientId)
        .as("encrypted_client_id"),
      encryptedClientSecret: sql`${prepared.encryptedClientSecret}`
        .mapWith(tailscaleConfigs.encryptedClientSecret)
        .as("encrypted_client_secret"),
      tags: sql`${sql.param(prepared.tags, tailscaleConfigs.tags)}`
        .mapWith(tailscaleConfigs.tags)
        .as("tags"),
      revision: sql`1`.mapWith(tailscaleConfigs.revision).as("revision"),
      generation: sql`1`.mapWith(tailscaleConfigs.generation).as("generation"),
      createdAt: sql`${sql.param(at, tailscaleConfigs.createdAt)}`
        .mapWith(tailscaleConfigs.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(at, tailscaleConfigs.updatedAt)}`
        .mapWith(tailscaleConfigs.updatedAt)
        .as("updated_at"),
    })
    .from(ready);
}
export function sshConnectionCreationSource(
  args: PreparedSshConnectionCreation,
  ready: Subquery,
  credential: SQL,
  access: SQL,
  tailscale: SQL,
) {
  const at = nowDate();
  return new QueryBuilder()
    .select({
      id: sql`${args.body.id}::uuid`.mapWith(sshConnections.id).as("id"),
      orgId: sql`${args.orgId}`.mapWith(sshConnections.orgId).as("org_id"),
      userId: sql`${args.userId}`.mapWith(sshConnections.userId).as("user_id"),
      displayName: sql`${args.body.displayName}`
        .mapWith(sshConnections.displayName)
        .as("display_name"),
      host: sql`${args.canonicalHost}`.mapWith(sshConnections.host).as("host"),
      port: sql`${args.body.port}`.mapWith(sshConnections.port).as("port"),
      credentialId: credential
        .mapWith(sshConnections.credentialId)
        .as("credential_id"),
      cloudflareAccessId: access
        .mapWith(sshConnections.cloudflareAccessId)
        .as("cloudflare_access_id"),
      tailscaleId: tailscale
        .mapWith(sshConnections.tailscaleId)
        .as("tailscale_id"),
      transport: sql`${bindingTransport(args)}`
        .mapWith(sshConnections.transport)
        .as("transport"),
      legacyNeedsRebind: sql`false`
        .mapWith(sshConnections.legacyNeedsRebind)
        .as("needs_rebind"),
      learnedHostKeyAlgorithm: sql`NULL`
        .mapWith(sshConnections.learnedHostKeyAlgorithm)
        .as("learned_host_key_algorithm"),
      learnedHostKeyFingerprint: sql`NULL`
        .mapWith(sshConnections.learnedHostKeyFingerprint)
        .as("learned_host_key_fingerprint"),
      generation: sql`1`.mapWith(sshConnections.generation).as("generation"),
      defaultEnabledForChats: sql`false`
        .mapWith(sshConnections.defaultEnabledForChats)
        .as("default_enabled_for_chats"),
      createdAt: sql`${sql.param(at, sshConnections.createdAt)}`
        .mapWith(sshConnections.createdAt)
        .as("created_at"),
      updatedAt: sql`${sql.param(at, sshConnections.updatedAt)}`
        .mapWith(sshConnections.updatedAt)
        .as("updated_at"),
    })
    .from(ready);
}
