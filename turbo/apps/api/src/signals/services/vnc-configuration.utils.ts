import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import {
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_CA_CERTIFICATES_MAX_COUNT,
  VNC_HOST_MAX_LENGTH,
  type VncSecurity,
  type VncTransport,
  type VncTrust,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncAuthentication } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  VNC_ERROR_CODES,
  type VncErrorCode,
} from "@okouai/api-contracts/contracts/vnc-errors";
import type { Db } from "../external/db";
import { safeSync } from "../utils";

export type VncTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type VncResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: "bad_request" | "not_found" | "conflict";
      readonly code: VncErrorCode;
      readonly message: string;
    };

const failures = {
  invalidHost: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_HOST,
    message: "Invalid VNC host",
  },
  invalidAppleDhRoute: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_APPLE_DH_ROUTE,
    message: "Apple DH requires saved SSH to the Mac's loopback VNC service",
  },
  invalidAppleSrpRoute: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_APPLE_SRP_ROUTE,
    message:
      "Apple Direct SRP requires saved SSH to the Mac's loopback VNC service",
  },
  invalidAppleRsaSrpRoute: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_APPLE_RSA_SRP_ROUTE,
    message:
      "Apple RSA/SRP requires saved SSH to the Mac's loopback VNC service",
  },
  invalidServerName: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_SERVER_NAME,
    message: "Invalid VNC X.509 server name",
  },
  invalidTrust: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_TRUST,
    message: "VNC custom trust requires a bounded bundle of CA certificates",
  },
  profileMismatch: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.PROFILE_MISMATCH,
    message: "VNC credential and security profiles do not match",
  },
  credentialNotFound: {
    kind: "not_found",
    code: VNC_ERROR_CODES.CREDENTIAL_NOT_FOUND,
    message: "VNC credential not found",
  },
  connectionNotFound: {
    kind: "not_found",
    code: VNC_ERROR_CODES.CONNECTION_NOT_FOUND,
    message: "VNC connection not found",
  },
  sshConnectionNotFound: {
    kind: "not_found",
    code: VNC_ERROR_CODES.SSH_CONNECTION_NOT_FOUND,
    message: "VNC SSH connection not found",
  },
  credentialConflict: {
    kind: "conflict",
    code: VNC_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT,
    message: "VNC credential was modified by another request",
  },
  generationConflict: {
    kind: "conflict",
    code: VNC_ERROR_CODES.GENERATION_CONFLICT,
    message: "VNC connection was modified by another request",
  },
  credentialInUse: {
    kind: "conflict",
    code: VNC_ERROR_CODES.CREDENTIAL_IN_USE,
    message: "VNC credential is used by a host",
  },
  exhausted: {
    kind: "conflict",
    code: VNC_ERROR_CODES.REVISION_EXHAUSTED,
    message: "VNC configuration revision limit reached",
  },
  ownerChanged: {
    kind: "conflict",
    code: VNC_ERROR_CODES.OWNER_CHANGED,
    message: "VNC owner is no longer writable",
  },
  resourceIdConflict: {
    kind: "conflict",
    code: VNC_ERROR_CODES.RESOURCE_ID_CONFLICT,
    message: "This resource ID cannot be used for this VNC configuration",
  },
} as const;

export function vncFailure(reason: keyof typeof failures) {
  return { ok: false as const, ...failures[reason] };
}

function containsWhitespaceOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return /\s/u.test(character) || codeUnit <= 0x1f || codeUnit === 0x7f;
  });
}

