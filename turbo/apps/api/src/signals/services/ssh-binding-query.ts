import { sshConnections } from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { tailscaleConfigs } from "@okouai/db/schema/tailscale-config";
import {
  and,
  eq,
  exists,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import type {
  PreparedSshConnectionCreation,
  PreparedSshConnectionUpdate,
} from "./ssh-connection.service";

// Drizzle's sessionless QueryBuilder cannot construct UPDATE. Keep this one
// DML leaf as SQL, with schema-owned identifiers, projection and predicates.
// An entering reference can be absent from a concurrent fanout's host snapshot.
// Advance only its config version; retained references use their real host write.
export function stampedSshNetworkConfig(
  qb: QueryBuilder,
  alias: string,
  provider: "cloudflare_access" | "tailscale",
  predicate: SQL,
) {
  const config =
    provider === "tailscale" ? tailscaleConfigs : cloudflareAccessConfigs;
  return qb
    .$with(alias, { id: config.id })
    .as(
      sql`UPDATE ${config} SET ${sql.identifier(config.name.name)} = ${config.name} WHERE ${predicate} RETURNING ${config.id}`,
    );
}

export function selectedSshNetworkConfig(
  qb: QueryBuilder,
  alias: string,
  provider: "cloudflare_access" | "tailscale",
  predicate: SQL,
  retaining: SQL,
) {
  const entering = and(predicate, not(retaining));
  if (entering === undefined) {
    throw new Error("SSH network entry predicate is missing");
  }
  const entered = stampedSshNetworkConfig(
    qb,
    `${alias}_entered`,
    provider,
    entering,
  );
  const config =
    provider === "tailscale" ? tailscaleConfigs : cloudflareAccessConfigs;
  const retained = qb
    .$with(`${alias}_retained`)
    .as(
      qb
        .select({ id: config.id })
        .from(config)
        .where(and(predicate, retaining)),
    );
  const selected = qb.$with(alias).as(
    qb
      .select({ id: entered.id })
      .from(entered)
      .unionAll(qb.select({ id: retained.id }).from(retained)),
  );
  return { selected, ctes: [entered, retained, selected] };
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

function sshAccessAdmissionPredicate(
  args: Owner & { readonly accessId: string | null },
  eligible: SQL,
) {
  const predicate = and(
    args.accessId === null
      ? sql`false`
      : visibleSshAccessConfig(args, args.accessId),
    eligible,
  );
  if (predicate === undefined) {
    throw new Error("SSH Cloudflare admission predicate is missing");
  }
  return predicate;
}

export function stampedSshCredential(
  qb: QueryBuilder,
  alias: string,
  predicate: SQL,
) {
  return qb
    .$with(alias, {
      id: sshCredentials.id,
      name: sshCredentials.name,
      username: sshCredentials.username,
    })
    .as(
      sql`UPDATE ${sshCredentials} SET ${sql.identifier(sshCredentials.name.name)} = ${sshCredentials.name} WHERE ${predicate} RETURNING ${sshCredentials.id}, ${sshCredentials.name}, ${sshCredentials.username}`,
    );
}

// Sessionless SQL construction; execution belongs to the calling command.
export function createSshCreationReads(
  args: PreparedSshConnectionCreation,
  endpointValid: boolean,
) {
  const qb = new QueryBuilder();
  const anchor = qb.$with("requested_ssh_creation").as(
    qb
      .select({
        id: sql`${args.body.id}::uuid`
          .mapWith(pgTextDecoder)
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
          args.preparedCredential?.id === undefined
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
        args.preparedCredential?.id === undefined
          ? sql`true`
          : exists(qb.select({ id: credential.id }).from(credential)),
      ),
  );
  const accessPredicate = sshAccessAdmissionPredicate(
    args,
    exists(qb.select({ id: ready.id }).from(ready)),
  );
  const access = stampedSshNetworkConfig(
    qb,
    "selected_ssh_creation_access",
    "cloudflare_access",
    accessPredicate,
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

export function createSshUpdateReads(
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
                eq(current.connectionMode, "direct"),
                and(
                  or(
                    eq(current.connectionMode, "tailscale"),
                    eq(current.connectionMode, "tailscale_ssh"),
                  ),
                  not(isNull(current.tailscaleId)),
                ),
                and(
                  eq(current.connectionMode, "cloudflare_access"),
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
        args.connectionMode === "tailscale_ssh" ||
          (prepared !== undefined && prepared.id === undefined)
          ? sql`true`
          : exists(qb.select({ id: credential.id }).from(credential)),
      ),
  );
  const accessPredicate = sshAccessAdmissionPredicate(
    args,
    exists(qb.select({ id: ready.id }).from(ready)),
  );
  const accessSelection = selectedSshNetworkConfig(
    qb,
    "selected_ssh_binding_access",
    "cloudflare_access",
    accessPredicate,
    exists(
      qb
        .select({ id: current.id })
        .from(current)
        .where(
          args.accessId === null
            ? sql`false`
            : eq(current.cloudflareAccessId, args.accessId),
        ),
    ),
  );
  const access = accessSelection.selected;
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
    ctes: [
      current,
      base,
      credential,
      ready,
      ...accessSelection.ctes,
      admission,
    ],
  };
}
