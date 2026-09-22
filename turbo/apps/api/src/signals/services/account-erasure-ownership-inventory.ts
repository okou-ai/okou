import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { schema } from "@okouai/db";
import * as agentRunCallbackSchema from "@okouai/db/schema/agent-run-callback";
import * as agentVncAccessSchema from "@okouai/db/schema/agent-vnc-access";
import * as agentphoneConnectionCodeSchema from "@okouai/db/schema/agentphone-connection-code";
import * as archivedTaskRunsSchema from "@okouai/db/schema/archived-task-runs";
import * as creditExpiresRecordSchema from "@okouai/db/schema/credit-expires-record";
import * as emailOutboxSchema from "@okouai/db/schema/email-outbox";
import * as imageArtifactEditSnapshotSchema from "@okouai/db/schema/image-artifact-edit-snapshot";
import * as morningBriefCollectionOccurrenceSchema from "@okouai/db/schema/morning-brief-collection-occurrence";
import * as morningBriefDeliverySchema from "@okouai/db/schema/morning-brief-delivery";
import * as morningBriefEnrollmentSchema from "@okouai/db/schema/morning-brief-enrollment";
import * as morningBriefGenerationSchema from "@okouai/db/schema/morning-brief-generation";
import * as morningBriefInstalledPreferenceSchema from "@okouai/db/schema/morning-brief-installed-preference";
import * as morningBriefNativeScheduleSchema from "@okouai/db/schema/morning-brief-native-schedule";
import * as morningBriefScheduleClaimSchema from "@okouai/db/schema/morning-brief-schedule-claim";
import * as officialAutomationResultEmailClaimSchema from "@okouai/db/schema/official-automation-result-email-claim";
import * as orgPromoRedemptionSchema from "@okouai/db/schema/org-promo-redemption";
import * as piMemoryStage1ScheduleSchema from "@okouai/db/schema/pi-memory-stage1-schedule";
import * as pushSubscriptionSchema from "@okouai/db/schema/push-subscription";
import * as sshConnectionObservationSchema from "@okouai/db/schema/ssh-connection-observation";
import * as userConnectorSchema from "@okouai/db/schema/user-connector";
import * as userCustomConnectorSchema from "@okouai/db/schema/user-custom-connector";

/** Schema modules the `@okouai/db` barrel does not re-export.
 *
 * That barrel is a hand-maintained spread, so it is not a complete view of the
 * database: 26 tables, 18 of them account-owned, are declared with `pgTable`
 * and never spread into it. Enumerating only the barrel would let the guard
 * report full coverage over 90% of the schema, which is the defect it exists
 * to prevent. The suite's migration-ledger case is what keeps this list honest:
 * a table created outside both the barrel and this list fails there.
 */
const UNBARRELLED_SCHEMA_MODULES = [
  agentRunCallbackSchema,
  agentVncAccessSchema,
  agentphoneConnectionCodeSchema,
  archivedTaskRunsSchema,
  creditExpiresRecordSchema,
  emailOutboxSchema,
  imageArtifactEditSnapshotSchema,
  morningBriefCollectionOccurrenceSchema,
  morningBriefDeliverySchema,
  morningBriefEnrollmentSchema,
  morningBriefGenerationSchema,
  morningBriefInstalledPreferenceSchema,
  morningBriefNativeScheduleSchema,
  morningBriefScheduleClaimSchema,
  officialAutomationResultEmailClaimSchema,
  orgPromoRedemptionSchema,
  piMemoryStage1ScheduleSchema,
  pushSubscriptionSchema,
  sshConnectionObservationSchema,
  userConnectorSchema,
  userCustomConnectorSchema,
] as const;

/** Columns whose value is an Okou account identity, or a link row owned by one.
 *
 * Membership is a judgement about the value, not about the column name. A
 * provider-side identity (`github_user_id`, `telegram_user_id`, `bot_user_id`),
 * a display name (`username`, `sender_username`) and an unrelated noun that
 * happens to contain `user` (`draft_user_message`, `user_code`) are not account
 * identities and are deliberately absent. `subject` is an account identity only
 * on the stable-context tables, so it is declared there rather than here.
 */
