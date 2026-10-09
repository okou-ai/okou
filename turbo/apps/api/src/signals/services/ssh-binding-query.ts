import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import {
  and,
  eq,
  exists,
  isNull,
  lt,
  ne,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { visibleTailscaleConfig } from "./tailscale-config-model";
import type {
  PreparedSshConnectionCreation,
  PreparedSshConnectionUpdate,
} from "./ssh-connection.service";

// Drizzle's sessionless QueryBuilder cannot construct UPDATE. Keep this one
// DML leaf as SQL, with schema-owned identifiers, projection and predicates.
export function stampedSshTailscaleConfig(
  qb: QueryBuilder,
  alias: string,
  predicate: SQL,
) {
  return qb
    .$with(alias, { id: tailscaleConfigs.id })
    .as(
      sql`UPDATE ${tailscaleConfigs} SET ${sql.identifier(tailscaleConfigs.name.name)} = ${tailscaleConfigs.name} WHERE ${predicate} RETURNING ${tailscaleConfigs.id}`,
    );
}
type Owner = { readonly orgId: string; readonly userId: string };
export function visibleSshAccessConfig(owner: Owner, id: string) {
  return and(
    eq(cloudflareAccessConfigs.orgId, owner.orgId),
    eq(cloudflareAccessConfigs.id, id),
    or(
      eq(cloudflareAccessConfigs.scope, "organization"),
      and(
        eq(cloudflareAccessConfigs.scope, "personal"),
        eq(cloudflareAccessConfigs.userId, owner.userId),
      ),
    ),
  );
}
export function ownedSshConnection(
  owner: Owner & { readonly connectionId: string },
) {
  return and(
    eq(sshConnections.id, owner.connectionId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
}

// Sessionless reads only. Every dependent write belongs to the calling command.
export function createSshCreationReads(
  args: PreparedSshConnectionCreation,
  endpointValid: boolean,
) {
  const qb = new QueryBuilder();
  const anchor = qb.$with("requested_ssh_creation").as(
    qb
      .select({
        id: sql`${args.body.id}::uuid`
          .mapWith(sshConnections.id)
          .as("requested_host_id"),
      })
      .from(sql`(VALUES (1)) AS "ssh_creation_seed" ("present")`),
  );
  const current = qb.$with("existing_ssh_creation").as(
    qb
      .select({
        id: sshConnections.id,
        orgId: sshConnections.orgId,
        userId: sshConnections.userId,
      })
      .from(sshConnections)
      .where(eq(sshConnections.id, args.body.id)),
  );
  const base = qb.$with("eligible_ssh_creation").as(
    qb
      .select({ id: anchor.id })
      .from(anchor)
      .where(
        and(
          not(exists(qb.select({ id: current.id }).from(current))),
          sql`${endpointValid}`,
        ),
      ),
  );
  const credential = qb.$with("selected_ssh_creation_credential").as(
    qb
      .select({
        id: sshCredentials.id,
        name: sshCredentials.name,
        username: sshCredentials.username,
      })
      .from(sshCredentials)
      .where(
        and(
          eq(sshCredentials.orgId, args.orgId),
          eq(sshCredentials.userId, args.userId),
          args.preparedCredential.id === undefined
            ? sql`false`
            : eq(sshCredentials.id, args.preparedCredential.id),
        ),
      ),
  );
  const ready = qb.$with("ready_ssh_creation").as(
    qb
      .select({ id: base.id })
      .from(base)
      .where(
        args.preparedCredential.id === undefined
          ? sql`true`
          : exists(qb.select({ id: credential.id }).from(credential)),
      ),
  );
  const access = qb.$with("selected_ssh_creation_access").as(
    qb
      .select({ id: cloudflareAccessConfigs.id })
      .from(cloudflareAccessConfigs)
      .where(
        and(
          args.accessId === null
            ? sql`false`
            : visibleSshAccessConfig(args, args.accessId),
          exists(qb.select({ id: ready.id }).from(ready)),
        ),
      )
      .for("share"),
  );
  const admission = qb.$with("admitted_ssh_creation").as(
    qb
      .select({ id: ready.id })
      .from(ready)
      .where(
        args.accessId === null
          ? sql`true`
          : exists(qb.select({ id: access.id }).from(access)),
      ),
  );
  return {
    qb,
    anchor,
    current,
    base,
    credential,
    ready,
    access,
    admission,
    ctes: [anchor, current, base, credential, ready, access, admission],
  };
}

function createSshUpdateCoreReads(
  args: PreparedSshConnectionUpdate,
  endpointValid: boolean,
) {
  const qb = new QueryBuilder();
  const current = qb
    .$with("locked_ssh_binding_host")
    .as(
      qb
        .select()
        .from(sshConnections)
        .where(ownedSshConnection(args))
        .for("no key update"),
    );
  const base = qb.$with("eligible_ssh_binding_host").as(
    qb
      .select({ id: current.id })
      .from(current)
      .where(
        and(
          sql`${endpointValid}`,
          eq(current.generation, args.body.expectedGeneration),
          lt(current.generation, 2_147_483_647),
          args.body.transport !== undefined
            ? sql`true`
            : or(
                eq(current.transport, "direct"),
                and(
                  eq(current.transport, "tailscale"),
                  not(isNull(current.tailscaleId)),
                ),
                and(
                  eq(current.transport, "cloudflare_access"),
                  not(isNull(current.cloudflareAccessId)),
                ),
              ),
        ),
      ),
  );
  const prepared = args.preparedCredential;
  const credential = qb.$with("selected_ssh_binding_credential").as(
    qb
      .select({
        id: sshCredentials.id,
        name: sshCredentials.name,
        username: sshCredentials.username,
      })
      .from(sshCredentials)
      .where(
        and(
          eq(sshCredentials.orgId, args.orgId),
          eq(sshCredentials.userId, args.userId),
          prepared === undefined
            ? eq(
                sshCredentials.id,
                qb.select({ id: current.credentialId }).from(current),
              )
            : prepared.id === undefined
              ? sql`false`
              : eq(sshCredentials.id, prepared.id),
        ),
      ),
  );
  const ready = qb.$with("ready_ssh_binding_host").as(
    qb
      .select({ id: base.id })
      .from(base)
      .where(
        prepared !== undefined && prepared.id === undefined
          ? sql`true`
          : exists(qb.select({ id: credential.id }).from(credential)),
      ),
  );
  const access = qb.$with("selected_ssh_binding_access").as(
    qb
      .select({ id: cloudflareAccessConfigs.id })
      .from(cloudflareAccessConfigs)
      .where(
        and(
          args.accessId === null
            ? sql`false`
            : visibleSshAccessConfig(args, args.accessId),
          exists(qb.select({ id: ready.id }).from(ready)),
        ),
      )
      .for("share"),
  );
  const admission = qb.$with("admitted_ssh_binding_host").as(
    qb
      .select({ id: ready.id })
      .from(ready)
      .where(
        args.accessId === null
          ? sql`true`
          : exists(qb.select({ id: access.id }).from(access)),
      ),
  );
  return {
    qb,
    current,
    base,
    credential,
    ready,
    access,
    admission,
    ctes: [current, base, credential, ready, access, admission],
  };
}
export function createSshUpdateReads(
  args: PreparedSshConnectionUpdate,
  endpointValid: boolean,
) {
  const reads = createSshUpdateCoreReads(args, endpointValid);
  const { qb, current, admission } = reads;
  const tailscaleId =
    args.preparedTailscale === undefined ? args.tailscaleId : null;
  const retained = qb.$with("retained_ssh_binding_tailscale").as(
    qb
      .select({ id: tailscaleConfigs.id })
      .from(tailscaleConfigs)
      .where(
        and(
          tailscaleId === null
            ? sql`false`
            : visibleTailscaleConfig(args, tailscaleId),
          exists(
            qb
              .select({ id: admission.id })
              .from(admission)
              .innerJoin(current, eq(current.id, admission.id))
              .where(
                tailscaleId === null
                  ? sql`false`
                  : eq(current.tailscaleId, tailscaleId),
              ),
          ),
        ),
      )
      .for("share"),
  );
  const entering = exists(
    qb
      .select({ id: admission.id })
      .from(admission)
      .innerJoin(current, eq(current.id, admission.id))
      .where(
        tailscaleId === null
          ? sql`false`
          : or(
              isNull(current.tailscaleId),
              ne(current.tailscaleId, tailscaleId),
            ),
      ),
  );
  return { ...reads, retained, entering, ctes: [...reads.ctes, retained] };
}
