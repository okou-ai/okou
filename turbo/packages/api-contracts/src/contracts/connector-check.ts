import {
  array,
  discriminatedUnion,
  literal,
  object,
  string,
  union,
  enum as zEnum,
  type RefinementCtx,
  type infer as zInfer,
} from "zod";

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

const boundedNameSchema = string().min(1).max(255);
const connectorCheckAwsQuerySelectorSchema = object({
  key: string().min(1).max(128).regex(AWS_QUERY_KEY_RE),
  value: string()
    .max(256)
    .refine((value) => {
      return value === "*" || AWS_QUERY_VALUE_RE.test(value);
    })
    .optional(),
}).strict();

const connectorCheckAwsSelectorsBaseSchema = object({
  sigv4Service: string().min(1).max(128).regex(AWS_PREDICATE_VALUE_RE),
  action: string().min(1).max(256).regex(AWS_PREDICATE_VALUE_RE).optional(),
  target: string().min(1).max(256).regex(AWS_PREDICATE_VALUE_RE).optional(),
  query: array(connectorCheckAwsQuerySelectorSchema).max(32).optional(),
  headerNames: array(zEnum(AWS_S3_PERMISSION_HEADER_NAMES))
    .max(AWS_S3_PERMISSION_HEADER_NAMES.length)
    .optional(),
}).strict();

type ConnectorCheckAwsSelectors = zInfer<
  typeof connectorCheckAwsSelectorsBaseSchema
>;
type ConnectorCheckAwsQuerySelector = zInfer<
  typeof connectorCheckAwsQuerySelectorSchema
>;

