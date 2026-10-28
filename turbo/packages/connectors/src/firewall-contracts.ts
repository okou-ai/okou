import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  object,
  record,
  string,
  union,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { hasRawWhitespace, hasUnsafeUrlCodepoint } from "./firewall-url-utils";

const HOST_DOT_EQUIVALENT_PATTERN = /[\u3002\uff0e\uff61]/g;
const HOST_POLICY_HOST_FORBIDDEN_PATTERN = /[%*[\]/?#@\\:{}<>^|]/u;
const UNICODE_DECIMAL_NUMBER_PATTERN = /^\p{Decimal_Number}+$/u;

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function isHexDigit(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    (char >= "a" && char <= "f") ||
    (char >= "A" && char <= "F")
  );
}

function isIpv4NumberComponent(value: string): boolean {
  if (value === "") return false;
  if (value.toLowerCase().startsWith("0x")) {
    if (value.length <= 2) return false;
    for (const char of value.slice(2)) {
      if (!isHexDigit(char)) return false;
    }
    return true;
  }
  return UNICODE_DECIMAL_NUMBER_PATTERN.test(value);
}

function isIpv4LiteralLike(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length >= 1 && parts.length <= 4 && parts.every(isIpv4NumberComponent)
  );
}

function isCanonicalIpv4Address(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (
      part === "" ||
      ![...part].every((char) => {
        return char >= "0" && char <= "9";
      })
    ) {
      return false;
    }
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number(part) <= 255;
  });
}

function parseCanonicalIpv4Address(value: string): readonly number[] | null {
  if (!isCanonicalIpv4Address(value)) {
    return null;
  }
  return value.split(".").map((part) => {
    return Number(part);
  });
}

function parseIpv6Word(value: string): number | null {
  if (
    value === "" ||
    value.length > 4 ||
    ![...value].every((char) => {
      return isHexDigit(char);
    })
  ) {
    return null;
  }
  return Number.parseInt(value, 16);
}

function parseIpv6WordList(value: string): readonly number[] | null {
  if (value === "") {
    return [];
  }
  const words: number[] = [];
  for (const part of value.split(":")) {
    const word = parseIpv6Word(part);
    if (word === null) {
      return null;
    }
    words.push(word);
  }
  return words;
}

function parseIpv6Address(value: string): readonly number[] | null {
  if (value.includes("%")) {
    return null;
  }

  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const ipv4Parts = parseCanonicalIpv4Address(
      normalized.slice(lastColon + 1),
    );
    if (!ipv4Parts) {
      return null;
    }
    const highWord = (ipv4Parts[0]! << 8) + ipv4Parts[1]!;
    const lowWord = (ipv4Parts[2]! << 8) + ipv4Parts[3]!;
    normalized = `${normalized.slice(0, lastColon)}:${highWord.toString(16)}:${lowWord.toString(16)}`;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) {
    return null;
  }

  const left = parseIpv6WordList(compressed[0]!);
  const right =
    compressed.length === 2 ? parseIpv6WordList(compressed[1]!) : [];
  if (!left || !right) {
    return null;
  }

  if (compressed.length === 1) {
    return left.length === 8 ? left : null;
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) {
    return null;
  }
  return [
    ...left,
    ...Array.from({ length: zeroCount }, () => {
      return 0;
    }),
    ...right,
  ];
}

function hostPolicyHostHasFixedOwnership(
  value: string,
  options: { readonly allowLeadingDot: boolean },
): boolean {
  if (!options.allowLeadingDot && value.startsWith(".")) {
    return false;
  }
  const rawHost =
    options.allowLeadingDot && value.startsWith(".") ? value.slice(1) : value;
  const normalized = rawHost
    .replace(HOST_DOT_EQUIVALENT_PATTERN, ".")
    .toLowerCase();
  const withoutTrailingDot = normalized.endsWith(".")
    ? normalized.slice(0, -1)
    : normalized;
  if (
    withoutTrailingDot === "" ||
    !isAscii(value) ||
    hasRawWhitespace(value) ||
    hasUnsafeUrlCodepoint(value) ||
    HOST_POLICY_HOST_FORBIDDEN_PATTERN.test(withoutTrailingDot)
  ) {
    return false;
  }
  if (
    isIpv4LiteralLike(withoutTrailingDot) ||
    parseIpv6Address(withoutTrailingDot)
  ) {
    return false;
  }
  const labels = withoutTrailingDot.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => {
      return label !== "";
    })
  );
}

/** Firewall permission schema — a named permission group with matching rules. */
export const firewallPermissionSchema = object({
  name: string(),
  description: string().optional(),
  rules: array(string()),
});

export const firewallAwsSigv4AuthSchema = object({
  accessKeyId: string().min(1),
  secretAccessKey: string().min(1),
  sessionToken: string().min(1).optional(),
}).strict();

const firewallAuthSchema = object({
  headers: record(string(), string()).optional(),
  base: string().min(1).optional(),
  query: record(string(), string()).optional(),
  awsSigv4: firewallAwsSigv4AuthSchema.optional(),
}).superRefine((auth, ctx) => {
  if (!auth.awsSigv4) {
    return;
  }
  if (auth.headers && Object.keys(auth.headers).length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["headers"],
      message: "auth.headers cannot be combined with auth.awsSigv4",
    });
  }
  if (auth.query && Object.keys(auth.query).length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["query"],
      message: "auth.query cannot be combined with auth.awsSigv4",
    });
  }
  if (auth.base !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["base"],
      message: "auth.base cannot be combined with auth.awsSigv4",
    });
  }
});