function canonicalizeVncIdentity(
  input: string,
  failure: "invalidHost" | "invalidServerName",
): VncResult<string> {
  const value = input.endsWith(".") ? input.slice(0, -1) : input;
  if (
    value.length === 0 ||
    value.length > VNC_HOST_MAX_LENGTH ||
    containsWhitespaceOrControl(value) ||
    /[[\]@/\\?#%]/u.test(value)
  ) {
    return vncFailure(failure);
  }
  const ipVersion = isIP(value);
  if (ipVersion === 4) {
    return { ok: true, value };
  }
  if (ipVersion === 6) {
    return {
      ok: true,
      value: new URL(`http://[${value}]`).hostname.slice(1, -1),
    };
  }
  if (value.includes(":")) {
    return vncFailure(failure);
  }
  const ascii = domainToASCII(value).toLowerCase();
  const labels = ascii.split(".");
  // WHATWG host parsing accepts abbreviated and hexadecimal IPv4 spellings.
  // Accept IP addresses only through the strict isIP boundary above.
  if (
    ascii.length === 0 ||
    ascii.length > VNC_HOST_MAX_LENGTH ||
    isIP(ascii) !== 0 ||
    labels.every((label) => {
      return /^\d+$/u.test(label);
    }) ||
    labels.some((label) => {
      return (
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      );
    })
  ) {
    return vncFailure(failure);
  }
  return { ok: true, value: ascii };
}

export function canonicalizeVncHost(host: string): VncResult<string> {
  return canonicalizeVncIdentity(host, "invalidHost");
}

function canonicalizeVncServerName(serverName: string): VncResult<string> {
  return canonicalizeVncIdentity(serverName, "invalidServerName");
}

function isPrivateIpv4(host: string): boolean {
  const [first = -1, second = -1] = host.split(".").map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::" || host === "::1") {
    return true;
  }
  const first = Number.parseInt(host.split(":", 1)[0] ?? "", 16);
  if ((first & 0xfe_00) === 0xfc_00 || (first & 0xff_c0) === 0xfe_80) {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(host);
  if (!mapped?.[1] || !mapped[2]) {
    return false;
  }
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return isPrivateIpv4(
    `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
  );
}

function isPrivateOrLoopbackHost(host: string): boolean {
  const version = isIP(host);
  return version === 4
    ? isPrivateIpv4(host)
    : version === 6 && isPrivateIpv6(host);
}

export function prepareVncTransport(
  transport: VncTransport | undefined,
  host: string,
): VncResult<{
  readonly transportType: "direct" | "ssh";
  readonly sshConnectionId: string | null;
}> {
  if (transport?.type === "ssh") {
    return {
      ok: true,
      value: {
        transportType: "ssh",
        sshConnectionId: transport.connectionId,
      },
    };
  }
  return isPrivateOrLoopbackHost(host)
    ? vncFailure("invalidHost")
    : {
        ok: true,
        value: { transportType: "direct", sshConnectionId: null },
      };
}

export function prepareVncSecurity(security: VncSecurity): VncResult<{
  readonly securityType: VncSecurity["type"];
  readonly trustMode: "system" | "custom_ca" | "none";
  readonly caBundle: string | null;
  readonly x509ServerName: string | null;
}> {
  if (
    security.type === "apple_dh" ||
    security.type === "apple_srp" ||
    security.type === "apple_rsa_srp"
  ) {
    return {
      ok: true,
      value: {
        securityType: security.type,
        trustMode: "none",
        caBundle: null,
        x509ServerName: null,
      },
    };
  }
  const trust = prepareVncTrust(security.trust);
  if (!trust.ok) {
    return trust;
  }
  const serverName =
    security.serverName === undefined
      ? undefined
      : canonicalizeVncServerName(security.serverName);
  if (serverName !== undefined && !serverName.ok) {
    return serverName;
  }
  return {
    ok: true,
    value: {
      securityType: security.type,
      ...trust.value,
      x509ServerName: serverName?.value ?? null,
    },
  };
}

export function isVncProfileCompatible(
  authMethod: VncAuthentication["method"],
  securityType: VncSecurity["type"],
): boolean {
  return (
    (authMethod === "vnc_password" && securityType === "x509_vnc") ||
    (authMethod === "username_password" && securityType === "x509_plain") ||
    (authMethod === "apple_dh_username_password" &&
      securityType === "apple_dh") ||
    (authMethod === "apple_srp_username_password" &&
      securityType === "apple_srp") ||
    (authMethod === "apple_rsa_srp_username_password" &&
      securityType === "apple_rsa_srp")
  );
}

export function validateVncProfileRoute(
  securityType: VncSecurity["type"],
  host: string,
  transportType: "direct" | "ssh",
): VncResult<undefined> {
  if (
    (securityType === "apple_dh" ||
      securityType === "apple_srp" ||
      securityType === "apple_rsa_srp") &&
    (transportType !== "ssh" || (host !== "127.0.0.1" && host !== "::1"))
  ) {
    return vncFailure(
      securityType === "apple_dh"
        ? "invalidAppleDhRoute"
        : securityType === "apple_srp"
          ? "invalidAppleSrpRoute"
          : "invalidAppleRsaSrpRoute",
    );
  }
  return { ok: true, value: undefined };
}

function prepareVncTrust(trust: VncTrust): VncResult<{
  readonly trustMode: "system" | "custom_ca";
  readonly caBundle: string | null;
}> {
  if (trust.mode === "system") {
    return { ok: true, value: { trustMode: "system", caBundle: null } };
  }
  if (Buffer.byteLength(trust.caBundle, "utf8") > VNC_CA_BUNDLE_MAX_LENGTH) {
    return vncFailure("invalidTrust");
  }
  const certificates: string[] = [];
  let remaining = trust.caBundle.trim();
  while (remaining.length > 0) {
    if (certificates.length === VNC_CA_CERTIFICATES_MAX_COUNT) {
      return vncFailure("invalidTrust");
    }
    const match =
      /^-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+)\s*-----END CERTIFICATE-----/u.exec(
        remaining,
      );
    if (!match || match[1] === undefined) {
      return vncFailure("invalidTrust");
    }
    const encoded = match[1].replace(/[\r\n]/gu, "");
    const der = Buffer.from(encoded, "base64");
    if (der.toString("base64") !== encoded) {
      return vncFailure("invalidTrust");
    }
    const certificate = safeSync(() => {
      return new X509Certificate(der);
    });
    if (
      !("ok" in certificate) ||
      !certificate.ok.ca ||
      !certificate.ok.raw.equals(der)
    ) {
      return vncFailure("invalidTrust");
    }
    certificates.push(certificate.ok.toString().trim());
    remaining = remaining.slice(match[0].length).trim();
  }
  const caBundle = certificates.join("\n") + "\n";
  if (
    certificates.length === 0 ||
    Buffer.byteLength(caBundle, "utf8") > VNC_CA_BUNDLE_MAX_LENGTH
  ) {
    return vncFailure("invalidTrust");
  }
  return { ok: true, value: { trustMode: "custom_ca", caBundle } };
}
