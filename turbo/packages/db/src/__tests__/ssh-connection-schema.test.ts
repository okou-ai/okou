import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { schema } from "../index";
import { sshCredentials } from "../schema/ssh-credential";
import { sshConnections } from "../schema/ssh-connection";
import { cloudflareAccessConfigs } from "../schema/cloudflare-access-config";
import { tailscaleConfigs } from "../schema/tailscale-config";

describe("SSH connection schema", () => {
  it("exports the standalone SSH tables", () => {
    expect(schema.sshConnections).toBe(sshConnections);
    expect(schema.sshCredentials).toBe(sshCredentials);
    expect(schema.cloudflareAccessConfigs).toBe(cloudflareAccessConfigs);
    expect(schema.tailscaleConfigs).toBe(tailscaleConfigs);
  });

  it("defines bounded owner-scoped connection storage", () => {
    const config = getTableConfig(sshConnections);
    expect(
      config.columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual([
      "id",
      "org_id",
      "user_id",
      "display_name",
      "host",
      "port",
      "credential_id",
      "cloudflare_access_id",
      "tailscale_config_id",
      "needs_rebind",
      "rebind_transport",
      "learned_host_key_algorithm",
      "learned_host_key_fingerprint",
      "generation",
      "default_enabled_for_chats",
      "created_at",
      "updated_at",
    ]);
    expect(
      config.indexes.map((index) => {
        return {
          name: index.config.name,
          unique: index.config.unique,
        };
      }),
    ).toStrictEqual([
      { name: "idx_ssh_connections_tailscale", unique: false },
      { name: "idx_ssh_connections_cloudflare_access", unique: false },
      { name: "idx_ssh_connections_credential", unique: false },
      { name: "idx_ssh_connections_owner_created", unique: false },
    ]);

    const dialect = new PgDialect();
    const checks = Object.fromEntries(
      config.checks.map((check) => {
        return [check.name, dialect.sqlToQuery(check.value).sql];
      }),
    );
    expect(Object.keys(checks)).toStrictEqual([
      "chk_ssh_connections_tailscale_exclusive",
      "chk_ssh_connections_cloudflare_access_destination",
      "chk_ssh_connections_needs_rebind_unbound",
      "chk_ssh_connections_rebind_transport",
      "chk_ssh_connections_display_name",
      "chk_ssh_connections_host",
      "chk_ssh_connections_port",
      "chk_ssh_connections_generation",
      "chk_ssh_connections_learned_host_key_pair",
    ]);
    expect(sshConnections.rebindTransport.notNull).toBe(true);
    expect(sshConnections.rebindTransport.default).toBe("cloudflare_access");
    expect(checks.chk_ssh_connections_rebind_transport).toContain(
      "IN ('cloudflare_access', 'tailscale')",
    );
    expect(checks.chk_ssh_connections_needs_rebind_unbound).toContain(
      '"tailscale_config_id" IS NULL',
    );
    expect(checks.chk_ssh_connections_port).toContain("BETWEEN 1 AND 65535");
    expect(checks.chk_ssh_connections_generation).toContain("> 0");
    expect(checks.chk_ssh_connections_learned_host_key_pair).toContain(
      "IS NULL",
    );
  });

  it("preserves personal ownership while allowing same-organization Access", () => {
    const connectionConfig = getTableConfig(sshConnections);
    const accessForeignKey = connectionConfig.foreignKeys.find((key) => {
      return key.getName() === "ssh_connections_cloudflare_access_org_fk";
    });
    expect(accessForeignKey?.onDelete).toBe("restrict");
    expect(
      accessForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["cloudflare_access_id", "org_id"]);
    expect(
      accessForeignKey?.reference().foreignColumns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["id", "org_id"]);
    expect(sshConnections.needsRebind.notNull).toBe(true);
    expect(cloudflareAccessConfigs.scope.default).toBe("personal");
    expect(cloudflareAccessConfigs.userId.notNull).toBe(false);
    expect(
      getTableConfig(cloudflareAccessConfigs).checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_cloudflare_access_configs_scope_owner");
  });

  it("restricts deletion of a referenced same-organization Tailscale configuration", () => {
    const config = getTableConfig(sshConnections);
    const tailscaleForeignKey = config.foreignKeys.find((key) => {
      return key.getName() === "ssh_connections_tailscale_org_fk";
    });
    expect(tailscaleForeignKey?.onDelete).toBe("restrict");
    expect(tailscaleForeignKey?.reference().foreignTable).toBe(
      tailscaleConfigs,
    );
    expect(
      tailscaleForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["tailscale_config_id", "org_id"]);
    expect(
      tailscaleForeignKey?.reference().foreignColumns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["id", "org_id"]);
    expect(sshConnections.tailscaleConfigId.notNull).toBe(false);
  });

  it("requires a same-owner credential and restricts deletion while referenced", () => {
    const config = getTableConfig(sshConnections);
    const credentialForeignKey = config.foreignKeys.find((key) => {
      return key.getName() === "ssh_connections_credential_owner_fk";
    });
    expect(credentialForeignKey?.onDelete).toBe("restrict");
    expect(credentialForeignKey?.reference().foreignTable).toBe(sshCredentials);
    expect(
      credentialForeignKey?.reference().columns.map((column) => {
        return column.name;
      }),
    ).toStrictEqual(["credential_id", "org_id", "user_id"]);
    expect(sshConnections.credentialId.notNull).toBe(true);
    const credentialConfig = getTableConfig(sshCredentials);
    expect(
      credentialConfig.checks.map((check) => {
        return check.name;
      }),
    ).toContain("chk_ssh_credentials_auth");
  });
});