const ACCOUNT_OWNERSHIP_COLUMNS = [
  "user_id",
  "owner",
  "owner_user_id",
  "author_user_id",
  "created_by",
  "created_by_user_id",
  "updated_by_user_id",
  "actor_user_id",
  "beneficiary_user_id",
  "invitee_user_id",
  "installed_by_user_id",
  "accepted_user_id",
  "inviter_user_id",
  "user_link_id",
  "agentphone_user_link_id",
  "official_user_link_id",
  "telegram_user_link_id",
  "telegram_official_user_link_id",
  "sender_user_id",
  "from_user_id",
] as const;

/** How account erasure treats one table.
 *
 * - `user_root`: rows belong to one account and erasure deletes them by the
 *   declared ownership columns. Ownership is the account that owns the row,
 *   not the agent or organization it hangs under, so a thread the deleted
 *   account created inside somebody else's Agent is still a root here.
 * - `user_descendant`: rows carry no account identity and are removed with the
 *   named roots, by foreign-key cascade or by a root's own deletion. Several
 *   roots can reach the same table — `email_outbox` rows arrive from a run, a
 *   workflow automation or a Morning Brief delivery — and a collector owes a
 *   sweep from every one of them, so the list is plural.
 * - `billing_preserved`: rows are platform billing records. Erasure keeps them
 *   and the minimum identifiers that reconcile them.
 * - `organization_owned`: rows belong to a surviving organization. Erasure
 *   removes only the deleted account's personal association columns.
 * - `not_account_scoped`: rows hold no account data — control planes, provider
 *   catalogues, shared content-addressed storage and runtime caches.
 */
export type AccountOwnershipEntry =
  | { readonly coverage: "user_root"; readonly ownership: readonly string[] }
  | {
      readonly coverage: "user_descendant";
      readonly parents: readonly string[];
    }
  | {
      readonly coverage: "billing_preserved";
      readonly ownership: readonly string[];
    }
  | {
      readonly coverage: "organization_owned";
      readonly association: readonly string[];
    }
  | { readonly coverage: "not_account_scoped" };

/** Every table in the application schema, with the erasure treatment it is
 * covered by. A table missing from this record fails the coverage guard: the
 * September 12 deletion left data behind because ownership coverage was
 * incomplete and a small human review did not notice the gap.
 */
export const ACCOUNT_OWNERSHIP_INVENTORY: Readonly<
  Record<string, AccountOwnershipEntry>
