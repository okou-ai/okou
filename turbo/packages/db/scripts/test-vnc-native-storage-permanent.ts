import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";

import { VNC_NATIVE_CONNECTION_FAILURE_REASONS } from "@okouai/api-contracts/contracts/vnc-connection-observations";
import { cloudflareAccessConfigs } from "../src/schema/cloudflare-access-config";
import { tailscaleConfigs } from "../src/schema/tailscale-config";
import { sshConnections } from "../src/runtime/ssh-connection";
import { sshCredentials } from "../src/schema/ssh-credential";
import { vncConnections } from "../src/schema/vnc-connection";
import { vncCredentials } from "../src/schema/vnc-credential";
import { vncConnectionObservations } from "../src/schema/vnc-connection-observation";

/** Persisted representation only; this does not qualify native API authority. */
export async function validatePermanentNativeVncStorage(databaseUrl: string) {
  const client = new Client({ connectionString: databaseUrl });
  const db = drizzle(client);
  const owner = { orgId: `vnc-native-${randomUUID()}`, userId: "owner" };
  const foreignOrg = `${owner.orgId}-foreign`;
  const primary = randomUUID();
  const alternate = randomUUID();
  const foreign = randomUUID();
  const sshId = randomUUID();
  const sshCredentialId = randomUUID();
  const passwordId = randomUUID();
  const kerberosId = randomUUID();
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const configs = [primary, alternate, foreign].map((id) => {
      return {
        ...owner,
        id,
        orgId: id === foreign ? foreignOrg : owner.orgId,
        name: id,
        encryptedClientId: "synthetic-id",
        encryptedClientSecret: "synthetic-secret",
      };
    });
    // The same UUID in different provider tables is a distinct identity.
    await db.insert(cloudflareAccessConfigs).values(configs);
    await db.insert(tailscaleConfigs).values(
      configs.map((row) => {
        return { ...row, tags: ["tag:vnc"] };
      }),
    );
    await db.insert(sshCredentials).values({
      ...owner,
      id: sshCredentialId,
      name: "SSH login",
      username: "deploy",
      authMethod: "password",
      encryptedPassword: "synthetic-password",
    });
    await db.insert(sshConnections).values({
      ...owner,
      id: sshId,
      displayName: "SSH identity collision",
      host: "ssh.example.test",
      port: 22,
      connectionMode: "direct",
      credentialId: sshCredentialId,
    });
    await db.insert(vncCredentials).values([
      {
        ...owner,
        id: passwordId,
        name: "Password",
        authMethod: "vnc_password",
        encryptedPassword: "synthetic-password",
      },
      {
        ...owner,
        id: kerberosId,
        name: "Kerberos",
        authMethod: "qemu_kerberos_password",
        encryptedKerberosCredential: "synthetic-kerberos",
        kerberosInitiator: { realm: "EXAMPLE.TEST", components: ["owner"] },
      },
    ]);
    const base = {
      ...owner,
      displayName: "Native desktop",
      host: "100.64.0.2",
      authMethod: "none",
      securityType: "x509_none",
      trustMode: "system",
    } as const;
    const [tailscale] = await db
      .insert(vncConnections)
      .values({
        ...base,
        id: sshId,
        transportType: "tailscale",
        tailscaleId: primary,
      })
      .returning();
    const [access] = await db
      .insert(vncConnections)
      .values({
        ...base,
        transportType: "cloudflare_access",
        cloudflareAccessId: primary,
        host: "vnc-gateway.example.test",
        port: 443,
      })
      .returning();
    assert.ok(tailscale && access);

    async function rejectUpdate(
      id: string,
      assignment: string,
      values: unknown[],
      constraint: string,
      code = "23514",
    ) {
      const before = await db
        .select()
        .from(vncConnections)
        .where(eq(vncConnections.id, id));
      await assert.rejects(
        client.query(`UPDATE vnc_connections SET ${assignment} WHERE id = $1`, [
          id,
          ...values,
        ]),
        { code, constraint },
      );
      assert.deepEqual(
        await db.select().from(vncConnections).where(eq(vncConnections.id, id)),
        before,
      );
    }

    await rejectUpdate(
      tailscale.id,
      "tailscale_id = $2",
      [foreign],
      "vnc_connections_tailscale_org_fk",
      "23503",
    );
    await rejectUpdate(
      access.id,
      "cloudflare_access_id = $2",
      [foreign],
      "vnc_connections_cloudflare_org_fk",
      "23503",
    );
    await rejectUpdate(
      access.id,
      "cloudflare_access_id = $2",
      [randomUUID()],
      "vnc_connections_cloudflare_org_fk",
      "23503",
    );
    await rejectUpdate(
      tailscale.id,
      "cloudflare_access_id = $2",
      [primary],
      "chk_vnc_connections_transport",
    );
    await rejectUpdate(
      access.id,
      "tailscale_id = $2",
      [primary],
      "chk_vnc_connections_transport",
    );
    await rejectUpdate(
      access.id,
      "ssh_connection_id = $2",
      [sshId],
      "chk_vnc_connections_transport",
    );
    await rejectUpdate(
      access.id,
      "port = 5900",
      [],
      "chk_vnc_connections_transport",
    );
    await rejectUpdate(
      tailscale.id,
      "transport_type = 'unknown'",
      [],
      "chk_vnc_connections_transport",
    );
    await rejectUpdate(
      tailscale.id,
      "kdc_tailscale_id = $2",
      [primary],
      "chk_vnc_connections_kdc",
    );

    for (const [assignment, values] of [
      ["origin_tls_server_name = 'origin.example.test'", []],
      ["origin_tls_trust_mode = 'system'", []],
      ["origin_tls_ca_bundle = 'orphan-ca'", []],
      [
        "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'custom_ca'",
        [],
      ],
      [
        "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'custom_ca', origin_tls_ca_bundle = ''",
        [],
      ],
      [
        "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'system', origin_tls_ca_bundle = 'unexpected-ca'",
        [],
      ],
      ["origin_tls_server_name = '', origin_tls_trust_mode = 'system'", []],
      [
        "origin_tls_server_name = 'UPPER.example.test', origin_tls_trust_mode = 'system'",
        [],
      ],
      [
        "origin_tls_server_name = 'origin.example.test/path', origin_tls_trust_mode = 'system'",
        [],
      ],
      [
        "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'custom_ca', origin_tls_ca_bundle = $2",
        ["x".repeat(65_537)],
      ],
      [
        "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'insecure'",
        [],
      ],
    ] satisfies [string, unknown[]][]) {
      await rejectUpdate(
        access.id,
        assignment,
        values,
        "chk_vnc_connections_origin_tls",
      );
    }
    for (const serverName of [
      "bad name",
      "bad\nname",
      "origin@example.test",
      "origin%example.test",
      "origin[host]",
      "origin\\host",
    ]) {
      await rejectUpdate(
        access.id,
        "origin_tls_server_name = $2, origin_tls_trust_mode = 'system'",
        [serverName],
        "chk_vnc_connections_origin_tls",
      );
    }
    await rejectUpdate(
      tailscale.id,
      "origin_tls_server_name = 'origin.example.test', origin_tls_trust_mode = 'system'",
      [],
      "chk_vnc_connections_origin_tls",
    );

    // Roles may share a configuration, use different ones, or retain detached
    // discriminators. Those are schema states, not mutation/authorization tests.
    const validateKdcBindings = async () => {
      for (const rfb of ["cloudflare_access", "tailscale"] as const) {
        for (const kdc of ["cloudflare_access", "tailscale"] as const) {
          for (const selectedKdc of [primary, alternate, null]) {
            const [row] = await db
              .insert(vncConnections)
              .values({
                ...owner,
                displayName: `${rfb}/${kdc}`,
                host:
                  rfb === "cloudflare_access"
                    ? "rfb-gateway.example.test"
                    : "100.64.0.2",
                port: rfb === "cloudflare_access" ? 443 : 5900,
                transportType: rfb,
                cloudflareAccessId:
                  rfb === "cloudflare_access" ? primary : null,
                tailscaleId: rfb === "tailscale" ? primary : null,
                credentialId: kerberosId,
                authMethod: "qemu_kerberos_password",
                securityType: "qemu_x509_gssapi",
                trustMode: "custom_ca",
                caBundle: "retained-inner-ca",
                x509ServerName: "inner.example.test",
                originTlsServerName:
                  rfb === "cloudflare_access" ? "origin.example.test" : null,
                originTlsTrustMode:
                  rfb === "cloudflare_access" ? "custom_ca" : null,
                originTlsCaBundle:
                  rfb === "cloudflare_access" ? "independent-outer-ca" : null,
                kerberosService: {
                  realm: "EXAMPLE.TEST",
                  components: ["vnc", "desktop.example.test"],
                },
                kdcTransportType: kdc,
                kdcHost:
                  kdc === "cloudflare_access"
                    ? "kdc-gateway.example.test"
                    : "100.64.0.3",
                kdcPort: kdc === "cloudflare_access" ? 443 : 88,
                kdcCloudflareAccessId:
                  kdc === "cloudflare_access" ? selectedKdc : null,
                kdcTailscaleId: kdc === "tailscale" ? selectedKdc : null,
                kerberosTicketLifetimeSeconds: 3600,
                kerberosRenewableLifetimeSeconds: 7200,
              })
              .returning();
            assert.ok(row);
            assert.equal(row.caBundle, "retained-inner-ca");
            assert.equal(
              row.originTlsCaBundle,
              rfb === "cloudflare_access" ? "independent-outer-ca" : null,
            );
            const selectedField =
              kdc === "cloudflare_access"
                ? "kdc_cloudflare_access_id"
                : "kdc_tailscale_id";
            await rejectUpdate(
              row.id,
              `${selectedField} = $2`,
              [foreign],
              kdc === "cloudflare_access"
                ? "vnc_connections_kdc_cloudflare_org_fk"
                : "vnc_connections_kdc_tailscale_org_fk",
              "23503",
            );
            await rejectUpdate(
              row.id,
              "kdc_ssh_connection_id = $2",
              [sshId],
              "chk_vnc_connections_kdc",
            );
            await rejectUpdate(
              row.id,
              "kdc_cloudflare_access_id = $2, kdc_tailscale_id = $2",
              [primary],
              "chk_vnc_connections_kdc",
            );
            if (kdc === "cloudflare_access") {
              await rejectUpdate(
                row.id,
                "kdc_port = 88",
                [],
                "chk_vnc_connections_kdc",
              );
            }
          }
        }
      }
    };
    await validateKdcBindings();

    for (const transportType of ["cloudflare_access", "tailscale"] as const) {
      await db.insert(vncConnections).values({
        ...base,
        transportType,
        port: transportType === "cloudflare_access" ? 443 : 5900,
      });
    }

    const validateRawProfiles = async () => {
      for (const profile of [
        { authMethod: "vnc_password", securityType: "apple_vnc_password" },
        { authMethod: "apple_dh_username_password", securityType: "apple_dh" },
        {
          authMethod: "apple_srp_username_password",
          securityType: "apple_srp",
        },
        {
          authMethod: "apple_rsa_srp_username_password",
          securityType: "apple_rsa_srp",
        },
        { authMethod: "rsa_aes_password", securityType: "rsa_aes_ra2ne" },
        { authMethod: "rsa_aes_password", securityType: "rsa_aes_ra2ne_256" },
      ] as const) {
        const credentialId =
          profile.authMethod === "vnc_password" ? passwordId : randomUUID();
        if (credentialId !== passwordId) {
          await db.insert(vncCredentials).values({
            ...owner,
            id: credentialId,
            name: profile.authMethod,
            authMethod: profile.authMethod,
            username:
              profile.authMethod === "rsa_aes_password" ? null : "owner",
            encryptedPassword: "synthetic-password",
          });
        }
        for (const transportType of [
          "tailscale",
          "cloudflare_access",
        ] as const) {
          const [row] = await db
            .insert(vncConnections)
            .values({
              ...base,
              ...profile,
              credentialId,
              trustMode: "none",
              rsaServerKeySha256:
                profile.authMethod === "rsa_aes_password"
                  ? "a".repeat(64)
                  : null,
              transportType,
              port: transportType === "cloudflare_access" ? 443 : 5900,
              originTlsServerName:
                transportType === "cloudflare_access"
                  ? "origin.example.test"
                  : null,
              originTlsTrustMode:
                transportType === "cloudflare_access" ? "system" : null,
            })
            .returning();
          assert.ok(row);
          await rejectUpdate(
            row.id,
            "transport_type = 'direct', origin_tls_server_name = NULL, origin_tls_trust_mode = NULL",
            [],
            "chk_vnc_connections_profile",
          );
          if (transportType === "cloudflare_access") {
            await rejectUpdate(
              row.id,
              "origin_tls_server_name = NULL, origin_tls_trust_mode = NULL",
              [],
              "chk_vnc_connections_profile",
            );
          }
        }
      }
    };
    await validateRawProfiles();

    for (const [table, constraint] of [
      [
        "cloudflare_access_configs",
        /^vnc_connections_(?:kdc_)?cloudflare_org_fk$/u,
      ],
      ["tailscale_configs", /^vnc_connections_(?:kdc_)?tailscale_org_fk$/u],
    ] as const) {
      await assert.rejects(
        client.query(`DELETE FROM ${table} WHERE id = $1`, [primary]),
        {
          code: /^(23503|23001)$/u,
          constraint,
        },
      );
    }
    await db.insert(vncConnectionObservations).values({
      connectionId: tailscale.id,
      connectionCreatedAt: tailscale.createdAt.toISOString(),
      generation: tailscale.generation,
      observedAt: new Date(),
    });
    for (const failureReason of VNC_NATIVE_CONNECTION_FAILURE_REASONS) {
      await db
        .update(vncConnectionObservations)
        .set({ failureReason })
        .where(eq(vncConnectionObservations.connectionId, tailscale.id));
      const [row] = await db
        .select()
        .from(vncConnectionObservations)
        .where(eq(vncConnectionObservations.connectionId, tailscale.id));
      assert.equal(row?.failureReason, failureReason);
    }
    await assert.rejects(
      client.query(
        "UPDATE vnc_connection_observations SET failure_reason = 'unbounded_peer_error' WHERE connection_id = $1",
        [tailscale.id],
      ),
      {
        code: "23514",
        constraint: "chk_vnc_connection_observation_failure",
      },
    );
  } finally {
    if (connected) {
      await db
        .delete(vncConnections)
        .where(eq(vncConnections.orgId, owner.orgId));
      await db
        .delete(sshConnections)
        .where(
          and(
            eq(sshConnections.orgId, owner.orgId),
            eq(sshConnections.id, sshId),
          ),
        );
      await db
        .delete(vncCredentials)
        .where(eq(vncCredentials.orgId, owner.orgId));
      await db
        .delete(sshCredentials)
        .where(eq(sshCredentials.id, sshCredentialId));
      for (const table of [
        cloudflareAccessConfigs,
        tailscaleConfigs,
      ] as const) {
        await db
          .delete(table)
          .where(inArray(table.orgId, [owner.orgId, foreignOrg]));
      }
    }
    await client.end();
  }
}
