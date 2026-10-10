import { sql } from "drizzle-orm";
import {
  check,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { VncKerberosPrincipal } from "../jsonb-contracts/vnc-kerberos";
import { kerberosPrincipalCheck } from "./vnc-kerberos";

export const vncCredentials = pgTable(
  "vnc_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: varchar("name", { length: 128 }).notNull(),
    username: varchar("username", { length: 255 }),
    authMethod: varchar("auth_method", {
      length: 32,
      enum: [
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
    encryptedPassword: text("encrypted_password"),
    encryptedClientIdentity: text("encrypted_client_identity"),
    encryptedKerberosCredential: text("encrypted_kerberos_credential"),
    kerberosInitiator:
      jsonb("kerberos_initiator").$type<VncKerberosPrincipal>(),
    kerberosService: jsonb("kerberos_service").$type<VncKerberosPrincipal>(),
    kerberosDeclaredExpiresAt: bigint("kerberos_declared_expires_at", {
      mode: "number",
    }),
    revision: integer("revision").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_vnc_credentials_owner_id").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      unique("uq_vnc_credentials_owner_id_auth_method").on(
        table.id,
        table.orgId,
        table.userId,
        table.authMethod,
      ),
      index("idx_vnc_credentials_owner_created").on(
        table.orgId,
        table.userId,
        table.createdAt,
        table.id,
      ),
      index("idx_vnc_credentials_user").on(table.userId, table.id),
      check(
        "chk_vnc_credentials_name",
        sql`char_length(${table.name}) BETWEEN 1 AND 128`,
      ),
      check(
        "chk_vnc_credentials_auth",
        sql`(${table.authMethod} IN ('qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password') AND ${table.username} IS NULL) OR (${table.authMethod} = 'rsa_aes_password' AND ${table.username} IS NULL) OR (${table.authMethod} = 'rsa_aes_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255) OR (${table.authMethod} IN ('client_certificate', 'client_certificate_vnc_password') AND ${table.username} IS NULL) OR (${table.authMethod} = 'vnc_password' AND ${table.username} IS NULL) OR (${table.authMethod} = 'username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255) OR (${table.authMethod} = 'qemu_scram_sha256' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255 AND ${table.username} COLLATE "C" ~ '^[!-~]+$' AND ${table.username} !~ '[=,]') OR (${table.authMethod} = 'apple_dh_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 63) OR (${table.authMethod} = 'apple_srp_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 255) OR (${table.authMethod} = 'apple_rsa_srp_username_password' AND ${table.username} IS NOT NULL AND octet_length(${table.username}) BETWEEN 1 AND 234)`,
      ),
      check(
        "chk_vnc_credentials_password",
        sql`(${table.authMethod} IN ('qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password') AND ${table.encryptedPassword} IS NULL AND ${table.encryptedClientIdentity} IS NULL) OR (${table.authMethod} = 'client_certificate' AND ${table.encryptedPassword} IS NULL AND ${table.encryptedClientIdentity} IS NOT NULL AND char_length(${table.encryptedClientIdentity}) > 0) OR (${table.authMethod} = 'client_certificate_vnc_password' AND ${table.encryptedPassword} IS NOT NULL AND char_length(${table.encryptedPassword}) > 0 AND ${table.encryptedClientIdentity} IS NOT NULL AND char_length(${table.encryptedClientIdentity}) > 0) OR (${table.authMethod} NOT IN ('client_certificate', 'client_certificate_vnc_password', 'qemu_kerberos_ticket', 'qemu_kerberos_keytab', 'qemu_kerberos_password') AND ${table.encryptedPassword} IS NOT NULL AND char_length(${table.encryptedPassword}) > 0 AND ${table.encryptedClientIdentity} IS NULL)`,
      ),
      check(
        "chk_vnc_credentials_kerberos_initiator",
        kerberosPrincipalCheck(table.kerberosInitiator),
      ),
      check(
        "chk_vnc_credentials_kerberos_service",
        kerberosPrincipalCheck(table.kerberosService, true),
      ),
      check(
        "chk_vnc_credentials_kerberos",
        sql`CASE
        WHEN ${table.authMethod} = 'qemu_kerberos_ticket' THEN
          ${table.encryptedKerberosCredential} IS NOT NULL AND char_length(${table.encryptedKerberosCredential}) > 0
          AND ${table.kerberosInitiator} IS NOT NULL AND ${table.kerberosService} IS NOT NULL
          AND ${table.kerberosInitiator}->>'realm' = ${table.kerberosService}->>'realm'
          AND ${table.kerberosDeclaredExpiresAt} IS NOT NULL AND ${table.kerberosDeclaredExpiresAt} > 0
        WHEN ${table.authMethod} IN ('qemu_kerberos_keytab', 'qemu_kerberos_password') THEN
          ${table.encryptedKerberosCredential} IS NOT NULL AND char_length(${table.encryptedKerberosCredential}) > 0
          AND ${table.kerberosInitiator} IS NOT NULL AND ${table.kerberosService} IS NULL AND ${table.kerberosDeclaredExpiresAt} IS NULL
        ELSE ${table.encryptedKerberosCredential} IS NULL AND ${table.kerberosInitiator} IS NULL
          AND ${table.kerberosService} IS NULL AND ${table.kerberosDeclaredExpiresAt} IS NULL END`,
      ),
      check("chk_vnc_credentials_revision", sql`${table.revision} > 0`),
    ];
  },
);
