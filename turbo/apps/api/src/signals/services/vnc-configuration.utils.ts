import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import {
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_CA_CERTIFICATES_MAX_COUNT,
  VNC_HOST_MAX_LENGTH,
  type VncSecurity,
  type VncTrust,
} from "@okouai/api-contracts/contracts/vnc-connections";
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
  invalidTrust: {
    kind: "bad_request",
    code: VNC_ERROR_CODES.INVALID_TRUST,
    message: "VNC custom trust requires a bounded bundle of CA certificates",
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

export function canonicalizeVncHost(host: string): VncResult<string> {
  const trimmed = host.trim();
  const value = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (
    value.length === 0 ||
    value.length > VNC_HOST_MAX_LENGTH ||
    containsWhitespaceOrControl(value) ||
    /[[\]@/\\?#%]/u.test(value)
  ) {
    return vncFailure("invalidHost");
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
    return vncFailure("invalidHost");
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
    return vncFailure("invalidHost");
  }
  return { ok: true, value: ascii };
}

export function prepareVncSecurity(security: VncSecurity): VncResult<{
  readonly securityType: "x509_vnc";
  readonly trustMode: "system" | "custom_ca";
  readonly caBundle: string | null;
}> {
  const trust = prepareVncTrust(security.trust);
  if (!trust.ok) {
    return trust;
  }
  return { ok: true, value: { securityType: security.type, ...trust.value } };
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