const firewallProviderOwnedHostPolicySchema = object({
  kind: literal("providerOwned"),
  exactHosts: array(string().min(1)).optional(),
  suffixes: array(string().min(1)).optional(),
  allowNonDefaultPort: boolean().optional(),
})
  .strict()
  .superRefine((policy, ctx) => {
    if (
      (policy.exactHosts?.length ?? 0) === 0 &&
      (policy.suffixes?.length ?? 0) === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "providerOwned host policy requires exactHosts or suffixes",
      });
    }
    for (const [index, exactHost] of (policy.exactHosts ?? []).entries()) {
      if (
        !hostPolicyHostHasFixedOwnership(exactHost, { allowLeadingDot: false })
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["exactHosts", index],
          message:
            "providerOwned host policy exactHosts must be fixed hostnames with at least two labels",
        });
      }
    }
    for (const [index, suffix] of (policy.suffixes ?? []).entries()) {
      if (!hostPolicyHostHasFixedOwnership(suffix, { allowLeadingDot: true })) {
        ctx.addIssue({
          code: "custom",
          path: ["suffixes", index],
          message:
            "providerOwned host policy suffixes must be fixed hostnames with at least two labels",
        });
      }
    }
  });

const firewallPublicDestinationHostPolicySchema = object({
  kind: literal("publicDestination"),
}).strict();

export const firewallBaseHostPolicySchema = union([
  firewallProviderOwnedHostPolicySchema,
  firewallPublicDestinationHostPolicySchema,
]);

export const firewallApiSchema = object({
  base: string(),
  hostPolicy: firewallBaseHostPolicySchema.optional(),
  auth: firewallAuthSchema,
  permissions: array(firewallPermissionSchema).optional(),
});

export const firewallSchema = object({
  name: string(),
  apis: array(firewallApiSchema),
});

export const firewallsSchema = array(firewallSchema);

export const executionFirewallBuiltinEntrySchema = object({
  kind: literal("builtin"),
  name: string().min(1),
  baseUrlVars: record(string(), string()).optional(),
  sourceId: uuid().optional(),
});

const executionFirewallSchema = firewallSchema.extend({
  apis: array(
    firewallApiSchema.extend({
      id: string().min(1).optional(),
    }),
  ),
});

export const executionFirewallInlineEntrySchema = object({
  kind: literal("inline"),
  firewall: executionFirewallSchema,
  customConnectorId: uuid().optional(),
  sourceId: uuid().optional(),
});

export const executionFirewallEntrySchema = discriminatedUnion("kind", [
  executionFirewallBuiltinEntrySchema,
  executionFirewallInlineEntrySchema,
]);

export const executionFirewallsSchema = array(executionFirewallEntrySchema);

export const UNKNOWN_PERMISSION_GRANT = "__unknown__";

export const firewallConfigSchema = object({
  name: string().min(1, "Firewall name is required"),
  description: string().optional(),
  apis: array(firewallApiSchema).min(
    1,
    "Firewall must have at least one API entry",
  ),
  placeholders: record(string(), string()).optional(),
});

export const firewallPolicyValueSchema = zEnum(["allow", "deny", "ask"]);
export type FirewallPolicyValue = zInfer<typeof firewallPolicyValueSchema>;

export const firewallPolicySchema = object({
  policies: record(string(), firewallPolicyValueSchema),
  unknownPolicy: firewallPolicyValueSchema.optional(),
});
export type FirewallPolicy = zInfer<typeof firewallPolicySchema>;

export const firewallPoliciesSchema = record(string(), firewallPolicySchema);
export type FirewallPolicies = zInfer<typeof firewallPoliciesSchema>;

export const networkPolicySchema = object({
  allow: array(string()),
  deny: array(string()),
  ask: array(string()),
  unknownPolicy: firewallPolicyValueSchema,
});
export type NetworkPolicy = zInfer<typeof networkPolicySchema>;

export const networkPoliciesSchema = record(string(), networkPolicySchema);
export type NetworkPolicies = zInfer<typeof networkPoliciesSchema>;

export type FirewallApi = zInfer<typeof firewallApiSchema>;
export type FirewallBaseHostPolicy = zInfer<
  typeof firewallBaseHostPolicySchema
>;
export type FirewallConfig = zInfer<typeof firewallConfigSchema>;

export type PermissionNamesOf<T extends FirewallConfig> =
  T["apis"][number] extends infer Api
    ? Api extends { readonly permissions?: infer P }
      ? P extends ReadonlyArray<{ readonly name: infer N }>
        ? N extends string
          ? N
          : never
        : never
      : never
    : never;

export type Firewall = zInfer<typeof firewallSchema>;
export type Firewalls = zInfer<typeof firewallsSchema>;
export type ExecutionFirewallBuiltinEntry = zInfer<
  typeof executionFirewallBuiltinEntrySchema
>;
export type ExecutionFirewallInlineEntry = zInfer<
  typeof executionFirewallInlineEntrySchema
>;
export type ExecutionFirewallEntry = zInfer<
  typeof executionFirewallEntrySchema
>;
export type ExecutionFirewalls = zInfer<typeof executionFirewallsSchema>;
