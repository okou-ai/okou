import { z } from "zod";

import { initContract } from "./base";
import { connectorAccountMutationIntentSchema } from "./connector-accounts";

const c = initContract();

const connectorStateSchema = z.object({
  id: z.uuid(),
  storage_version: z.number().int().positive(),
  auth_method: z.string().optional(),
  external_id: z.string().nullable().optional(),
  external_username: z.string().nullable().optional(),
  external_email: z.string().nullable().optional(),
  oauth_scopes: z.string().nullable().optional(),
  oauth_granted_scopes: z.string().nullable().optional(),
  token_expires_at: z.string().nullable().optional(),
});

const feishuMemberConnectionStateSchema = z.object({
  connector_id: z.uuid().nullable(),
  connector_external_id: z.string().nullable(),
  open_id: z.string(),
});

const secretStateSchema = z.object({
  name: z.string(),
  connector_id: z.uuid(),
  encrypted_value: z.string(),
  description: z.string().nullable(),
});

const variableStateSchema = z.object({
  name: z.string(),
  connector_id: z.uuid(),
  value: z.string().optional(),
});

const customOauthStateSchema = z.object({
  storage_version: z.number().int().positive().nullable(),
  context_storage_version: z.number().int().positive().nullable(),
  context_valid: z.boolean().optional(),
  auth_mode: z.enum(["oauth", "automatic"]).optional(),
});

const automaticOauthBindingStateSchema = z.object({
  exists: z.boolean(),
  valid: z.boolean(),
  registration_method: z.enum(["cimd", "dcr"]).nullable(),
  dcr_client_secret_present: z.boolean().optional(),
});

