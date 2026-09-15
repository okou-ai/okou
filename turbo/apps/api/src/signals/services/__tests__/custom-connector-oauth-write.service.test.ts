import { randomUUID } from "node:crypto";
import { installPreparedDomainLegacyFunctions } from "../../../test-fixtures/prepared-domain-legacy-functions";

import {
  orgCustomConnectors,
  type OrgCustomConnectorAuthMode,
} from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import type { ApiDb, Tx } from "../../../lib/db-types";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../../lib/db-structured-result";
import { env } from "../../../lib/env";
import { createDeferredPromise, settle } from "../../utils";
import { writeCustomConnectorOAuthState } from "../custom-connector-oauth-write.service";

const context = testContext();

// Trigger presence, transaction interleavings and config-key movement cannot
// be selected through a product API. Private PostgreSQL schemas exercise this
// deployment boundary using the real write operation and shipped constraints.
// Generic, Feishu and Lark route tests cover their user-visible workflows.
async function createHarness(schema: "retained" | "without-triggers") {
  const schemaName = `connector_oauth_${randomUUID().replaceAll("-", "")}`;
  const adminPool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 1,
    allowExitOnIdle: true,
  });
  const adminDb = drizzle(adminPool);
  const pool = new Pool({
    connectionString: env("DATABASE_URL"),
    max: 4,
    allowExitOnIdle: true,
    options: `-c search_path=${schemaName},public -c statement_timeout=10000`,
  });
  const db = drizzle(pool);
  const destroy = async () => {
    const poolClosed = await settle(pool.end());
    const schemaDropped = await settle(
      adminDb.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaName)} CASCADE`,
      ),
    );
    const adminClosed = await settle(adminPool.end());
    for (const result of [poolClosed, schemaDropped, adminClosed]) {
      if (!result.ok) {
        throw result.error;
      }
    }
  };
  const initialized = await settle(
    (async () => {
      const setupClient = await pool.connect();
      const created = await settle(
        drizzle(setupClient).transaction(async (tx) => {
          await tx.execute(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
          await tx.execute(sql`
        CREATE TABLE org_custom_connectors
        (LIKE public.org_custom_connectors INCLUDING ALL)
      `);
          await tx.execute(sql`
        CREATE TABLE org_custom_connector_oauth_configs
        (LIKE public.org_custom_connector_oauth_configs INCLUDING ALL)
      `);
          // LIKE copies ordinary checks and unique keys, but not foreign keys.
          await tx.execute(sql`
        ALTER TABLE org_custom_connector_oauth_configs
        ADD CONSTRAINT fk_org_custom_connector_oauth_configs_connector
        FOREIGN KEY (connector_id, org_id)
        REFERENCES org_custom_connectors (id, org_id) ON DELETE CASCADE
      `);
          if (schema === "retained") {
            await installPreparedDomainLegacyFunctions(setupClient, [
              "assert_org_custom_connector_oauth_mode",
              "enforce_org_custom_connector_oauth_mode",
            ]);
            await tx.execute(sql`
          CREATE CONSTRAINT TRIGGER trg_org_custom_connectors_oauth_mode
          AFTER INSERT OR UPDATE ON org_custom_connectors
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()
        `);
            await tx.execute(sql`
          CREATE CONSTRAINT TRIGGER trg_org_custom_connector_oauth_configs_mode
          AFTER INSERT OR DELETE OR UPDATE ON org_custom_connector_oauth_configs
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
          EXECUTE FUNCTION enforce_org_custom_connector_oauth_mode()
        `);
          }
        }),
      );
      setupClient.release();
      if (!created.ok) {
        throw created.error;
      }
    })(),
  );
  if (!initialized.ok) {
    await destroy();
    throw initialized.error;
  }
  return { db, destroy };
}

function identity(orgId = `org_${randomUUID()}`) {
  return { connectorId: randomUUID(), orgId };
}

type ConnectorIdentity = ReturnType<typeof identity>;

function modeColumns(authMode: OrgCustomConnectorAuthMode) {
  return {
    authMode,
    headerInjections:
      authMode === "oauth" || authMode === "manual"
        ? [{ name: "Authorization", valueTemplate: "test credential" }]
        : [],
  };
}

async function insertConnector(
  tx: Tx,
  target: ConnectorIdentity,
  authMode: OrgCustomConnectorAuthMode,
) {
  await tx.insert(orgCustomConnectors).values({
    id: target.connectorId,
    orgId: target.orgId,
    slug: `_${target.connectorId}`,
    displayName: "Original definition",
    ...modeColumns(authMode),
    mcpEndpoint: "https://mcp.example.test",
    mcpTransport: "streamable-http",
    createdBy: "oauth-rollout-fixture",
  });
}

async function setMode(
  tx: Tx,
  target: ConnectorIdentity,
  authMode: OrgCustomConnectorAuthMode,
) {
  await tx
    .update(orgCustomConnectors)
    .set(modeColumns(authMode))
    .where(eq(orgCustomConnectors.id, target.connectorId));
}

async function insertConfig(tx: Tx, target: ConnectorIdentity) {
  await tx.insert(orgCustomConnectorOauthConfigs).values({
    ...target,
    providerAdapter: "standard",
    clientId: "client-id",
    encryptedClientSecret: "encrypted-fixture-secret",
    authorizationUrl: "https://oauth.example.test/authorize",
    tokenUrl: "https://oauth.example.test/token",
    tokenEndpointAuthMethod: "client_secret_post",
    pkceMethod: "none",
  });
}

async function deleteConfig(tx: Tx, target: ConnectorIdentity) {
  await tx
    .delete(orgCustomConnectorOauthConfigs)
    .where(eq(orgCustomConnectorOauthConfigs.connectorId, target.connectorId));
}

async function createConnector(
  db: ApiDb,
  target: ConnectorIdentity,
  authMode: OrgCustomConnectorAuthMode,
) {
  return await db.transaction(async (tx) => {
    return await writeCustomConnectorOAuthState(tx, [target], async () => {
      await insertConnector(tx, target, authMode);
      if (authMode === "oauth") {
        await insertConfig(tx, target);
      }
    });
  });
}

async function readState(db: ApiDb, target: ConnectorIdentity) {
  const connectors = await db
    .select()
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.id, target.connectorId));
  const configs = await db
    .select()
    .from(orgCustomConnectorOauthConfigs)
    .where(eq(orgCustomConnectorOauthConfigs.connectorId, target.connectorId));
  return { connectors, configs };
}

const modes = ["none", "manual", "oauth", "automatic"] as const;

describe.each(["retained", "without-triggers"] as const)(
  "custom connector OAuth writes on the %s schema",
  (schema) => {
    let harness: Awaited<ReturnType<typeof createHarness>>;

    beforeEach(async () => {
      harness = await createHarness(schema);
    });

    afterEach(async () => {
      await harness.destroy();
    });

    it("exercises the legacy enforcement boundary and explicit repair", async () => {
      const target = identity();
      // This unsupported standalone write is a control for the test-owned
      // schema. It also creates the corrupt state a repair must recover after
      // contraction; product APIs cannot intentionally create that state.
      const unprepared = harness.db.transaction(async (tx) => {
        await insertConnector(tx, target, "oauth");
      });
      if (schema === "retained") {
        await expect(unprepared).rejects.toMatchObject({
          cause: { code: "23514" },
        });
        await expect(readState(harness.db, target)).resolves.toStrictEqual({
          connectors: [],
          configs: [],
        });
      } else {
        await unprepared;
        await harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await insertConfig(tx, target);
          });
        });
        const repaired = await readState(harness.db, target);
        expect(repaired.connectors[0]?.authMode).toBe("oauth");
        expect(repaired.configs).toHaveLength(1);
      }
    });

    it.each(modes)("creates a consistent %s connector", async (mode) => {
      const target = identity();
      await createConnector(harness.db, target, mode);
      const state = await readState(harness.db, target);
      expect(state.connectors).toHaveLength(1);
      expect(state.connectors[0]?.authMode).toBe(mode);
      expect(state.configs).toHaveLength(mode === "oauth" ? 1 : 0);
    });

    it.each(modes)(
      "accepts intermediate states when switching OAuth to %s and back",
      async (mode) => {
        const target = identity();
        await createConnector(harness.db, target, "oauth");
        for (const destination of [mode, "oauth", "oauth"] as const) {
          await harness.db.transaction(async (tx) => {
            await writeCustomConnectorOAuthState(tx, [target], async () => {
              await setMode(tx, target, destination);
              await deleteConfig(tx, target);
              if (destination === "oauth") {
                await insertConfig(tx, target);
              }
            });
          });
          const state = await readState(harness.db, target);
          expect(state.connectors[0]?.authMode).toBe(destination);
          expect(state.configs).toHaveLength(destination === "oauth" ? 1 : 0);
        }
      },
    );

    it.each(modes)(
      "rolls back an inconsistent %s insert and its companion write",
      async (mode) => {
        const target = identity();
        const companion = identity(target.orgId);
        await createConnector(harness.db, companion, "manual");
        const before = await readState(harness.db, companion);
        await expect(
          harness.db.transaction(async (tx) => {
            await tx
              .update(orgCustomConnectors)
              .set({ displayName: "Must roll back" })
              .where(eq(orgCustomConnectors.id, companion.connectorId));
            await writeCustomConnectorOAuthState(tx, [target], async () => {
              await insertConnector(tx, target, mode);
              if (mode !== "oauth") {
                await insertConfig(tx, target);
              }
            });
          }),
        ).rejects.toThrow(
          "custom connector OAuth mode and config do not match",
        );
        await expect(readState(harness.db, target)).resolves.toStrictEqual({
          connectors: [],
          configs: [],
        });
        await expect(readState(harness.db, companion)).resolves.toStrictEqual(
          before,
        );
      },
    );

    it("rolls back a config-only deletion that leaves an OAuth parent", async () => {
      const target = identity();
      await createConnector(harness.db, target, "oauth");
      const before = await readState(harness.db, target);
      await expect(
        harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await deleteConfig(tx, target);
          });
        }),
      ).rejects.toThrow("custom connector OAuth mode and config do not match");
      await expect(readState(harness.db, target)).resolves.toStrictEqual(
        before,
      );
    });

    it("rolls back both valid writes if the caller later fails", async () => {
      const target = identity();
      await createConnector(harness.db, target, "manual");
      const before = await readState(harness.db, target);
      await expect(
        harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await setMode(tx, target, "oauth");
            await insertConfig(tx, target);
          });
          throw new Error("later owning transaction operation failed");
        }),
      ).rejects.toThrow("later owning transaction operation failed");
      await expect(readState(harness.db, target)).resolves.toStrictEqual(
        before,
      );
    });

    it("keeps the ordinary foreign key cascade authoritative on deletion", async () => {
      const target = identity();
      await createConnector(harness.db, target, "oauth");
      await harness.db
        .delete(orgCustomConnectors)
        .where(eq(orgCustomConnectors.id, target.connectorId));
      await expect(readState(harness.db, target)).resolves.toStrictEqual({
        connectors: [],
        configs: [],
      });
    });

    it.each(["valid", "invalid-old", "invalid-new"] as const)(
      "checks both final identities in a %s config move",
      async (outcome) => {
        const source = identity();
        const target = identity();
        await createConnector(harness.db, source, "oauth");
        await createConnector(harness.db, target, "manual");
        const beforeSource = await readState(harness.db, source);
        const beforeTarget = await readState(harness.db, target);
        const move = harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(
            tx,
            [target, source],
            async () => {
              await tx
                .update(orgCustomConnectorOauthConfigs)
                .set(target)
                .where(
                  eq(
                    orgCustomConnectorOauthConfigs.connectorId,
                    source.connectorId,
                  ),
                );
              if (outcome !== "invalid-old") {
                await setMode(tx, source, "manual");
              }
              if (outcome !== "invalid-new") {
                await setMode(tx, target, "oauth");
              }
            },
          );
        });
        if (outcome === "valid") {
          await move;
          expect((await readState(harness.db, source)).configs).toStrictEqual(
            [],
          );
          expect((await readState(harness.db, target)).configs).toMatchObject([
            { ...target, clientId: "client-id" },
          ]);
        } else {
          await expect(move).rejects.toThrow(
            "custom connector OAuth mode and config do not match",
          );
          await expect(readState(harness.db, source)).resolves.toStrictEqual(
            beforeSource,
          );
          await expect(readState(harness.db, target)).resolves.toStrictEqual(
            beforeTarget,
          );
        }
      },
    );

    it("retains the database ownership and unique-config constraints", async () => {
      const target = identity();
      await createConnector(harness.db, target, "oauth");
      const before = await readState(harness.db, target);
      await expect(
        harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await deleteConfig(tx, target);
            await insertConfig(tx, { ...target, orgId: `org_${randomUUID()}` });
          });
        }),
      ).rejects.toMatchObject({ cause: { code: "23503" } });
      await expect(
        harness.db.transaction(async (tx) => {
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await insertConfig(tx, target);
          });
        }),
      ).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(readState(harness.db, target)).resolves.toStrictEqual(
        before,
      );
    });

    it("locks both config-move identities in key order before writing", async () => {
      const first = identity();
      const second = identity(first.orgId);
      const lower = first.connectorId < second.connectorId ? first : second;
      const upper = lower === first ? second : first;
      await createConnector(harness.db, lower, "oauth");
      await createConnector(harness.db, upper, "manual");
      const locked = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const contenderPid = createDeferredPromise<number>(context.signal);
      const blocker = harness.db.transaction(async (tx) => {
        await tx
          .select({ id: orgCustomConnectors.id })
          .from(orgCustomConnectors)
          .where(eq(orgCustomConnectors.id, upper.connectorId))
          .for("update");
        locked.resolve();
        await release.promise;
      });
      await Promise.race([locked.promise, blocker]);
      const move = harness.db.transaction(async (tx) => {
        const [backend] = await tx
          .select({
            pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder),
          })
          .from(sql`(SELECT 1) AS backend`);
        if (!backend) {
          throw new Error("Expected transaction backend");
        }
        contenderPid.resolve(backend.pid);
        // Deliberately reverse input order: the lower parent must already be
        // locked while the shared operation waits for the upper parent.
        await writeCustomConnectorOAuthState(tx, [upper, lower], async () => {
          await tx
            .update(orgCustomConnectorOauthConfigs)
            .set(upper)
            .where(
              eq(orgCustomConnectorOauthConfigs.connectorId, lower.connectorId),
            );
          await setMode(tx, lower, "manual");
          await setMode(tx, upper, "oauth");
        });
      });
      const completed = Promise.all([settle(blocker), settle(move)]);
      const verification = await settle(
        Promise.race([
          contenderPid.promise,
          move.then(() => {
            throw new Error("Expected contender backend before completion");
          }),
        ]).then(async (pid) => {
          await expect
            .poll(async () => {
              const [state] = await harness.db
                .select({
                  blocked:
                    sql`cardinality(pg_blocking_pids(${pid})) > 0`.mapWith(
                      pgBooleanDecoder,
                    ),
                })
                .from(sql`(SELECT 1) AS blocking_state`);
              return state?.blocked;
            })
            .toBe(true);
          await expect(
            harness.db.transaction(async (tx) => {
              await tx
                .select({ id: orgCustomConnectors.id })
                .from(orgCustomConnectors)
                .where(eq(orgCustomConnectors.id, lower.connectorId))
                .for("update", { noWait: true });
            }),
          ).rejects.toMatchObject({ cause: { code: "55P03" } });
        }),
      );
      release.resolve();
      const results = await completed;
      if (!verification.ok) {
        throw verification.error;
      }
      for (const result of results) {
        if (!result.ok) {
          throw result.error;
        }
      }
      expect((await readState(harness.db, lower)).configs).toStrictEqual([]);
      expect((await readState(harness.db, upper)).configs).toMatchObject([
        { ...upper, clientId: "client-id" },
      ]);
    });

    it.each(["prepared", "outgoing"] as const)(
      "serializes a config-only write behind a %s mode change",
      async (writer) => {
        const target = identity();
        await createConnector(harness.db, target, "oauth");
        const locked = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        const contenderPid = createDeferredPromise<number>(context.signal);
        const change = harness.db.transaction(async (tx) => {
          const write = async () => {
            await setMode(tx, target, "manual");
            await deleteConfig(tx, target);
            locked.resolve();
            await release.promise;
          };
          if (writer === "prepared") {
            await writeCustomConnectorOAuthState(tx, [target], write);
          } else {
            // Outgoing API updates already lock the owning connector first.
            await tx
              .select({ id: orgCustomConnectors.id })
              .from(orgCustomConnectors)
              .where(eq(orgCustomConnectors.id, target.connectorId))
              .for("update");
            await write();
          }
        });
        await Promise.race([locked.promise, change]);
        const contender = harness.db.transaction(async (tx) => {
          const [backend] = await tx
            .select({
              pid: sql`pg_backend_pid()`.mapWith(pgIntegerDecoder),
            })
            .from(sql`(SELECT 1) AS backend`);
          if (!backend) {
            throw new Error("Expected transaction backend");
          }
          contenderPid.resolve(backend.pid);
          await writeCustomConnectorOAuthState(tx, [target], async () => {
            await insertConfig(tx, target);
          });
        });
        const completion = Promise.all([settle(change), settle(contender)]);
        const verification = await settle(
          Promise.race([
            contenderPid.promise,
            contender.then(() => {
              throw new Error("Expected contender backend before completion");
            }),
          ]).then(async (pid) => {
            await expect
              .poll(async () => {
                const [state] = await harness.db
                  .select({
                    blocked:
                      sql`cardinality(pg_blocking_pids(${pid})) > 0`.mapWith(
                        pgBooleanDecoder,
                      ),
                  })
                  .from(sql`(SELECT 1) AS blocking_state`);
                return state?.blocked;
              })
              .toBe(true);
          }),
        );
        release.resolve();
        const [changed, contended] = await completion;
        if (!verification.ok) {
          throw verification.error;
        }
        if (!changed.ok) {
          throw changed.error;
        }
        expect(contended.ok).toBeFalsy();
        if (!contended.ok) {
          expect(contended.error).toMatchObject({
            message: "custom connector OAuth mode and config do not match",
          });
        }
        const state = await readState(harness.db, target);
        expect(state.connectors[0]?.authMode).toBe("manual");
        expect(state.configs).toStrictEqual([]);
      },
    );
  },
);
