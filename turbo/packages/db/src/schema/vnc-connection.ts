import { sql } from "drizzle-orm";
import {
  check,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sshConnections } from "./ssh-connection";
import { vncCredentials } from "./vnc-credential";
import type { VncKerberosPrincipal } from "../jsonb-contracts/vnc-kerberos";
import { kerberosPrincipalCheck } from "./vnc-kerberos";

export const vncConnections = pgTable(
  "vnc_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    host: varchar("host", { length: 253 }).notNull(),
    port: integer("port").notNull().default(5900),
    transportType: varchar("transport_type", {
      length: 16,
      enum: ["direct", "ssh"],
    })
      .default("direct")
      .notNull(),
    sshConnectionId: uuid("ssh_connection_id"),
    x509ServerName: varchar("x509_server_name", { length: 253 }),
    credentialId: uuid("credential_id"),
    authMethod: varchar("auth_method", {
      length: 32,
      enum: [
        "none",
        "vnc_password",
        "username_password",
        "qemu_scram_sha256",
        "qemu_kerberos_ticket",
        "qemu_kerberos_keytab",
        "qemu_kerberos_password",
        "rsa_aes_password",
        "rsa_aes_username_password",
        "apple_dh_username_password",
        "apple_srp_username_password",
        "apple_rsa_srp_username_password",
        "client_certificate",
        "client_certificate_vnc_password",
      ],
    }).notNull(),
    securityType: varchar("security_type", {
      length: 32,
      enum: [
        "x509_none",
        "x509_vnc",
        "x509_plain",
        "qemu_x509_sasl",
        "qemu_x509_gssapi",
        "rsa_aes_ra2",
        "rsa_aes_ra2_256",
        "rsa_aes_ra2ne",
        "rsa_aes_ra2ne_256",
        "apple_vnc_password",
        "apple_dh",
        "apple_srp",
        "apple_rsa_srp",
      ],
    }).notNull(),
    trustMode: varchar("trust_mode", {
      length: 16,
      enum: ["system", "custom_ca", "none"],
    }).notNull(),
    caBundle: text("ca_bundle"),
    rsaServerKeySha256: varchar("rsa_server_key_sha256", { length: 64 }),
    kerberosService: jsonb("kerberos_service").$type<VncKerberosPrincipal>(),
    kdcTransportType: varchar("kdc_transport_type", {
      length: 16,
      enum: ["direct", "ssh"],
    }),
    kdcHost: varchar("kdc_host", { length: 253 }),
    kdcPort: integer("kdc_port"),
    kdcSshConnectionId: uuid("kdc_ssh_connection_id"),
    kerberosTicketLifetimeSeconds: integer("kerberos_ticket_lifetime_seconds"),
    kerberosRenewableLifetimeSeconds: integer(
      "kerberos_renewable_lifetime_seconds",
    ),
    generation: integer("generation").notNull().default(1),
    defaultEnabledForChats: boolean("default_enabled_for_chats")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "vnc_connections_ssh_owner_fk",
        columns: [table.sshConnectionId, table.orgId, table.userId],
        foreignColumns: [
          sshConnections.id,
          sshConnections.orgId,
          sshConnections.userId,
        ],
      }).onDelete("restrict"),
      foreignKey({
        name: "vnc_connections_credential_owner_fk",
        columns: [table.credentialId, table.orgId, table.userId],
        foreignColumns: [
          vncCredentials.id,
          vncCredentials.orgId,
          vncCredentials.userId,
        ],
      }).onDelete("restrict"),
      foreignKey({
        name: "vnc_connections_credential_profile_fk",
        columns: [
          table.credentialId,
          table.orgId,
          table.userId,
          table.authMethod,
        ],
        foreignColumns: [
          vncCredentials.id,
          vncCredentials.orgId,
          vncCredentials.userId,
          vncCredentials.authMethod,
        ],
      }).onDelete("restrict"),
      index("idx_vnc_connections_credential").on(table.credentialId, table.id),
      index("idx_vnc_connections_ssh").on(table.sshConnectionId, table.id),
      index("idx_vnc_connections_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      index("idx_vnc_connections_user").on(table.userId, table.id),
      check(
        "chk_vnc_connections_display_name",
        sql`char_length(${table.displayName}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_vnc_connections_host",
        sql`char_length(${table.host}) BETWEEN 1 AND 253 AND ${table.host} = lower(${table.host}) AND ${table.host} !~ '[[:space:]/@?#]'`,
      ),
      check("chk_vnc_connections_port", sql`${table.port} BETWEEN 1 AND 65535`),
      check(
        "chk_vnc_connections_transport",
        sql`(${table.transportType} = 'direct' AND ${table.sshConnectionId} IS NULL) OR (${table.transportType} = 'ssh' AND ${table.sshConnectionId} IS NOT NULL)`,
      ),
      check(
        "chk_vnc_connections_x509_server_name",
        sql`${table.x509ServerName} IS NULL OR (char_length(${table.x509ServerName}) BETWEEN 1 AND 253 AND ${table.x509ServerName} = lower(${table.x509ServerName}) AND ${table.x509ServerName} !~ '[[:space:]/@?#%\\[\\]\\\\]')`,
      ),
      check("chk_vnc_connections_generation", sql`${table.generation} > 0`),
      check(
        "chk_vnc_connections_profile",
        sql`(${table.credentialId} IS NOT NULL AND ${table.authMethod} IN ('rsa_aes_password', 'rsa_aes_username_password') AND ((${table.securityType} IN ('rsa_aes_ra2', 'rsa_aes_ra2_256')) OR (${table.securityType} IN ('rsa_aes_ra2ne', 'rsa_aes_ra2ne_256') AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1')))) OR (${table.authMethod} = 'none' AND ${table.securityType} = 'x509_none' AND ${table.credentialId} IS NULL) OR (${table.credentialId} IS NOT NULL AND ((${table.authMethod} = 'client_certificate' AND ${table.securityType} = 'x509_none') OR (${table.authMethod} = 'client_certificate_vnc_password' AND ${table.securityType} = 'x509_vnc') OR (${table.authMethod} = 'vnc_password' AND ${table.securityType} = 'x509_vnc') OR (${table.authMethod} = 'vnc_password' AND ${table.securityType} = 'apple_vnc_password' AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1') AND ${table.x509ServerName} IS NULL) OR (${table.authMethod} = 'username_password' AND ${table.securityType} = 'x509_plain') OR (${table.authMethod} = 'qemu_scram_sha256' AND ${table.securityType} = 'qemu_x509_sasl') OR (${table.authMethod} = 'apple_dh_username_password' AND ${table.securityType} = 'apple_dh' AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1') AND ${table.x509ServerName} IS NULL) OR (${table.authMethod} = 'apple_srp_username_password' AND ${table.securityType} = 'apple_srp' AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1') AND ${table.x509ServerName} IS NULL) OR (${table.authMethod} = 'apple_rsa_srp_username_password' AND ${table.securityType} = 'apple_rsa_srp' AND ${table.transportType} = 'ssh' AND ${table.host} IN ('127.0.0.1', '::1') AND ${table.x509ServerName} IS NULL))) OR (${table.authMethod} IN ('qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password') AND ${table.securityType} = 'qemu_x509_gssapi' AND ${table.credentialId} IS NOT NULL)`,
      ),
      foreignKey({
        name: "vnc_connections_kdc_ssh_owner_fk",
        columns: [table.kdcSshConnectionId, table.orgId, table.userId],
        foreignColumns: [
          sshConnections.id,
          sshConnections.orgId,
          sshConnections.userId,
        ],
      }).onDelete("restrict"),
      check(
        "chk_vnc_connections_kerberos_service",
        kerberosPrincipalCheck(table.kerberosService, true),
      ),
      check(
        "chk_vnc_connections_kerberos",
        sql`CASE
        WHEN ${table.authMethod} IN ('qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password')
          THEN ${table.kerberosService} IS NOT NULL AND ${table.securityType} = 'qemu_x509_gssapi'
        ELSE ${table.kerberosService} IS NULL END`,
      ),
      check(
        "chk_vnc_connections_kdc",
        sql`CASE
        WHEN ${table.authMethod} IN ('qemu_kerberos_keytab', 'qemu_kerberos_password') THEN
          ${table.kdcTransportType} IS NOT NULL AND ${table.kdcHost} IS NOT NULL
          AND octet_length(${table.kdcHost}) BETWEEN 1 AND 253
          AND ${table.kdcPort} IS NOT NULL AND ${table.kdcPort} BETWEEN 1 AND 65535
          AND ${table.kerberosTicketLifetimeSeconds} IS NOT NULL AND ${table.kerberosTicketLifetimeSeconds} BETWEEN 1 AND 7200
          AND ${table.kerberosRenewableLifetimeSeconds} IS NOT NULL AND ${table.kerberosRenewableLifetimeSeconds} BETWEEN 0 AND 7200
          AND ((${table.kdcTransportType} = 'direct' AND ${table.kdcSshConnectionId} IS NULL)
            OR (${table.kdcTransportType} = 'ssh' AND ${table.kdcSshConnectionId} IS NOT NULL AND ${table.kdcHost} IN ('127.0.0.1', '::1')))
        ELSE ${table.kdcTransportType} IS NULL AND ${table.kdcHost} IS NULL AND ${table.kdcPort} IS NULL
          AND ${table.kdcSshConnectionId} IS NULL AND ${table.kerberosTicketLifetimeSeconds} IS NULL
          AND ${table.kerberosRenewableLifetimeSeconds} IS NULL END`,
      ),
      check(
        "chk_vnc_connections_rsa_pin",
        sql`(${table.securityType} IN ('rsa_aes_ra2', 'rsa_aes_ra2_256', 'rsa_aes_ra2ne', 'rsa_aes_ra2ne_256') AND ${table.rsaServerKeySha256} IS NOT NULL AND ${table.rsaServerKeySha256} COLLATE "C" ~ '^[a-f0-9]{64}$' AND ${table.trustMode} = 'none' AND ${table.caBundle} IS NULL AND ${table.x509ServerName} IS NULL) OR (${table.securityType} NOT IN ('rsa_aes_ra2', 'rsa_aes_ra2_256', 'rsa_aes_ra2ne', 'rsa_aes_ra2ne_256') AND ${table.rsaServerKeySha256} IS NULL)`,
      ),
      check(
        "chk_vnc_connections_trust",
        sql`(${table.securityType} IN ('rsa_aes_ra2', 'rsa_aes_ra2_256', 'rsa_aes_ra2ne', 'rsa_aes_ra2ne_256') AND ${table.trustMode} = 'none' AND ${table.caBundle} IS NULL) OR (${table.securityType} IN ('apple_vnc_password', 'apple_dh', 'apple_srp', 'apple_rsa_srp') AND ${table.trustMode} = 'none' AND ${table.caBundle} IS NULL) OR (${table.securityType} NOT IN ('rsa_aes_ra2', 'rsa_aes_ra2_256', 'rsa_aes_ra2ne', 'rsa_aes_ra2ne_256', 'apple_vnc_password', 'apple_dh', 'apple_srp', 'apple_rsa_srp') AND ((${table.trustMode} = 'system' AND ${table.caBundle} IS NULL) OR (${table.trustMode} = 'custom_ca' AND ${table.caBundle} IS NOT NULL AND octet_length(${table.caBundle}) BETWEEN 1 AND 65536)))`,
      ),
    ];
  },
);
