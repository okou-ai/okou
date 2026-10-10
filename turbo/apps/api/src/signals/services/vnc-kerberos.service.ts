import {
  isVncKerberosMethod,
  sameKerberosPrincipal,
  vncKerberosAuthenticationSchema,
  type VncKerberosAuthentication,
} from "@okouai/api-contracts/contracts/vnc-kerberos";
import {
  canonicalKerberosKeytab,
  canonicalKerberosTicket,
  decodeKerberosMaterial,
  encodeAndClearKerberosMaterial,
} from "@okouai/api-contracts/contracts/vnc-kerberos-format";
import type { vncCredentials } from "@okouai/db/schema/vnc-credential";
import { nowDate } from "../../lib/time";

export function canonicalizeVncKerberos(
  authentication: unknown,
  nowSeconds = Math.floor(nowDate().getTime() / 1000),
) {
  const parsed = vncKerberosAuthenticationSchema.safeParse(authentication);
  if (!parsed.success) {
    throw new Error("Invalid Kerberos credential");
  }
  const source = parsed.data;
  if (source.method === "qemu_kerberos_password") {
    return { authentication: source, declaredExpiresAt: null };
  }
  const input = decodeKerberosMaterial(
    source.method === "qemu_kerberos_ticket"
      ? source.ticketCache
      : source.keytab,
  );
  const normalized =
    source.method === "qemu_kerberos_ticket"
      ? canonicalKerberosTicket(
          input,
          source.initiator,
          source.service,
          nowSeconds,
        )
      : {
          bytes: canonicalKerberosKeytab(input, source.initiator),
          declaredExpiresAt: null,
        };
  const encoded = encodeAndClearKerberosMaterial(normalized.bytes);
  const canonical: VncKerberosAuthentication =
    source.method === "qemu_kerberos_ticket"
      ? { ...source, ticketCache: encoded }
      : { ...source, keytab: encoded };
  return {
    authentication: canonical,
    declaredExpiresAt: normalized.declaredExpiresAt,
  };
}

type Stored = Pick<
  typeof vncCredentials.$inferSelect,
  | "authMethod"
  | "kerberosInitiator"
  | "kerberosService"
  | "kerberosDeclaredExpiresAt"
>;

/** Parse the dedicated KMS envelope without reflecting JSON/schema/secret details. */
export function parseStoredVncKerberos(
  row: Stored,
  plaintext: string,
  nowSeconds: number,
): VncKerberosAuthentication {
  if (plaintext.length > 100_000 || !isVncKerberosMethod(row.authMethod)) {
    throw new Error("Invalid stored Kerberos credential");
  }
  const value: unknown = JSON.parse(plaintext);
  const parsed = vncKerberosAuthenticationSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.method !== row.authMethod ||
    row.kerberosInitiator === null ||
    !sameKerberosPrincipal(parsed.data.initiator, row.kerberosInitiator)
  ) {
    throw new Error("Invalid stored Kerberos credential");
  }
  const canonical = canonicalizeVncKerberos(parsed.data, nowSeconds);
  if (canonical.authentication.method === "qemu_kerberos_ticket") {
    if (
      row.kerberosService === null ||
      !sameKerberosPrincipal(
        canonical.authentication.service,
        row.kerberosService,
      ) ||
      canonical.declaredExpiresAt !== row.kerberosDeclaredExpiresAt
    ) {
      throw new Error("Invalid stored Kerberos credential");
    }
  } else if (
    row.kerberosService !== null ||
    row.kerberosDeclaredExpiresAt !== null
  ) {
    throw new Error("Invalid stored Kerberos credential");
  }
  return canonical.authentication;
}
