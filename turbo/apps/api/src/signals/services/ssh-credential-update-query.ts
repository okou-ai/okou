import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  lt,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { UpdateSshCredentialArgs } from "./ssh-credential.service";
import { pgTextDecoder } from "../../lib/db-structured-result";

// Sessionless construction. The owning command executes the dependent writes.
export function createSshCredentialUpdateReads(args: UpdateSshCredentialArgs) {
  const qb = new QueryBuilder();
  const observed = qb.$with("observed_ssh_credential_update").as(
    qb
      .select({
        id: sshCredentials.id,
        version: sql`${sshCredentials}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("observed_version"),
      })
      .from(sshCredentials)
      .where(
        and(
          eq(sshCredentials.id, args.credentialId),
          eq(sshCredentials.orgId, args.owner.orgId),
          eq(sshCredentials.userId, args.owner.userId),
        ),
      ),
  );
  const hosts = qb.$with("locked_ssh_credential_hosts").as(
    qb
      .select({
        id: sshConnections.id,
        displayName: sshConnections.displayName,
        generation: sshConnections.generation,
      })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.credentialId, args.credentialId),
          eq(sshConnections.orgId, args.owner.orgId),
          eq(sshConnections.userId, args.owner.userId),
        ),
      )
      .orderBy(asc(sshConnections.id))
      .for("no key update"),
  );
  const current = qb.$with("locked_ssh_credential_update").as(
    qb
      .select({
        id: sshCredentials.id,
        version: sql`${sshCredentials}.xmin::text`
          .mapWith(pgTextDecoder)
          .as("current_version"),
        name: sshCredentials.name,
        username: sshCredentials.username,
        authMethod: sshCredentials.authMethod,
        revision: sshCredentials.revision,
        createdAt: sshCredentials.createdAt,
        updatedAt: sshCredentials.updatedAt,
      })
      .from(sshCredentials)
      .where(
        and(
          eq(sshCredentials.id, args.credentialId),
          eq(sshCredentials.orgId, args.owner.orgId),
          eq(sshCredentials.userId, args.owner.userId),
          // Consume the UUID-ordered retained Host set before the credential fence.
          gte(qb.select({ count: count() }).from(hosts), 0),
        ),
      )
      .for("update"),
  );
  const effective =
    args.body.authentication !== undefined
      ? sql`true`
      : args.body.username === undefined
        ? sql`false`
        : ne(current.username, args.body.username);
  const eligible = qb.$with("eligible_ssh_credential_update").as(
    qb
      .select({ id: current.id })
      .from(current)
      .where(
        and(
          lt(current.revision, 2_147_483_647),
          eq(
            current.version,
            qb.select({ version: observed.version }).from(observed),
          ),
          or(
            not(effective),
            not(
              exists(
                qb
                  .select({ id: hosts.id })
                  .from(hosts)
                  .where(eq(hosts.generation, 2_147_483_647)),
              ),
            ),
          ),
        ),
      ),
  );
  return {
    qb,
    observed,
    hosts,
    current,
    eligible,
    effective,
    ctes: [observed, hosts, current, eligible],
  };
}