> = {
  account_erasure_ingress: { coverage: "not_account_scoped" },
  account_erasure_jobs: { coverage: "not_account_scoped" },
  account_erasure_pages: { coverage: "not_account_scoped" },
  account_erasure_replay: { coverage: "not_account_scoped" },
  account_erasure_selector_dependencies: { coverage: "not_account_scoped" },
  account_erasure_sinks: { coverage: "not_account_scoped" },
  account_erasure_work: { coverage: "not_account_scoped" },
  active_input_deliveries: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  active_input_delivery_items: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  agent_drafts: { coverage: "user_root", ownership: ["user_id"] },
  agent_run_callbacks: { coverage: "user_descendant", parents: ["agent_runs"] },
  agent_run_connector_diagnostic_registrations: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  agent_run_queue: { coverage: "user_root", ownership: ["user_id"] },
  agent_runs: { coverage: "user_root", ownership: ["user_id"] },
  agent_sessions: { coverage: "user_root", ownership: ["user_id"] },
  agent_ssh_access: { coverage: "user_root", ownership: ["user_id"] },
  agent_vnc_access: { coverage: "user_root", ownership: ["user_id"] },
  agentphone_chat_thread_routes: {
    coverage: "user_root",
    ownership: ["agentphone_user_link_id"],
  },
  agentphone_connection_codes: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  agentphone_messages: {
    coverage: "user_root",
    ownership: ["agentphone_user_link_id"],
  },
  agentphone_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  agentphone_user_links: { coverage: "user_root", ownership: ["user_id"] },
  agentphone_verification_send_cooldowns: { coverage: "not_account_scoped" },
  agents: { coverage: "user_root", ownership: ["owner"] },
  archived_task_runs: { coverage: "user_root", ownership: ["user_id"] },
  artifact_catalog_pending_files: {
    coverage: "user_root",
    ownership: ["author_user_id"],
  },
  artifact_shares: { coverage: "user_root", ownership: ["user_id"] },
  artifacts: { coverage: "user_root", ownership: ["author_user_id"] },
  background_jobs: { coverage: "user_root", ownership: ["user_id"] },
  banking_access_audit_events: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  banking_accounts: { coverage: "user_root", ownership: ["user_id"] },
  banking_agent_enablements: { coverage: "user_root", ownership: ["user_id"] },
  banking_connect_events: { coverage: "user_root", ownership: ["user_id"] },
  banking_connect_sessions: { coverage: "user_root", ownership: ["user_id"] },
  banking_connections: { coverage: "user_root", ownership: ["user_id"] },
  billing_attribution_backfill: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  billing_run_attribution: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  blobs: { coverage: "not_account_scoped" },
  browser_authorization_requests: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  browser_profiles: { coverage: "user_root", ownership: ["user_id"] },
  browser_session_instances: {
    coverage: "user_descendant",
    parents: ["browser_sessions"],
  },
  browser_session_resize_states: {
    coverage: "user_descendant",
    parents: ["browser_sessions"],
  },
  browser_session_screenshot_deletions: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  browser_session_screenshots: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  browser_session_tab_snapshots: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  browser_sessions: { coverage: "user_root", ownership: ["user_id"] },
  browser_thread_profiles: { coverage: "user_root", ownership: ["user_id"] },
  // Added by #35845 while this change was in review. It cascades from
  // `chat_threads`, but it names its own owner, so it is a root: the account
  // can hold a request under a thread that survives it.
  browser_user_action_requests: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  built_in_generation_jobs: { coverage: "user_root", ownership: ["user_id"] },
  built_in_model_candidate_cooldown: { coverage: "not_account_scoped" },
  built_in_model_keys: { coverage: "not_account_scoped" },
  canonical_asset_deliveries: { coverage: "not_account_scoped" },
  chat_agent_run_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_agentphone_context: {
    coverage: "user_root",
    ownership: ["user_link_id"],
  },
  chat_automation_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_event_search_message_watermarks: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_event_search_messages: { coverage: "user_root", ownership: ["user_id"] },
  chat_event_snapshot_scan_state: { coverage: "not_account_scoped" },
  chat_event_snapshots: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_events: { coverage: "user_descendant", parents: ["chat_threads"] },
  chat_feishu_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_github_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_output_materializations: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  chat_slack_context: { coverage: "user_root", ownership: ["sender_user_id"] },
  chat_teams_context: { coverage: "user_root", ownership: ["sender_user_id"] },
  chat_telegram_context: {
    coverage: "user_root",
    ownership: ["user_link_id", "sender_user_id"],
  },
  chat_thread_connector_selections: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_thread_event_sequences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  chat_thread_events: { coverage: "user_root", ownership: ["user_id"] },
  chat_thread_snapshots: { coverage: "user_root", ownership: ["user_id"] },
  chat_threads: { coverage: "user_root", ownership: ["user_id"] },
  checkpoints: { coverage: "user_descendant", parents: ["agent_runs"] },
  cli_tokens: { coverage: "user_root", ownership: ["user_id"] },
  cloudflare_access_configs: { coverage: "user_root", ownership: ["user_id"] },
  compose_jobs: { coverage: "user_root", ownership: ["user_id"] },
  computer_use_authorization_requests: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  computer_use_command_audit_events: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  computer_use_commands: { coverage: "user_root", ownership: ["user_id"] },
  computer_use_hosts: { coverage: "user_root", ownership: ["user_id"] },
  connector_account_oauth_bindings: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  connector_catalog_active_snapshot: { coverage: "not_account_scoped" },
  connector_catalog_compatibility_evaluation: {
    coverage: "not_account_scoped",
  },
  connector_catalog_runtime_projection_sets: { coverage: "not_account_scoped" },
  connector_catalog_runtime_projections: { coverage: "not_account_scoped" },
  connector_catalog_sync_state: { coverage: "not_account_scoped" },
  connector_dcr_registrations: {
    coverage: "organization_owned",
    association: [],
  },
  connector_external_code_sessions: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  connector_oauth_completions: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  connector_oauth_device_authorization_sessions: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  connector_oauth_states: { coverage: "user_root", ownership: ["user_id"] },
  connectors: { coverage: "user_root", ownership: ["user_id"] },
  conversations: { coverage: "user_descendant", parents: ["agent_runs"] },
  credit_expires_record: { coverage: "billing_preserved", ownership: [] },
  custom_connector_account_oauth_bindings: {
    coverage: "user_descendant",
    parents: ["connectors"],
  },
  desktop_auth_handoff_codes: { coverage: "user_root", ownership: ["user_id"] },
  device_codes: { coverage: "user_root", ownership: ["user_id"] },
  email_outbox: {
    coverage: "user_descendant",
    parents: ["agent_runs", "workflow_automations", "morning_brief_deliveries"],
  },
  email_suppressions: { coverage: "not_account_scoped" },
  export_jobs: { coverage: "user_root", ownership: ["user_id"] },
  feishu_chat_ingress: {
    coverage: "user_descendant",
    parents: ["feishu_org_connections"],
  },
  feishu_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  feishu_org_connections: { coverage: "user_root", ownership: ["user_id"] },
  feishu_org_events: {
    coverage: "user_descendant",
    parents: ["feishu_org_connections"],
  },
  feishu_org_installations: {
    coverage: "organization_owned",
    association: ["owner_user_id"],
  },
  feishu_platform_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  feishu_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  get_started_claims: {
    coverage: "user_root",
    ownership: ["actor_user_id", "beneficiary_user_id", "invitee_user_id"],
  },
  github_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  github_installations: { coverage: "organization_owned", association: [] },
  github_user_links: { coverage: "user_root", ownership: ["user_id"] },
  gmail_processed_events: {
    coverage: "user_descendant",
    parents: ["gmail_watch_states"],
  },
  gmail_watch_states: { coverage: "user_root", ownership: ["user_id"] },
  google_calendar_event_snapshots: {
    coverage: "user_descendant",
    parents: ["google_calendar_watch_states"],
  },
  google_calendar_processed_events: {
    coverage: "user_descendant",
    parents: ["google_calendar_watch_states"],
  },
  google_calendar_watch_states: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  google_forms_automation_cursors: {
    coverage: "user_descendant",
    parents: ["google_forms_watch_states"],
  },
  google_forms_processed_events: {
    coverage: "user_descendant",
    parents: ["google_forms_watch_states"],
  },
  google_forms_watch_states: { coverage: "user_root", ownership: ["user_id"] },
  google_workspace_event_subscription_states: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  google_workspace_processed_events: {
    coverage: "user_descendant",
    parents: ["google_workspace_event_subscription_states"],
  },
  hosted_deployments: { coverage: "user_root", ownership: ["user_id"] },
  hosted_sites: { coverage: "user_root", ownership: ["user_id"] },
  image_artifact_edit_snapshots: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  image_artifacts: {
    coverage: "user_descendant",
    parents: ["built_in_generation_jobs"],
  },
  mail_drafts: { coverage: "user_descendant", parents: ["chat_threads"] },
  memory_summary_projections: { coverage: "user_root", ownership: ["user_id"] },
  model_provider_account_secrets: {
    coverage: "user_descendant",
    parents: ["model_provider_accounts"],
  },
  model_provider_accounts: { coverage: "user_root", ownership: ["user_id"] },
  model_provider_auth_sessions: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  model_provider_connections: {
    coverage: "organization_owned",
    association: [],
  },
  model_provider_surfaces: { coverage: "organization_owned", association: [] },
  model_providers: { coverage: "user_root", ownership: ["user_id"] },
  morning_brief_collection_occurrences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  morning_brief_deliveries: { coverage: "user_root", ownership: ["user_id"] },
  morning_brief_enrollments: { coverage: "user_root", ownership: ["user_id"] },
  morning_brief_generations: { coverage: "user_root", ownership: ["user_id"] },
  morning_brief_installed_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  morning_brief_native_occurrences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  morning_brief_native_schedules: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  morning_brief_platform_generation_receipts: {
    coverage: "user_descendant",
    parents: ["morning_brief_generations"],
  },
  morning_brief_rollout: { coverage: "not_account_scoped" },
  morning_brief_schedule_claims: {
    coverage: "user_root",
    ownership: ["owner_user_id"],
  },
  notion_webhook_events: { coverage: "not_account_scoped" },
  notion_webhook_secrets: { coverage: "not_account_scoped" },
  notion_workflow_pending_events: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  official_automation_result_email_claims: {
    coverage: "user_descendant",
    parents: ["workflow_automations", "agent_runs"],
  },
  official_workflow_automation_identities: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  official_workflow_catalog_releases: { coverage: "not_account_scoped" },
  official_workflow_catalog_state: { coverage: "not_account_scoped" },
  official_workflow_definition_revisions: {
    coverage: "user_descendant",
    parents: ["storages"],
  },
  official_workflow_reconciliation_work: { coverage: "not_account_scoped" },
  org_cache: { coverage: "organization_owned", association: ["created_by"] },
  org_concurrency_entitlements: {
    coverage: "billing_preserved",
    ownership: [],
  },
  org_concurrency_subscriptions: {
    coverage: "billing_preserved",
    ownership: [],
  },
  org_custom_connector_dcr_registrations: {
    coverage: "organization_owned",
    association: [],
  },
  org_custom_connector_oauth_configs: {
    coverage: "organization_owned",
    association: [],
  },
  org_custom_connectors: {
    coverage: "organization_owned",
    association: ["created_by"],
  },
  org_members_cache: {
    coverage: "organization_owned",
    association: ["user_id"],
  },
  org_members_metadata: {
    coverage: "organization_owned",
    association: ["user_id"],
  },
  org_metadata: { coverage: "organization_owned", association: [] },
  org_model_policies: {
    coverage: "organization_owned",
    association: ["created_by_user_id", "updated_by_user_id"],
  },
  org_plan_entitlements: { coverage: "organization_owned", association: [] },
  org_promo_redemption: { coverage: "billing_preserved", ownership: [] },
  org_usage_allowance_entitlements: {
    coverage: "billing_preserved",
    ownership: [],
  },
  org_usage_allowance_windows: { coverage: "billing_preserved", ownership: [] },
  pi_memory_phase2_checkpoints: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_memory_phase2_jobs: { coverage: "user_root", ownership: ["user_id"] },
  pi_memory_publication_provenance: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_memory_stage1_candidates: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_memory_stage1_days: { coverage: "user_root", ownership: ["user_id"] },
  pi_memory_stage1_selections: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_memory_stage1_watermarks: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_resource_snapshots: { coverage: "not_account_scoped" },
  pi_resource_version_indexes: {
    coverage: "user_descendant",
    parents: ["storages"],
  },
  pi_stable_context_artifact_resources: {
    coverage: "user_descendant",
    parents: ["storages"],
  },
  pi_stable_context_artifacts: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  pi_stable_context_erasure_fences: { coverage: "not_account_scoped" },
  pi_stable_context_generations: {
    coverage: "user_root",
    ownership: ["subject"],
  },
  pi_stable_context_heads: { coverage: "user_root", ownership: ["user_id"] },
  pi_stable_context_publications: {
    coverage: "user_root",
    ownership: ["subject"],
  },
  presentation_artifacts: {
    coverage: "user_descendant",
    parents: ["built_in_generation_jobs"],
  },
  presentation_templates: {
    coverage: "user_root",
    ownership: ["owner_user_id", "created_by"],
  },
  private_hosted_deployments: { coverage: "user_root", ownership: ["user_id"] },
  push_subscriptions: { coverage: "user_root", ownership: ["user_id"] },
  run_activity_snapshots: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  run_built_in_admissions: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  run_model_catalog: { coverage: "not_account_scoped" },
  run_output_legacy_pi_events: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  run_output_memory_citations: {
    coverage: "user_descendant",
    parents: ["agent_runs"],
  },
  run_uploaded_files: { coverage: "user_root", ownership: ["user_id"] },
  runner_job_queue: { coverage: "user_descendant", parents: ["agent_runs"] },
  runner_state: { coverage: "not_account_scoped" },
  sandbox_telemetry: { coverage: "user_descendant", parents: ["agent_runs"] },
  secrets: { coverage: "user_root", ownership: ["user_id"] },
  shared_threads: { coverage: "user_root", ownership: ["user_id"] },
  skills: { coverage: "user_descendant", parents: ["storages"] },
  slack_chat_ingress: {
    coverage: "user_descendant",
    parents: ["slack_chat_thread_routes"],
  },
  slack_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  slack_org_connections: { coverage: "user_root", ownership: ["user_id"] },
  slack_org_installations: {
    coverage: "organization_owned",
    association: ["installed_by_user_id"],
  },
  slack_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  social_data_jobs: { coverage: "user_root", ownership: ["user_id"] },
  socialkit_download_jobs: { coverage: "user_root", ownership: ["user_id"] },
  ssh_connection_observations: {
    coverage: "user_descendant",
    parents: ["ssh_connections"],
  },
  ssh_connections: { coverage: "user_root", ownership: ["user_id"] },
  ssh_credentials: { coverage: "user_root", ownership: ["user_id"] },
  storage_version_lineage: {
    coverage: "user_descendant",
    parents: ["storages"],
  },
  storage_versions: { coverage: "user_root", ownership: ["created_by"] },
  storages: { coverage: "user_root", ownership: ["user_id"] },
  stripe_workflow_automation_health: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  stripe_workflow_deliveries: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  system_storage_presigned_url_cache: { coverage: "not_account_scoped" },
  teams_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  teams_org_connections: { coverage: "user_root", ownership: ["user_id"] },
  teams_org_installations: {
    coverage: "organization_owned",
    association: ["installed_by_user_id"],
  },
  teams_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  telegram_chat_thread_routes: {
    coverage: "user_root",
    ownership: ["telegram_user_link_id", "telegram_official_user_link_id"],
  },
  telegram_installations: {
    coverage: "organization_owned",
    association: ["owner_user_id"],
  },
  telegram_messages: {
    coverage: "user_root",
    ownership: ["official_user_link_id", "from_user_id"],
  },
  telegram_official_user_links: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  telegram_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  telegram_user_links: { coverage: "user_root", ownership: ["user_id"] },
  usage_allowance_allocations: { coverage: "billing_preserved", ownership: [] },
  usage_event: { coverage: "billing_preserved", ownership: ["user_id"] },
  usage_event_hourly_rollup: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  usage_pack_allocation_changes: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  usage_pack_allocations: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  usage_pack_credit_grants: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  usage_pack_credit_refunds: {
    coverage: "billing_preserved",
    ownership: ["user_id"],
  },
  usage_pack_invitation_purchases: {
    coverage: "billing_preserved",
    ownership: ["accepted_user_id", "inviter_user_id"],
  },
  usage_pack_invoice_fulfillments: {
    coverage: "billing_preserved",
    ownership: [],
  },
  usage_pack_pending_snapshot_guards: { coverage: "not_account_scoped" },
  usage_pack_subscription_changes: {
    coverage: "billing_preserved",
    ownership: [],
  },
  usage_pack_subscription_migration_selections: {
    coverage: "billing_preserved",
    ownership: ["user_id", "inviter_user_id"],
  },
  usage_pack_subscription_migrations: {
    coverage: "billing_preserved",
    ownership: [],
  },
  usage_pack_subscriptions: { coverage: "billing_preserved", ownership: [] },
  usage_pricing: { coverage: "billing_preserved", ownership: [] },
  user_artifact_favorites: { coverage: "user_root", ownership: ["user_id"] },
  user_behavior_count: { coverage: "user_root", ownership: ["user_id"] },
  user_cache: { coverage: "user_root", ownership: ["user_id"] },
  user_connectors: { coverage: "user_root", ownership: ["user_id"] },
  user_custom_connectors: { coverage: "user_root", ownership: ["user_id"] },
  user_disabled_paid_tools: { coverage: "user_root", ownership: ["user_id"] },
  user_export_entries: {
    coverage: "user_descendant",
    parents: ["export_jobs"],
  },
  user_export_parts: { coverage: "user_descendant", parents: ["export_jobs"] },
  user_feature_switches: { coverage: "user_root", ownership: ["user_id"] },
  user_permission_grants: { coverage: "user_root", ownership: ["user_id"] },
  user_templates: {
    coverage: "user_root",
    ownership: ["owner_user_id", "created_by"],
  },
  users: { coverage: "user_root", ownership: ["id"] },
  variables: { coverage: "user_root", ownership: ["user_id"] },
  video_artifacts: {
    coverage: "user_descendant",
    parents: ["built_in_generation_jobs"],
  },
  vnc_connections: { coverage: "user_root", ownership: ["user_id"] },
  vnc_credentials: { coverage: "user_root", ownership: ["user_id"] },
  workflow_automations: { coverage: "user_root", ownership: ["owner_user_id"] },
  workflow_github_processed_events: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  workflow_user_automation_threads: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  workflow_webhook_automations: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  workflow_webhook_deliveries: {
    coverage: "user_descendant",
    parents: ["workflow_automations"],
  },
  workflows: {
    coverage: "user_root",
    ownership: ["owner_user_id", "created_by"],
  },
  x_resource_reads: { coverage: "user_descendant", parents: ["agent_runs"] },
};