export const testConnectorCredentialStorageStateActionBodySchema =
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("read"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      secret_names: z.array(z.string()),
      variable_names: z.array(z.string()),
    }),
    z.object({
      action: z.literal("read-custom-parent"),
      org_id: z.string(),
      user_id: z.string(),
      custom_connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("read-custom-oauth-state"),
      state: z.string(),
    }),
    z.object({
      action: z.literal("seed-custom-oauth-state-context"),
      state: z.string().min(1),
      org_id: z.string(),
      user_id: z.string(),
      custom_connector_id: z.uuid(),
      storage_version: z.number().int().positive(),
      redirect_uri: z.url(),
      oauth_context: z.record(z.string(), z.unknown()),
    }),
    z.object({
      action: z.literal("seed-automatic-oauth-binding"),
      org_id: z.string(),
      user_id: z.string(),
      custom_connector_id: z.uuid(),
      connector_account_id: z.uuid(),
      issuer: z.string().min(1),
      resource: z.string().min(1),
      resource_metadata_url: z.string().min(1).nullable(),
      token_endpoint: z.string().min(1),
      client_id: z.string().min(1),
      registration: z.discriminatedUnion("method", [
        z.object({
          method: z.literal("cimd"),
          token_endpoint_auth_method: z.literal("none"),
        }),
        z.object({
          method: z.literal("dcr"),
          registration_id: z.uuid(),
          token_endpoint_auth_method: z.enum([
            "none",
            "client_secret_basic",
            "client_secret_post",
          ]),
          encrypted_client_secret: z.string().min(1).nullable(),
        }),
      ]),
    }),
    z.object({
      action: z.literal("read-automatic-oauth-binding"),
      connector_account_id: z.uuid(),
    }),
    z.object({
      action: z.literal("read-oauth-state-account-mutation"),
      state: z.string(),
    }),
    z.object({
      action: z.literal("delete-custom-credential-values"),
      org_id: z.string(),
      user_id: z.string(),
      custom_connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("clear-feishu-connector-ownership"),
      org_id: z.string(),
      installation_id: z.uuid(),
    }),
    z.object({
      action: z.literal("read-feishu-member-connector"),
      org_id: z.string(),
      user_id: z.string(),
      installation_id: z.uuid(),
    }),
    z.object({
      action: z.literal("set-feishu-member-connector-link"),
      user_id: z.string(),
      installation_id: z.uuid(),
      connector_id: z.uuid().nullable(),
    }),
    z.object({
      action: z.literal("seed-owned-secret"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      auth_method: z.string(),
      storage_version: z.number().int().positive(),
      name: z.string(),
      encrypted_value: z.string(),
      description: z.string().nullable(),
    }),
    z.object({
      action: z.literal("seed-connector"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      auth_method: z.string(),
      storage_version: z.number().int().positive(),
    }),
    z.object({
      action: z.literal("seed-custom-runtime-connectors"),
      org_id: z.string(),
      user_id: z.string(),
      agent_id: z.uuid().optional(),
      custom_connectors: z
        .array(
          z.object({
            id: z.uuid(),
            slug: z.string(),
            display_name: z.string(),
            prefix_template: z.string(),
          }),
        )
        .min(1),
    }),
    z.object({
      action: z.literal("set-connector-state"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      storage_version: z.number().int().positive(),
      token_expires_at: z.iso.datetime().nullable().optional(),
    }),
    z.object({
      action: z.literal("set-builtin-oauth-scope-facts"),
      org_id: z.string(),
      user_id: z.string(),
      connector_slug: z.string(),
      connector_id: z.uuid(),
      oauth_scopes: z.array(z.string()),
      oauth_granted_scopes: z.array(z.string()).nullable(),
    }),
    z.object({
      action: z.literal("set-connector-default"),
      org_id: z.string(),
      user_id: z.string(),
      connector_id: z.uuid(),
      is_default: z.boolean(),
    }),
    z.object({
      action: z.literal("set-connector-external-id"),
      org_id: z.string(),
      user_id: z.string(),
      connector_id: z.uuid(),
      external_id: z.string().nullable(),
    }),
    z.object({
      action: z.literal("set-connector-account-state"),
      org_id: z.string(),
      user_id: z.string(),
      connector_id: z.uuid(),
      needs_reconnect: z.boolean(),
      storage_version: z.number().int().positive().optional(),
    }),
    z.object({
      action: z.literal("seed-builtin-thread-selection"),
      chat_thread_id: z.uuid(),
      connector_id: z.uuid(),
      connector_slug: z.string(),
    }),
    z.object({
      action: z.literal("seed-custom-thread-selection"),
      chat_thread_id: z.uuid(),
      connector_id: z.uuid(),
      custom_connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("read-thread-selection"),
      chat_thread_id: z.uuid(),
      connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("set-custom-parent-state"),
      org_id: z.string(),
      user_id: z.string(),
      custom_connector_id: z.uuid(),
      auth_method: z.enum(["none", "manual", "oauth"]),
      storage_version: z.number().int().positive(),
      needs_reconnect: z.boolean().optional(),
    }),
    z.object({
      action: z.literal("set-secret-owner"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      connector_id: z.uuid(),
    }),
    z.object({
      action: z.literal("set-variable-owner"),
      org_id: z.string(),
      user_id: z.string(),
      name: z.string(),
      connector_id: z.uuid(),
    }),
  ]);

export const testConnectorCredentialStorageStateActionResponseSchema = z.object(
  {
    ok: z.literal(true),
    connector: connectorStateSchema.nullable().optional(),
    connector_id: z.uuid().optional(),
    account_mutation: connectorAccountMutationIntentSchema
      .nullable()
      .optional(),
    custom_oauth_state: customOauthStateSchema.nullable().optional(),
    automatic_oauth_binding: automaticOauthBindingStateSchema.optional(),
    feishu_member_connection: feishuMemberConnectionStateSchema
      .nullable()
      .optional(),
    selection_exists: z.boolean().optional(),
    secrets: z.array(secretStateSchema).optional(),
    variables: z.array(variableStateSchema).optional(),
  },
);

export const testConnectorCredentialStorageStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/connector-credential-storage-state/action",
    body: testConnectorCredentialStorageStateActionBodySchema,
    responses: {
      200: testConnectorCredentialStorageStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Mutate and read connector credential storage API test state",
  },
});

export type TestConnectorCredentialStorageStateActionBody = z.infer<
  typeof testConnectorCredentialStorageStateActionBodySchema
>;
export type TestConnectorCredentialStorageStateActionResponse = z.infer<
  typeof testConnectorCredentialStorageStateActionResponseSchema
>;
