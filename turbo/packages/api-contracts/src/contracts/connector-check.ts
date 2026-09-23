import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { connectorSlugSchema } from "./connector-identity";
import { apiErrorSchema } from "./errors";
import { connectorRuntimeTargetSchema } from "./runners";
import {
  AWS_PREDICATE_VALUE_RE,
  AWS_QUERY_KEY_RE,
  AWS_QUERY_VALUE_RE,
  AWS_S3_PERMISSION_HEADER_NAMES,
  isSensitiveAwsDiagnosticQueryKey,
} from "@okouai/connectors/firewall-expander";

const c = initContract();

const boundedNameSchema = z.string().min(1).max(255);
const connectorCheckAwsQuerySelectorSchema = z
  .object({
    key: z.string().min(1).max(128).regex(AWS_QUERY_KEY_RE),
    value: z
      .string()
      .max(256)
      .refine((value) => {
        return value === "*" || AWS_QUERY_VALUE_RE.test(value);
      })
      .optional(),
  })
  .strict();

const connectorCheckAwsSelectorsBaseSchema = z
  .object({
    sigv4Service: z.string().min(1).max(128).regex(AWS_PREDICATE_VALUE_RE),
    action: z.string().min(1).max(256).regex(AWS_PREDICATE_VALUE_RE).optional(),
    target: z.string().min(1).max(256).regex(AWS_PREDICATE_VALUE_RE).optional(),
    query: z.array(connectorCheckAwsQuerySelectorSchema).max(32).optional(),
    headerNames: z
      .array(z.enum(AWS_S3_PERMISSION_HEADER_NAMES))
      .max(AWS_S3_PERMISSION_HEADER_NAMES.length)
      .optional(),
  })
  .strict();

type ConnectorCheckAwsSelectors = z.infer<
  typeof connectorCheckAwsSelectorsBaseSchema
>;
type ConnectorCheckAwsQuerySelector = z.infer<
  typeof connectorCheckAwsQuerySelectorSchema
>;

function validateAwsQuerySelectors(
  selectors: readonly ConnectorCheckAwsQuerySelector[],
  ctx: z.RefinementCtx,
): void {
  const seenQueryKeys = new Set<string>();
  for (const [index, selector] of selectors.entries()) {
    if (isSensitiveAwsDiagnosticQueryKey(selector.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["query", index, "key"],
        message:
          "AWS authentication query parameters cannot be diagnostic selectors",
      });
    }
    if (selector.value === "") {
      ctx.addIssue({
        code: "custom",
        path: ["query", index, "value"],
        message: "AWS query selector values must not be empty",
      });
    }
    if (seenQueryKeys.has(selector.key)) {
      ctx.addIssue({
        code: "custom",
        path: ["query", index, "key"],
        message: `Duplicate AWS query selector: ${selector.key}`,
      });
    }
    seenQueryKeys.add(selector.key);
  }
}

function validateAwsActionQuery(
  selectors: ConnectorCheckAwsSelectors,
  ctx: z.RefinementCtx,
): void {
  if (selectors.action === undefined) return;
  const actions = (selectors.query ?? []).filter((selector) => {
    return selector.key === "Action";
  });
  if (
    actions.length > 0 &&
    (actions.length !== 1 || actions[0]?.value !== selectors.action)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["query"],
      message: "AWS Action query selector conflicts with the action selector",
    });
  }
}

function validateAwsHeaderSelectors(
  selectors: ConnectorCheckAwsSelectors,
  ctx: z.RefinementCtx,
): void {
  const seenHeaderNames = new Set<string>();
  for (const [index, name] of (selectors.headerNames ?? []).entries()) {
    if (seenHeaderNames.has(name)) {
      ctx.addIssue({
        code: "custom",
        path: ["headerNames", index],
        message: `Duplicate AWS permission-selector header: ${name}`,
      });
    }
    seenHeaderNames.add(name);
  }
  if (
    seenHeaderNames.size > 0 &&
    (selectors.sigv4Service !== "s3" ||
      selectors.action !== undefined ||
      selectors.target !== undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["headerNames"],
      message:
        "AWS permission-selector headers are supported only for actionless S3 rules",
    });
  }
}

