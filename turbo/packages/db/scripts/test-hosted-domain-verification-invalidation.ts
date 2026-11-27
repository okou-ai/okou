import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations } from "./migration-runner";

export async function validateHostedDomainVerificationInvalidation(
  databaseUrl: string,
  migrationMillis: number,
) {
  const db = postgres(databaseUrl, { max: 1 });
  const site = randomUUID();
  const staleDomain = randomUUID();
  const revision = randomUUID();
  const checkedAt = "2026-11-25T00:00:00.000Z";
  const passed = { status: "passed", message: "Verified" };
  const previous = {
    status: "ready",
    eligibleForSelection: true,
    checkedAt,
    validationRecords: [],
    checks: {
      ownership: passed,
      dns: passed,
      provider: passed,
      certificate: passed,
      route: passed,
    },
  };
  const current = {
    ...previous,
    recordChecks: [
      {
        ...passed,
        checkedAt,
        type: "CNAME",
        name: "current.example.net",
        value: "connect.okou.app",
        observedValues: ["connect.okou.app"],
      },
    ],
  };

  try {
    await applyPendingMigrations(db, { beforeMillis: migrationMillis });
    await db`INSERT INTO hosted_sites (id, user_id, org_id, slug, public_slug)
      VALUES (${site}, 'owner', 'org', ${site}, ${site})`;
    await db`INSERT INTO hosted_site_domains
      (id, site_id, hostname, revision, challenge, challenge_expires_at, verified_at, verification) VALUES
      (${staleDomain}, ${site}, 'stale.example.net', ${revision}, 'a', now(), ${checkedAt}, ${db.json(previous)}),
      (gen_random_uuid(), ${site}, 'current.example.net', ${revision}, 'b', now(), ${checkedAt}, ${db.json(current)}),
      (gen_random_uuid(), ${site}, 'new.example.net', ${revision}, 'c', now(), NULL, NULL)`;
    await db`INSERT INTO hosted_site_domain_settings (site_id, selected_domain_id, revision)
      VALUES (${site}, ${staleDomain}, ${revision})`;
    const otherDomains = () => {
      return db`SELECT * FROM hosted_site_domains
        WHERE site_id = ${site} AND id <> ${staleDomain} ORDER BY hostname`;
    };
    const original = await otherDomains();

    await applyPendingMigrations(db, { beforeMillis: migrationMillis + 1 });

    assert.deepEqual([...(await otherDomains())], [...original]);
    const stale =
      await db`SELECT verification, verified_at = ${checkedAt} AS claim_preserved,
      revision <> ${revision} AS revision_changed
      FROM hosted_site_domains WHERE id = ${staleDomain}`;
    assert.deepEqual(
      [...stale],
      [
        {
          verification: null,
          claim_preserved: true,
          revision_changed: true,
        },
      ],
    );
    const settings =
      await db`SELECT selected_domain_id, revision <> ${revision} AS revision_changed
      FROM hosted_site_domain_settings WHERE site_id = ${site}`;
    assert.deepEqual(
      [...settings],
      [{ selected_domain_id: null, revision_changed: true }],
    );
  } finally {
    await db.end();
  }
}