export interface OwnershipTable {
  readonly name: string;
  readonly columns: readonly string[];
}

/** The tables erasure must delete, with the columns that carry the account. */
export interface UserOwnedRoot {
  readonly table: string;
  readonly ownership: readonly string[];
}

function fail(code: string, table: string): never {
  throw new Error(`account_erasure_inventory:${code}:${table}`);
}

function declaredColumns(entry: AccountOwnershipEntry): readonly string[] {
  if (
    entry.coverage === "user_root" ||
    entry.coverage === "billing_preserved"
  ) {
    return entry.ownership;
  }
  return entry.coverage === "organization_owned" ? entry.association : [];
}

/** Fails when the schema and the inventory disagree in any direction.
 *
 * A new table is uncovered until it is classified, a renamed ownership column
 * stops silently voiding a root's coverage, and an inventory entry cannot
 * outlive the table it describes.
 */
export function assertOwnershipInventoryCoverage(
  tables: readonly OwnershipTable[],
): void {
  const present = new Set<string>();
  for (const table of tables) {
    const entry = ACCOUNT_OWNERSHIP_INVENTORY[table.name];
    if (!entry) {
      fail("uncovered_table", table.name);
    }
    present.add(table.name);
    const columns = new Set(table.columns);
    for (const column of declaredColumns(entry)) {
      if (!columns.has(column)) {
        fail("ownership_column_missing", `${table.name}.${column}`);
      }
    }
    const carried = ACCOUNT_OWNERSHIP_COLUMNS.filter((column) => {
      return columns.has(column);
    });
    const [first] = carried;
    if (first !== undefined) {
      if (entry.coverage === "not_account_scoped") {
        fail("unclassified_ownership", `${table.name}.${first}`);
      }
      if (entry.coverage === "user_descendant") {
        fail("root_declared_as_descendant", `${table.name}.${first}`);
      }
      for (const column of carried) {
        if (!declaredColumns(entry).includes(column)) {
          fail("undeclared_ownership_column", `${table.name}.${column}`);
        }
      }
    }
    if (entry.coverage === "user_root" && entry.ownership.length === 0) {
      fail("ownership_undeclared", table.name);
    }
  }
  for (const [name, entry] of Object.entries(ACCOUNT_OWNERSHIP_INVENTORY)) {
    if (!present.has(name)) {
      fail("unknown_table", name);
    }
    if (entry.coverage !== "user_descendant") {
      continue;
    }
    if (entry.parents.length === 0) {
      fail("descendant_unanchored", name);
    }
    for (const parent of entry.parents) {
      if (ACCOUNT_OWNERSHIP_INVENTORY[parent]?.coverage !== "user_root") {
        fail("unknown_parent", `${name}->${parent}`);
      }
    }
  }
}