function validateAwsQuerySelectors(
  selectors: readonly ConnectorCheckAwsQuerySelector[],
  ctx: RefinementCtx,
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
  ctx: RefinementCtx,
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
  ctx: RefinementCtx,
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
  ctx: RefinementCtx,
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

const connectorCheckUrlRequestSchema = object({
  mode: literal("url"),
  method: string().min(1).max(16),
  url: string().min(1).max(8192),
  aws: connectorCheckAwsSelectorsSchema.optional(),
  connectorSlug: connectorSlugSchema.optional(),
  environmentName: boundedNameSchema.optional(),
}).strict();

const connectorCheckEnvironmentRequestSchema = object({
  mode: literal("environment"),
  environmentName: boundedNameSchema,
  permission: boundedNameSchema.optional(),
}).strict();

export const connectorCheckRequestSchema = discriminatedUnion("mode", [
  connectorCheckUrlRequestSchema,
  connectorCheckEnvironmentRequestSchema,
]);

export type ConnectorCheckRequest = zInfer<typeof connectorCheckRequestSchema>;

export const connectorCheckTargetAwareUrlRequestSchema = object({
  mode: literal("url"),
  method: string().min(1).max(16),
  url: string().min(1).max(8192),
  aws: connectorCheckAwsSelectorsSchema.optional(),
  environmentName: boundedNameSchema.optional(),
  includeCustomConnectors: literal(true).optional(),
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

export const connectorCheckRequestBodySchema = union([
  connectorCheckUrlRequestSchema,
  connectorCheckTargetAwareUrlRequestSchema,
  connectorCheckEnvironmentRequestSchema,
]);

export type ConnectorCheckTargetAwareUrlRequest = zInfer<
  typeof connectorCheckTargetAwareUrlRequestSchema
>;
export type ConnectorCheckRequestBody = zInfer<
  typeof connectorCheckRequestBodySchema
>;

const connectorCheckIdentitySchema = object({
  target: connectorRuntimeTargetSchema,
  label: string().min(1),
  visibility: zEnum(["available", "unavailable"]),
  credentialResolution: zEnum(["network-boundary", "none"]),
}).strict();

const connectorCheckCandidateSchema = object({
  target: connectorRuntimeTargetSchema,
  label: string().min(1),
}).strict();

const connectorCheckNotScopedRunSchema = object({
  status: literal("not-scoped"),
}).strict();

const connectorCheckConfiguredRunSchema = object({
  status: literal("configured"),
  bases: array(string().min(1)),
}).strict();

const connectorCheckNotConfiguredRunSchema = object({
  status: literal("not-configured"),
}).strict();

const connectorCheckRunSchema = discriminatedUnion("status", [
  connectorCheckNotScopedRunSchema,
  connectorCheckConfiguredRunSchema,
  connectorCheckNotConfiguredRunSchema,
]);

const connectorCheckAllowPolicySchema = object({
  outcome: literal("allow"),
  basis: zEnum(["allow-list", "not-blocked", "no-policy", "unknown-policy"]),
}).strict();

const connectorCheckDenyPolicySchema = object({
  outcome: literal("deny"),
  basis: zEnum(["deny-list", "unknown-policy"]),
}).strict();

const connectorCheckAskPolicySchema = object({
  outcome: literal("ask"),
  basis: zEnum(["ask-list", "unknown-policy"]),
}).strict();

const connectorCheckUnavailablePolicySchema = object({
  outcome: literal("unavailable"),
  basis: zEnum([
    "not-run-scoped",
    "policies-unavailable",
    "connector-not-configured",
  ]),
}).strict();

export const connectorCheckPolicySchema = discriminatedUnion("outcome", [
  connectorCheckAllowPolicySchema,
  connectorCheckDenyPolicySchema,
  connectorCheckAskPolicySchema,
  connectorCheckUnavailablePolicySchema,
]);

export type ConnectorCheckPolicy = zInfer<typeof connectorCheckPolicySchema>;

const connectorCheckMatchedPermissionSchema = object({
  name: string().min(1),
  policy: connectorCheckPolicySchema,
}).strict();

const connectorCheckMatchedPermissionsSchema = object({
  kind: literal("matched"),
  permissions: array(connectorCheckMatchedPermissionSchema).min(1),
}).strict();

const connectorCheckUnknownEndpointSchema = object({
  kind: literal("unknown-endpoint"),
  policy: connectorCheckPolicySchema,
}).strict();

const connectorCheckPermissionResultSchema = discriminatedUnion("kind", [
  connectorCheckMatchedPermissionsSchema,
  connectorCheckUnknownEndpointSchema,
]);

const connectorCheckResolvedUrlSchema = object({
  outcome: literal("resolved"),
  mode: literal("url"),
  connector: connectorCheckIdentitySchema,
  environmentNames: array(boundedNameSchema).nullable(),
  run: connectorCheckRunSchema,
  method: string().min(1).max(16),
  base: string().min(1),
  relativePath: string().min(1),
  permission: connectorCheckPermissionResultSchema,
}).strict();

const connectorCheckResolvedEnvironmentSchema = object({
  outcome: literal("resolved"),
  mode: literal("environment"),
  connector: connectorCheckIdentitySchema,
  environmentName: boundedNameSchema,
  run: connectorCheckRunSchema,
  permission: connectorCheckPolicySchema.nullable(),
}).strict();

const connectorCheckUnsafeInputSchema = object({
  outcome: literal("unsafe-input"),
  reason: zEnum(["invalid-method", "invalid-url", "unsafe-path"]),
}).strict();

const connectorCheckUnknownConnectorSchema = object({
  outcome: literal("unknown-connector"),
}).strict();

const connectorCheckUnknownEnvironmentSchema = object({
  outcome: literal("unknown-environment"),
}).strict();

const connectorCheckNoMatchSchema = object({
  outcome: literal("no-match"),
  scope: zEnum(["run", "catalog"]),
}).strict();

const connectorCheckAmbiguousSchema = object({
  outcome: literal("ambiguous"),
  candidates: array(connectorCheckCandidateSchema).min(2),
}).strict();

const connectorCheckMismatchSchema = object({
  outcome: literal("connector-mismatch"),
  connector: connectorCheckIdentitySchema,
}).strict();

const connectorCheckEnvironmentNotOwnedSchema = object({
  outcome: literal("environment-not-owned"),
  connector: connectorCheckIdentitySchema,
}).strict();

const connectorCheckEnvironmentNotUsedSchema = object({
  outcome: literal("environment-not-used"),
  connector: connectorCheckIdentitySchema,
  environmentNames: array(boundedNameSchema),
}).strict();

const connectorCheckUnresolvedDynamicBaseSchema = object({
  outcome: literal("unresolved-dynamic-base"),
  connector: connectorCheckIdentitySchema,
}).strict();

const connectorCheckRunContextUnavailableSchema = object({
  outcome: literal("run-context-unavailable"),
}).strict();

const connectorCheckTargetUnavailableSchema = object({
  outcome: literal("target-unavailable"),
  target: connectorRuntimeTargetSchema,
  reason: zEnum([
    "not-admitted",
    "connector-unavailable",
    "permission-bundle-unavailable",
    "runtime-configuration-unavailable",
  ]),
}).strict();

export const connectorCheckDiagnosticResultSchema = union([
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
  connectorCheckTargetUnavailableSchema,
  connectorCheckRunContextUnavailableSchema,
]);

export type ConnectorCheckDiagnosticResult = zInfer<
  typeof connectorCheckDiagnosticResultSchema
>;

export const CONNECTOR_CHECK_AWS_CONTEXT_HEADER =
  "x-okou-connector-check-aws-context";
export const CONNECTOR_CHECK_AWS_CONTEXT_INSUFFICIENT = "insufficient";

export const connectorCheckContract = c.router({
  check: {
    method: "POST",
    path: "/api/connectors/diagnostics/check",
    headers: authHeadersSchema,
    body: connectorCheckRequestBodySchema,
    responses: {
      200: connectorCheckDiagnosticResultSchema,
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
