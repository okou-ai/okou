import { z } from "zod";

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
export const firewallPermissionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  rules: z.array(z.string()),
});

export const firewallAwsSigv4AuthSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();

const firewallAuthSchema = z
  .object({
    headers: z.record(z.string(), z.string()).optional(),
    base: z.string().min(1).optional(),
    query: z.record(z.string(), z.string()).optional(),
    awsSigv4: firewallAwsSigv4AuthSchema.optional(),
  })
  .superRefine((auth, ctx) => {
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

const firewallProviderOwnedHostPolicySchema = z
  .object({
    kind: z.literal("providerOwned"),
    exactHosts: z.array(z.string().min(1)).optional(),
    suffixes: z.array(z.string().min(1)).optional(),
    allowNonDefaultPort: z.boolean().optional(),
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

const firewallPublicDestinationHostPolicySchema = z
  .object({
    kind: z.literal("publicDestination"),
  })
  .strict();

export const firewallBaseHostPolicySchema = z.union([
  firewallProviderOwnedHostPolicySchema,
  firewallPublicDestinationHostPolicySchema,
]);

export const firewallApiSchema = z.object({
  base: z.string(),
  hostPolicy: firewallBaseHostPolicySchema.optional(),
  auth: firewallAuthSchema,
  permissions: z.array(firewallPermissionSchema).optional(),
});

export const firewallSchema = z.object({
  name: z.string(),
  apis: z.array(firewallApiSchema),
});

export const firewallsSchema = z.array(firewallSchema);

export const executionFirewallBuiltinEntrySchema = z.object({
  kind: z.literal("builtin"),
  name: z.string().min(1),
  baseUrlVars: z.record(z.string(), z.string()).optional(),
  sourceId: z.uuid().optional(),
});

const executionFirewallSchema = firewallSchema.extend({
  apis: z.array(
    firewallApiSchema.extend({
      id: z.string().min(1).optional(),
    }),
  ),
});

export const executionFirewallInlineEntrySchema = z.object({
  kind: z.literal("inline"),
  firewall: executionFirewallSchema,
  customConnectorId: z.uuid().optional(),
  sourceId: z.uuid().optional(),
});

export const executionFirewallEntrySchema = z.discriminatedUnion("kind", [
  executionFirewallBuiltinEntrySchema,
  executionFirewallInlineEntrySchema,
]);

export const executionFirewallsSchema = z.array(executionFirewallEntrySchema);

export const UNKNOWN_PERMISSION_GRANT = "__unknown__";

export const firewallConfigSchema = z.object({
  name: z.string().min(1, "Firewall name is required"),
  description: z.string().optional(),
  apis: z
    .array(firewallApiSchema)
    .min(1, "Firewall must have at least one API entry"),
  placeholders: z.record(z.string(), z.string()).optional(),
});

export const firewallPolicyValueSchema = z.enum(["allow", "deny", "ask"]);
export type FirewallPolicyValue = z.infer<typeof firewallPolicyValueSchema>;

export const firewallPolicySchema = z.object({
  policies: z.record(z.string(), firewallPolicyValueSchema),
  unknownPolicy: firewallPolicyValueSchema.optional(),
});
export type FirewallPolicy = z.infer<typeof firewallPolicySchema>;

export const firewallPoliciesSchema = z.record(
  z.string(),
  firewallPolicySchema,
);
export type FirewallPolicies = z.infer<typeof firewallPoliciesSchema>;

export const networkPolicySchema = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  ask: z.array(z.string()),
  unknownPolicy: firewallPolicyValueSchema,
});
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;

export const networkPoliciesSchema = z.record(z.string(), networkPolicySchema);
export type NetworkPolicies = z.infer<typeof networkPoliciesSchema>;

export type FirewallApi = z.infer<typeof firewallApiSchema>;
export type FirewallBaseHostPolicy = z.infer<
  typeof firewallBaseHostPolicySchema
>;
export type FirewallConfig = z.infer<typeof firewallConfigSchema>;

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

export type Firewall = z.infer<typeof firewallSchema>;
export type Firewalls = z.infer<typeof firewallsSchema>;
export type ExecutionFirewallBuiltinEntry = z.infer<
  typeof executionFirewallBuiltinEntrySchema
>;
export type ExecutionFirewallInlineEntry = z.infer<
  typeof executionFirewallInlineEntrySchema
>;
export type ExecutionFirewallEntry = z.infer<
  typeof executionFirewallEntrySchema
>;
export type ExecutionFirewalls = z.infer<typeof executionFirewallsSchema>;
