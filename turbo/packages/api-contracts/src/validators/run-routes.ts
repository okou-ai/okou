import {
  array,
  boolean,
  literal,
  object,
  record,
  string,
  union,
  type infer as zInfer,
} from "zod";
import {
  executionFirewallBuiltinEntrySchema,
  executionFirewallInlineEntrySchema,
  networkPoliciesSchema,
} from "@okouai/connectors/firewall-contracts";

/**
 * Run context snapshot — launch-time execution context for debugging.
 * Environment secret values are redacted. Firewall auth retains the prepared
 * execution templates, including secret references, but never resolves them.
 * Dynamic fields (environment, firewalls, storageMounts) are stored in Axiom.
 * Static fields (prompt, vars, secretNames) are merged from agent_runs at query time.
 */
export const runContextStorageMountSchema = object({
  name: string(),
  version: string(),
  mountPath: string(),
  writeback: boolean(),
});

const runContextSanitizedFirewallSchema = object({
  name: string(),
  apis: array(
    object({
      base: string(),
      permissions: array(
        object({
          name: string(),
          description: string().optional(),
          rules: array(string()),
        }),
      ).optional(),
    }),
  ),
});

// Keep name/apis at the top level so the previous web client can parse a new
// inline response through runContextSanitizedFirewallSchema during rollout.
const runContextExecutionInlineFirewallSchema =
  executionFirewallInlineEntrySchema.shape.firewall.extend({
    kind: literal("inline"),
    customConnectorId:
      executionFirewallInlineEntrySchema.shape.customConnectorId,
    sourceId: executionFirewallInlineEntrySchema.shape.sourceId,
  });

const runContextFirewallSchema = union([
  executionFirewallBuiltinEntrySchema,
  runContextExecutionInlineFirewallSchema,
  runContextSanitizedFirewallSchema,
]);

export const runContextResponseSchema = object({
  prompt: string(),
  appendSystemPrompt: string().nullable(),
  runId: string(),
  sessionId: string().nullable(),
  cliAgentType: string().optional(),
  secretNames: array(string()),
  vars: record(string(), string()).nullable(),
  environment: record(string(), string()),
  firewalls: array(runContextFirewallSchema),
  networkPolicies: networkPoliciesSchema.nullable(),
  storageMounts: array(runContextStorageMountSchema),
  featureFlags: record(string(), boolean()).nullable(),
});

export type RunContextStorageMount = zInfer<
  typeof runContextStorageMountSchema
>;
