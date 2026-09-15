// Physical storage inventory at #32264. Keep historical fields in this
// operational migration even after the application stops reading them.
export interface Field {
  readonly table: string;
  readonly primaryKey: string;
  readonly column: string;
  readonly jsonKey?: string;
  readonly nestedQueue?: boolean;
  readonly optional?: boolean;
}

export const fields: readonly Field[] = [
  { table: "secrets", primaryKey: "id", column: "encrypted_value" },
  {
    table: "model_provider_account_secrets",
    primaryKey: "id",
    column: "encrypted_value",
  },
  {
    table: "org_custom_connector_oauth_configs",
    primaryKey: "connector_id",
    column: "encrypted_client_secret",
  },
  {
    table: "org_custom_connector_dcr_registrations",
    primaryKey: "id",
    column: "encrypted_client_secret",
  },
  {
    table: "telegram_installations",
    primaryKey: "telegram_bot_id",
    column: "encrypted_bot_token",
  },
  {
    table: "workflow_webhook_automations",
    primaryKey: "automation_id",
    column: "encrypted_token",
  },
  {
    table: "workflow_webhook_automations",
    primaryKey: "automation_id",
    column: "encrypted_secret",
  },
  {
    table: "agent_run_callbacks",
    primaryKey: "id",
    column: "encrypted_secret",
  },
  {
    table: "feishu_org_installations",
    primaryKey: "id",
    column: "encrypted_app_secret",
  },
  {
    table: "feishu_org_installations",
    primaryKey: "id",
    column: "encrypted_verification_token",
  },
  {
    table: "feishu_org_installations",
    primaryKey: "id",
    column: "encrypted_encrypt_key",
  },
  {
    table: "feishu_org_installations",
    primaryKey: "id",
    column: "encrypted_tenant_access_token",
  },
  {
    table: "github_installations",
    primaryKey: "id",
    column: "encrypted_access_token",
  },
  {
    table: "notion_webhook_secrets",
    primaryKey: "id",
    column: "encrypted_verification_token",
  },
  {
    table: "slack_org_installations",
    primaryKey: "slack_workspace_id",
    column: "encrypted_bot_token",
  },
  {
    table: "connector_external_code_sessions",
    primaryKey: "id",
    column: "encrypted_provider_state",
  },
  {
    table: "model_provider_auth_sessions",
    primaryKey: "id",
    column: "encrypted_provider_state",
  },
  {
    table: "connector_oauth_device_authorization_sessions",
    primaryKey: "id",
    column: "encrypted_provider_state",
  },
  {
    table: "ssh_connection_credentials",
    primaryKey: "connection_id",
    column: "encrypted_private_key",
  },
  {
    table: "ssh_connection_credentials",
    primaryKey: "connection_id",
    column: "encrypted_passphrase",
  },
  {
    table: "browser_session_tab_snapshots",
    primaryKey: "chat_thread_id",
    column: "encrypted_tab_urls",
  },
  {
    table: "runner_job_queue",
    primaryKey: "run_id",
    column: "execution_context",
    jsonKey: "encryptedSecrets",
  },
  {
    table: "agent_run_queue",
    primaryKey: "run_id",
    column: "encrypted_params",
    nestedQueue: true,
  },
  {
    table: "org_custom_connector_secrets",
    primaryKey: "id",
    column: "encrypted_value",
    optional: true,
  },
  {
    table: "org_custom_connector_values",
    primaryKey: "id",
    column: "encrypted_value",
    optional: true,
  },
];

// Recovery covers retained snapshots from before the SSH credential migration
// and databases after it. Keep the original migration manifest above unchanged.
// Both tables must be inspected when present; the recovery entry point requires
// at least one. Retire this operational compatibility with #32264 recovery work.
export const recoveryFields: readonly Field[] = [
  ...fields.map((field) => {
    return field.table === "ssh_connection_credentials"
      ? { ...field, optional: true }
      : field;
  }),
  {
    table: "ssh_credentials",
    primaryKey: "id",
    column: "encrypted_private_key",
    optional: true,
  },
  {
    table: "ssh_credentials",
    primaryKey: "id",
    column: "encrypted_passphrase",
    optional: true,
  },
  {
    table: "ssh_credentials",
    primaryKey: "id",
    column: "encrypted_password",
    optional: true,
  },
];

export function fieldName(field: Field): string {
  return `${field.table}.${field.column}${field.jsonKey ? `.${field.jsonKey}` : ""}`;
}