function validateAwsCheckSelectors(
  selectors: ConnectorCheckAwsSelectors,
  ctx: z.RefinementCtx,
): void {
  if (selectors.action !== undefined && selectors.target !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["target"],
      message: "AWS action and target selectors cannot be combined",
    });
  }
  if (
    selectors.target !== undefined &&
    (selectors.query ?? []).some((selector) => {
      return selector.key === "Action";
    })
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["query"],
      message: "AWS Action query selector conflicts with the target selector",
    });
  }
  validateAwsQuerySelectors(selectors.query ?? [], ctx);
  validateAwsActionQuery(selectors, ctx);
  validateAwsHeaderSelectors(selectors, ctx);
}

const connectorCheckAwsSelectorsSchema =
  connectorCheckAwsSelectorsBaseSchema.superRefine(validateAwsCheckSelectors);

const connectorCheckUrlRequestSchema = z
  .object({
    mode: z.literal("url"),
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(8192),
    aws: connectorCheckAwsSelectorsSchema.optional(),
    connectorSlug: connectorSlugSchema.optional(),
    environmentName: boundedNameSchema.optional(),
  })
  .strict();

const connectorCheckEnvironmentRequestSchema = z
  .object({
    mode: z.literal("environment"),
    environmentName: boundedNameSchema,
    permission: boundedNameSchema.optional(),
  })
  .strict();

export const connectorCheckRequestSchema = z.discriminatedUnion("mode", [
  connectorCheckUrlRequestSchema,
  connectorCheckEnvironmentRequestSchema,
]);

export type ConnectorCheckRequest = z.infer<typeof connectorCheckRequestSchema>;

export const connectorCheckTargetAwareUrlRequestSchema = z
  .object({
    mode: z.literal("url"),
    method: z.string().min(1).max(16),
    url: z.string().min(1).max(8192),
    aws: connectorCheckAwsSelectorsSchema.optional(),
    environmentName: boundedNameSchema.optional(),
    includeCustomConnectors: z.literal(true).optional(),
    target: connectorRuntimeTargetSchema.optional(),
  })
  .strict()
  .refine(
    (request) => {
      return (
        request.includeCustomConnectors === true || request.target !== undefined
      );
    },
    { message: "Target-aware connector checks require custom scope or target" },
  );

export const connectorCheckRequestBodySchema = z.union([
  connectorCheckUrlRequestSchema,
  connectorCheckTargetAwareUrlRequestSchema,
  connectorCheckEnvironmentRequestSchema,
]);

export type ConnectorCheckTargetAwareUrlRequest = z.infer<
  typeof connectorCheckTargetAwareUrlRequestSchema
>;
export type ConnectorCheckRequestBody = z.infer<
  typeof connectorCheckRequestBodySchema
>;

const connectorCheckIdentitySchema = z.object({
  connectorSlug: connectorSlugSchema,
  label: z.string().min(1),
  visibility: z.enum(["available", "unavailable"]),
  credentialResolution: z.enum(["network-boundary", "none"]),
});

const connectorCheckCandidateSchema = z.object({
  connectorSlug: connectorSlugSchema,
  label: z.string().min(1),
});

const connectorCheckTargetIdentitySchema = z
  .object({
    target: connectorRuntimeTargetSchema,
    label: z.string().min(1),
    visibility: z.enum(["available", "unavailable"]),
    credentialResolution: z.enum(["network-boundary", "none"]),
  })
  .strict();

const connectorCheckTargetCandidateSchema = z
  .object({
    target: connectorRuntimeTargetSchema,
    label: z.string().min(1),
  })
  .strict();

const connectorCheckNotScopedRunSchema = z
  .object({ status: z.literal("not-scoped") })
  .strict();

const connectorCheckConfiguredRunSchema = z
  .object({
    status: z.literal("configured"),
    bases: z.array(z.string().min(1)),
  })
  .strict();

const connectorCheckNotConfiguredRunSchema = z
  .object({ status: z.literal("not-configured") })
  .strict();

const connectorCheckRunSchema = z.discriminatedUnion("status", [
  connectorCheckNotScopedRunSchema,
  connectorCheckConfiguredRunSchema,
  connectorCheckNotConfiguredRunSchema,
]);