/** The application schema as the guard sees it: the barrel plus the modules it
 * omits. The suite's migration-ledger case owns the completeness of this set.
 */
export function applicationOwnershipTables(): OwnershipTable[] {
  const tables: OwnershipTable[] = [];
  const sources: readonly Record<string, unknown>[] = [
    schema,
    ...UNBARRELLED_SCHEMA_MODULES,
  ];
  for (const source of sources) {
    for (const value of Object.values(source)) {
      if (!is(value, PgTable)) {
        continue;
      }
      const config = getTableConfig(value);
      tables.push({
        name: config.name,
        columns: config.columns.map((column) => {
          return column.name;
        }),
      });
    }
  }
  return tables;
}

/** The roots an account-owned relational erasure must delete, in a stable
 * order. Callers must treat an added root as work, not as an optional extra.
 */
export function userOwnedErasureRoots(): UserOwnedRoot[] {
  assertOwnershipInventoryCoverage(applicationOwnershipTables());
  return Object.entries(ACCOUNT_OWNERSHIP_INVENTORY)
    .flatMap(([table, entry]) => {
      return entry.coverage === "user_root"
        ? [{ table, ownership: entry.ownership }]
        : [];
    })
    .sort((left, right) => {
      return left.table.localeCompare(right.table);
    });
}