const connectorCheckAllowPolicySchema = z
  .object({
    outcome: z.literal("allow"),
    basis: z.enum(["allow-list", "not-blocked", "no-policy", "unknown-policy"]),
  })
  .strict();

const connectorCheckDenyPolicySchema = z
  .object({
    outcome: z.literal("deny"),
    basis: z.enum(["deny-list", "unknown-policy"]),
  })
  .strict();

const connectorCheckAskPolicySchema = z
  .object({
    outcome: z.literal("ask"),
    basis: z.enum(["ask-list", "unknown-policy"]),
  })
  .strict();

const connectorCheckUnavailablePolicySchema = z
  .object({
    outcome: z.literal("unavailable"),
    basis: z.enum([
      "not-run-scoped",
      "policies-unavailable",
      "connector-not-configured",
    ]),
  })
  .strict();

export const connectorCheckPolicySchema = z.discriminatedUnion("outcome", [
  connectorCheckAllowPolicySchema,
  connectorCheckDenyPolicySchema,
  connectorCheckAskPolicySchema,
  connectorCheckUnavailablePolicySchema,
]);

export type ConnectorCheckPolicy = z.infer<typeof connectorCheckPolicySchema>;

const connectorCheckMatchedPermissionSchema = z
  .object({
    name: z.string().min(1),
    policy: connectorCheckPolicySchema,
  })
  .strict();

const connectorCheckMatchedPermissionsSchema = z
  .object({
    kind: z.literal("matched"),
    permissions: z.array(connectorCheckMatchedPermissionSchema).min(1),
  })
  .strict();

const connectorCheckUnknownEndpointSchema = z
  .object({
    kind: z.literal("unknown-endpoint"),
    policy: connectorCheckPolicySchema,
  })
  .strict();

const connectorCheckPermissionResultSchema = z.discriminatedUnion("kind", [
  connectorCheckMatchedPermissionsSchema,
  connectorCheckUnknownEndpointSchema,
]);

const connectorCheckResolvedUrlSchema = z
  .object({
    outcome: z.literal("resolved"),
    mode: z.literal("url"),
    connector: connectorCheckIdentitySchema,
    environmentNames: z.array(boundedNameSchema).nullable(),
    run: connectorCheckRunSchema,
    method: z.string().min(1).max(16),
    base: z.string().min(1),
    relativePath: z.string().min(1),
    permission: connectorCheckPermissionResultSchema,
  })
  .strict();

const connectorCheckResolvedEnvironmentSchema = z
  .object({
    outcome: z.literal("resolved"),
    mode: z.literal("environment"),
    connector: connectorCheckIdentitySchema,
    environmentName: boundedNameSchema,
    run: connectorCheckRunSchema,
    permission: connectorCheckPolicySchema.nullable(),
  })
  .strict();

const connectorCheckUnsafeInputSchema = z
  .object({
    outcome: z.literal("unsafe-input"),
    reason: z.enum(["invalid-method", "invalid-url", "unsafe-path"]),
  })
  .strict();

const connectorCheckUnknownConnectorSchema = z
  .object({ outcome: z.literal("unknown-connector") })
  .strict();

const connectorCheckUnknownEnvironmentSchema = z
  .object({ outcome: z.literal("unknown-environment") })
  .strict();

const connectorCheckNoMatchSchema = z
  .object({
    outcome: z.literal("no-match"),
    scope: z.enum(["run", "catalog"]),
  })
  .strict();

const connectorCheckAmbiguousSchema = z
  .object({
    outcome: z.literal("ambiguous"),
    candidates: z.array(connectorCheckCandidateSchema).min(2),
  })
  .strict();

const connectorCheckMismatchSchema = z
  .object({
    outcome: z.literal("connector-mismatch"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckEnvironmentNotOwnedSchema = z
  .object({
    outcome: z.literal("environment-not-owned"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckEnvironmentNotUsedSchema = z
  .object({
    outcome: z.literal("environment-not-used"),
    connector: connectorCheckIdentitySchema,
    environmentNames: z.array(boundedNameSchema),
  })
  .strict();

const connectorCheckUnresolvedDynamicBaseSchema = z
  .object({
    outcome: z.literal("unresolved-dynamic-base"),
    connector: connectorCheckIdentitySchema,
  })
  .strict();

const connectorCheckRunContextUnavailableSchema = z
  .object({ outcome: z.literal("run-context-unavailable") })
  .strict();

const connectorCheckTargetResolvedUrlSchema = connectorCheckResolvedUrlSchema
  .extend({ connector: connectorCheckTargetIdentitySchema })
  .strict();

const connectorCheckTargetResolvedEnvironmentSchema =
  connectorCheckResolvedEnvironmentSchema
    .extend({ connector: connectorCheckTargetIdentitySchema })
    .strict();

const connectorCheckTargetAmbiguousSchema = connectorCheckAmbiguousSchema
  .extend({ candidates: z.array(connectorCheckTargetCandidateSchema).min(2) })
  .strict();

const connectorCheckTargetMismatchSchema = connectorCheckMismatchSchema
  .extend({ connector: connectorCheckTargetIdentitySchema })
  .strict();

const connectorCheckTargetEnvironmentNotOwnedSchema =
  connectorCheckEnvironmentNotOwnedSchema
    .extend({ connector: connectorCheckTargetIdentitySchema })
    .strict();

const connectorCheckTargetEnvironmentNotUsedSchema =
  connectorCheckEnvironmentNotUsedSchema
    .extend({ connector: connectorCheckTargetIdentitySchema })
    .strict();

const connectorCheckTargetUnresolvedDynamicBaseSchema =
  connectorCheckUnresolvedDynamicBaseSchema
    .extend({ connector: connectorCheckTargetIdentitySchema })
    .strict();

const connectorCheckTargetUnavailableSchema = z
  .object({
    outcome: z.literal("target-unavailable"),
    target: connectorRuntimeTargetSchema,
    reason: z.enum([
      "not-admitted",
      "connector-unavailable",
      "permission-bundle-unavailable",
      "runtime-configuration-unavailable",
    ]),
  })
  .strict();

export const connectorCheckDiagnosticResultSchema = z.union([
  connectorCheckResolvedUrlSchema,
  connectorCheckResolvedEnvironmentSchema,
  connectorCheckUnsafeInputSchema,
  connectorCheckUnknownConnectorSchema,
  connectorCheckUnknownEnvironmentSchema,
  connectorCheckNoMatchSchema,
  connectorCheckAmbiguousSchema,
  connectorCheckMismatchSchema,
  connectorCheckEnvironmentNotOwnedSchema,
  connectorCheckEnvironmentNotUsedSchema,
  connectorCheckUnresolvedDynamicBaseSchema,
  connectorCheckRunContextUnavailableSchema,
]);

export type ConnectorCheckDiagnosticResult = z.infer<
  typeof connectorCheckDiagnosticResultSchema
>;

export const connectorCheckTargetAwareDiagnosticResultSchema = z.union([
  connectorCheckTargetResolvedUrlSchema,
  connectorCheckTargetResolvedEnvironmentSchema,
  connectorCheckUnsafeInputSchema,
  connectorCheckUnknownConnectorSchema,
  connectorCheckUnknownEnvironmentSchema,
  connectorCheckNoMatchSchema,
  connectorCheckTargetAmbiguousSchema,
  connectorCheckTargetMismatchSchema,
  connectorCheckTargetEnvironmentNotOwnedSchema,
  connectorCheckTargetEnvironmentNotUsedSchema,
  connectorCheckTargetUnresolvedDynamicBaseSchema,
  connectorCheckTargetUnavailableSchema,
  connectorCheckRunContextUnavailableSchema,
]);

export const connectorCheckResponseBodySchema = z.union([
  connectorCheckDiagnosticResultSchema,
  connectorCheckTargetAwareDiagnosticResultSchema,
]);

export type ConnectorCheckTargetAwareDiagnosticResult = z.infer<
  typeof connectorCheckTargetAwareDiagnosticResultSchema
>;
export type ConnectorCheckResponseBody = z.infer<
  typeof connectorCheckResponseBodySchema
>;

export const connectorCheckContract = c.router({
  check: {
    method: "POST",
    path: "/api/connectors/diagnostics/check",
    headers: authHeadersSchema,
    body: connectorCheckRequestBodySchema,
    responses: {
      200: connectorCheckResponseBodySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve connector runtime diagnostics",
  },
});

export type ConnectorCheckContract = typeof connectorCheckContract;
