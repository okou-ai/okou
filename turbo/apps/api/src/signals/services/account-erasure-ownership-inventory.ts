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
  "source_user_id",
] as const;

/** How account erasure treats one table.
 *
 * - `user_root`: rows belong to one account and erasure deletes them by the
 *   declared ownership columns. Ownership is the account that owns the row,
 *   not the agent or organization it hangs under, so a thread the deleted
 *   account created inside somebody else's Agent is still a root here.
 * - `user_descendant`: rows carry no account identity and are removed with the
 *   named roots, by foreign-key cascade or by a root's own deletion. A
 *   collector owes a sweep from every declared parent, so the list is plural.
 * - `billing_preserved`: rows are platform billing records. Erasure keeps them
 *   and the minimum identifiers that reconcile them.
 * - `organization_owned`: rows belong to a surviving organization. Erasure
 *   removes only the deleted account's personal association columns.
 * - `not_account_scoped`: rows hold no account data — control planes, provider
 *   catalogues, shared content-addressed storage and runtime caches.
 * - `deferred_retention`: account content explicitly excluded from this
 *   deletion request by product decision. This does NOT prove the rows erased;
 *   they remain for a separate, future retention/cleanup policy.
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
  | { readonly coverage: "not_account_scoped" }
  | { readonly coverage: "deferred_retention" };

/** Why a vocabulary column on a table is not that table's sweep key.
 *
 * `provider_identity` — the value is a Slack, Teams or Telegram identity, not
 * an Okou account. Its type is `text`, exactly like a Clerk id, so a sweep
 * comparing the subject against it parses cleanly, matches nothing, and
 * reports the table clean while every row stays. That is worse than an
 * uncovered table, which the guard catches loudly.
 *
 * `covered_by_parent` — the value does reference an account-owned row, but the
 * sweep reaches this table through a different parent, so this column is not
 * the key it deletes by.
 *
 * The catalogue cannot tell a Clerk id from a Slack id: both are `text`. So the
 * distinction can only live in this vocabulary, and it has to be a declaration
 * the guard can check rather than a remark in a comment.
 */
export type NonOwnershipReason = "provider_identity" | "covered_by_parent";

/** One join step from the rows selected so far up to `parent`.
 *
 * `childColumns` name columns on the table below this hop — the descendant
 * itself for the first hop, the previous hop's `parent` afterwards. The two
 * lists are positional pairs, exactly as a catalogue foreign key's are.
 */
export interface DescendantReachHop {
  readonly childColumns: readonly string[];
  readonly parent: string;
  readonly parentColumns: readonly string[];
}

/** How a descendant with no catalogue foreign key to a declared parent is
 * nevertheless reached, and why that join key is the right one.
 *
 * A missing foreign key is usually deliberate: a durable receipt, a retryable
 * cleanup intent or a projection has to outlive the row it came from, so the
 * schema declines the constraint. The column still holds the parent's id. This
 * is the declaration that says so, and `basis` is why — a reach without a
 * reason is a guess about which rows belong to the account.
 *
 * The path may be longer than one hop. A catalogue key that lands on a table
 * which is itself a descendant, rather than on a declared parent, is reachable
 * only by continuing up to the root that names the account.
 */
export interface DescendantReach {
  readonly path: readonly DescendantReachHop[];
  readonly basis: string;
}

/** The longest declared path. Nothing needs more than this today, and a bound
 * keeps a mistaken declaration from generating an unbounded nest of
 * subqueries on a path that ends in a `DELETE`.
 */
const MAX_REACH_HOPS = 4;

/** Explicit sweep selectors for descendants the catalogue cannot join.
 *
 * Every entry is measured against the live schema by the relational plan: the
 * guard below only checks that the declaration is well formed and that the
 * columns exist, and the sweep is what actually uses it.
 */
export const DESCENDANT_REACH: Readonly<
  Record<string, readonly DescendantReach[]>
> = {
  active_input_delivery_items: [
    {
      path: [
        {
          childColumns: ["delivery_id"],
          parent: "active_input_deliveries",
          parentColumns: ["id"],
        },
        {
          childColumns: ["chat_thread_id"],
          parent: "chat_threads",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The catalogue key lands on `active_input_deliveries`, which is a `chat_threads` descendant rather than a declared parent, so the join continues through the delivery row that carries the thread.",
    },
  ],
  browser_session_resize_states: [
    {
      path: [
        {
          childColumns: ["provider_session_id"],
          parent: "browser_session_instances",
          parentColumns: ["provider_session_id"],
        },
        {
          childColumns: ["browser_session_id"],
          parent: "browser_sessions",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The catalogue key lands on `browser_session_instances`, a `browser_sessions` descendant rather than a declared parent. `browser_session_id` is the instance's session reference, and it is nullable for rows written by the previous browser-ID API, so the thread reach below covers the rest.",
    },
    {
      path: [
        {
          childColumns: ["provider_session_id"],
          parent: "browser_session_instances",
          parentColumns: ["provider_session_id"],
        },
        {
          childColumns: ["chat_thread_id"],
          parent: "chat_threads",
          parentColumns: ["id"],
        },
      ],
      basis:
        "`browser_session_instances.chat_thread_id` is a non-null immutable attribution key the schema keeps precisely because provider cleanup outlives either parent, so it reaches every instance including those whose nullable session reference was never written.",
    },
  ],
  browser_session_screenshot_deletions: [
    {
      path: [
        {
          childColumns: ["chat_thread_id"],
          parent: "chat_threads",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The schema deliberately declines a thread foreign key so object cleanup stays retryable after the thread is deleted. The non-null column is still the thread's id.",
    },
  ],
  browser_session_screenshots: [
    {
      path: [
        {
          childColumns: ["chat_thread_id"],
          parent: "chat_threads",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The row deliberately outlives chat-thread deletion so the reconciler can remove the final screenshot object, so no foreign key exists. Its primary key is the thread's id.",
    },
  ],
  chat_event_search_message_watermarks: [
    {
      path: [
        {
          childColumns: ["chat_thread_id"],
          parent: "chat_threads",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The durable search projection does not depend on a `chat_events` row and takes no foreign key, but its primary key is the thread's id.",
    },
  ],
  official_automation_result_email_claims: [
    {
      path: [
        {
          childColumns: ["run_id"],
          parent: "agent_runs",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The dedupe identity deliberately has no foreign keys so a terminal callback stays redrivable after its run, automation and outbox row are gone. `run_id` is non-null and is half of the primary key.",
    },
    {
      path: [
        {
          childColumns: ["workflow_automation_id"],
          parent: "workflow_automations",
          parentColumns: ["id"],
        },
      ],
      basis:
        "`workflow_automation_id` is the other half of the same non-null primary key, so a claim whose run row was already removed is still reached through the automation that produced it.",
    },
  ],
  stripe_workflow_deliveries: [
    {
      path: [
        {
          childColumns: ["automation_id"],
          parent: "workflow_automations",
          parentColumns: ["id"],
        },
      ],
      basis:
        "The column is deliberately not a foreign key so a pending delivery survives automation deletion long enough to record a terminal state. It is non-null and is the automation's id.",
    },
  ],
};

/** A descendant whose persisted data cannot prove a stable account owner.
 *
 * A provider identity alone can change account bindings after admission.
 * Declaring the gap keeps `assertRelationalSweepComplete` refusing a completion
 * claim rather than guessing whose payload to erase.
 */
export interface UnattributableDescendant {
  readonly basis: string;
  readonly remedy: string;
}

export const UNATTRIBUTABLE_DESCENDANTS: Readonly<
  Record<string, UnattributableDescendant>
> = {};

/** Vocabulary columns that are deliberately not their table's sweep key.
 *
 * A vocabulary column must appear either in its entry's declared ownership or
 * here. The author of a new table carrying one has to choose; nothing defaults.
 */
export const NON_OWNERSHIP_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, NonOwnershipReason>>>
> = {
  chat_agentphone_context: { user_link_id: "covered_by_parent" },
  chat_discord_context: { sender_user_id: "provider_identity" },
  chat_slack_context: { sender_user_id: "provider_identity" },
  chat_teams_context: { sender_user_id: "provider_identity" },
  chat_telegram_context: {
    sender_user_id: "provider_identity",
    user_link_id: "covered_by_parent",
  },
  telegram_messages: { from_user_id: "provider_identity" },
};

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
  // Cascades from `agent_runs`, but it copies the run's `user_id`, so the
  // inventory guard classifies it as a root rather than a descendant.
  active_agent_runs: { coverage: "user_root", ownership: ["user_id"] },
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
  blob_upload_intents: { coverage: "not_account_scoped" },
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
    parents: ["browser_sessions", "chat_threads"],
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
    coverage: "user_root",
    ownership: ["source_user_id"],
  },
  chat_agentphone_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
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
  chat_event_sequences: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_event_retention_cursors: { coverage: "not_account_scoped" },
  chat_event_snapshot_scan_state: { coverage: "not_account_scoped" },
  chat_event_snapshots: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_content_erasure_subjects: { coverage: "not_account_scoped" },
  chat_events: { coverage: "user_descendant", parents: ["chat_threads"] },
  chat_discord_context: {
    coverage: "user_descendant",
    parents: ["discord_chat_thread_routes"],
  },
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
  chat_slack_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_teams_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_telegram_context: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  chat_thread_connector_selections: {
    coverage: "user_descendant",
    parents: ["chat_threads"],
  },
  // The composer draft lives off the thread row in its own table with no thread
  // foreign key, owned by the `user_id` every write copies.
  chat_thread_drafts: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  chat_thread_event_sequences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  chat_thread_events: { coverage: "user_root", ownership: ["user_id"] },
  chat_thread_snapshots: { coverage: "user_root", ownership: ["user_id"] },
  chat_thread_ssh_access_overrides: {
    coverage: "user_descendant",
    parents: ["chat_threads", "ssh_connections"],
  },
  chat_thread_vnc_access_overrides: {
    coverage: "user_descendant",
    parents: ["chat_threads", "vnc_connections"],
  },
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
  // One-way Gateway event digests carry no account identity or message body.
  // Keep them across deletion so replay cannot launch the same task again
  // or uninstall a later installation of the same guild.
  discord_gateway_receipts: { coverage: "not_account_scoped" },
  discord_chat_ingress: {
    coverage: "user_descendant",
    parents: ["discord_org_connections"],
  },
  discord_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  discord_org_connections: { coverage: "user_root", ownership: ["user_id"] },
  discord_org_installations: {
    coverage: "organization_owned",
    association: ["installed_by_user_id"],
  },
  discord_user_agent_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  discord_user_dm_preferences: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  // Explicit product carve-out: queued and sent mail stays in the existing
  // outbox lifecycle, not in per-account erasure. Future retention is separate.
  email_outbox: { coverage: "deferred_retention" },
  email_suppressions: { coverage: "not_account_scoped" },
  export_jobs: { coverage: "user_root", ownership: ["user_id"] },
  // Explicit product carve-out: inbound payload rows are not swept on account
  // deletion. This is not a claim that processing deletes them.
  feishu_chat_ingress: { coverage: "deferred_retention" },
  feishu_chat_thread_routes: { coverage: "user_root", ownership: ["user_id"] },
  feishu_org_connections: { coverage: "user_root", ownership: ["user_id"] },
  // A provider retry receipt keyed by the organization installation and the
  // Feishu event id. It carries no account identity and no message content,
  // and its only foreign key is to an `organization_owned` installation, so
  // erasing one member must not discard the installation's deduplication.
  feishu_org_events: { coverage: "not_account_scoped" },
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
  home_task_recommendations: {
    coverage: "user_root",
    ownership: ["user_id"],
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
  morning_brief_native_schedule_skips: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  morning_brief_native_schedules: {
    coverage: "user_root",
    ownership: ["user_id"],
  },
  // A platform provider-cost fact. The schema states it carries no
  // organization, user, Agent, thread, occurrence or source identity and no
  // prompt or generated text, and that it must survive owner deletion: once
  // the owner-scoped generation row is gone the `attempt_id` linkage is gone
  // with it and what remains is an unattributable cost.
  morning_brief_platform_generation_receipts: {
    coverage: "billing_preserved",
    ownership: [],
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
  // `pi_resource_version_indexes_version_fk` points at `storage_versions`,
  // which is itself a root. The previous declaration named the grandparent, so
  // the catalogue could not match it to a declared parent.
  pi_resource_version_indexes: {
    coverage: "user_descendant",
    parents: ["storage_versions"],
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
    ownership: ["official_user_link_id"],
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
  workflow_schedule_skips: {
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
  // Shared daily read deduplication for the single X billing account. The row
  // is `(utc_day, resource_type, resource_id)`: an X post or user id, never an
  // Okou account, and the schema declines a run or account key precisely so
  // erasing one account cannot reset another customer's deduplication.
  x_resource_reads: { coverage: "not_account_scoped" },
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

function nonOwnership(
  table: string,
): Readonly<Record<string, NonOwnershipReason>> {
  return NON_OWNERSHIP_COLUMNS[table] ?? {};
}

/** Fails when the schema and the inventory disagree in any direction.
 *
 * A new table is uncovered until it is classified, a renamed ownership column
 * stops silently voiding a root's coverage, and an inventory entry cannot
 * outlive the table it describes.
 */
function assertColumnsDeclared(
  table: OwnershipTable,
  entry: AccountOwnershipEntry,
): void {
  const columns = new Set(table.columns);
  const declared = declaredColumns(entry);
  for (const column of declared) {
    if (!columns.has(column)) {
      fail("ownership_column_missing", `${table.name}.${column}`);
    }
  }
  const excluded = nonOwnership(table.name);
  for (const column of Object.keys(excluded)) {
    if (!columns.has(column)) {
      fail("non_ownership_column_missing", `${table.name}.${column}`);
    }
    if (declared.includes(column)) {
      fail("non_ownership_conflict", `${table.name}.${column}`);
    }
  }
  // A vocabulary column is the table's sweep key or it is declared not to be.
  // Nothing defaults: a provider identity left implicit is a column the sweep
  // compares cleanly and matches never, reporting the table clean while every
  // row stays.
  const carried = ACCOUNT_OWNERSHIP_COLUMNS.filter((column) => {
    return columns.has(column) && !(column in excluded);
  });
  const [first] = carried;
  if (first === undefined) {
    return;
  }
  if (entry.coverage === "not_account_scoped") {
    fail("unclassified_ownership", `${table.name}.${first}`);
  }
  if (entry.coverage === "user_descendant") {
    fail("root_declared_as_descendant", `${table.name}.${first}`);
  }
  for (const column of carried) {
    if (!declared.includes(column)) {
      fail("undeclared_ownership_column", `${table.name}.${column}`);
    }
  }
}

/** Fails when a declared reach does not describe a join the schema can make.
 *
 * The guard checks the declaration's shape and its columns. Whether the join
 * actually reaches the account is the relational plan's job, against the live
 * catalogue — this is what stops a typo or a renamed column from becoming a
 * `DELETE` matched on a column that is not there.
 */
function assertReachDeclared(
  table: string,
  entry: AccountOwnershipEntry,
  columns: ReadonlyMap<string, ReadonlySet<string>>,
  reaches: readonly DescendantReach[],
): void {
  if (entry.coverage !== "user_descendant") {
    fail("reach_not_a_descendant", table);
  }
  for (const reach of reaches) {
    if (reach.basis.length === 0) {
      fail("reach_basis_missing", table);
    }
    if (reach.path.length === 0 || reach.path.length > MAX_REACH_HOPS) {
      fail("reach_path_invalid", table);
    }
    const last = reach.path[reach.path.length - 1];
    if (!last || !entry.parents.includes(last.parent)) {
      fail("reach_parent_undeclared", `${table}->${last?.parent ?? ""}`);
    }
    let below = table;
    for (const hop of reach.path) {
      if (
        hop.childColumns.length === 0 ||
        hop.childColumns.length !== hop.parentColumns.length
      ) {
        fail("reach_columns_unpaired", `${table}->${hop.parent}`);
      }
      const belowColumns = columns.get(below);
      const parentColumns = columns.get(hop.parent);
      if (!belowColumns || !parentColumns) {
        fail("reach_unknown_table", `${table}->${hop.parent}`);
      }
      for (const column of hop.childColumns) {
        if (!belowColumns.has(column)) {
          fail("reach_column_missing", `${below}.${column}`);
        }
      }
      for (const column of hop.parentColumns) {
        if (!parentColumns.has(column)) {
          fail("reach_column_missing", `${hop.parent}.${column}`);
        }
      }
      below = hop.parent;
    }
  }
}

/** Checks every declared reach and every declared unattributable descendant.
 *
 * Split from the coverage guard so each stays one reviewable rule rather than
 * one function that happens to run both.
 */
function assertDescendantReachDeclared(
  columns: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const [name, reaches] of Object.entries(DESCENDANT_REACH)) {
    const entry = ACCOUNT_OWNERSHIP_INVENTORY[name];
    if (!entry) {
      fail("reach_unknown_table", name);
    }
    if (name in UNATTRIBUTABLE_DESCENDANTS) {
      // A table is reached or it is declared unreachable, never both: the two
      // declarations would disagree about whether its rows can be deleted.
      fail("reach_unattributable_conflict", name);
    }
    assertReachDeclared(name, entry, columns, reaches);
  }
  for (const [name, declaration] of Object.entries(
    UNATTRIBUTABLE_DESCENDANTS,
  )) {
    if (ACCOUNT_OWNERSHIP_INVENTORY[name]?.coverage !== "user_descendant") {
      fail("unattributable_not_a_descendant", name);
    }
    if (declaration.basis.length === 0 || declaration.remedy.length === 0) {
      fail("unattributable_basis_missing", name);
    }
  }
}
function isDeferredRetentionTable(name: string): boolean {
  return name === "email_outbox" || name === "feishu_chat_ingress";
}

export function assertOwnershipInventoryCoverage(
  tables: readonly OwnershipTable[],
): void {
  const columns = new Map<string, ReadonlySet<string>>(
    tables.map((table) => {
      return [table.name, new Set(table.columns)];
    }),
  );
  const present = new Set<string>();
  for (const table of tables) {
    const entry = ACCOUNT_OWNERSHIP_INVENTORY[table.name];
    if (!entry) {
      fail("uncovered_table", table.name);
    }
    present.add(table.name);
    if (
      (entry.coverage === "deferred_retention") !==
      isDeferredRetentionTable(table.name)
    ) {
      fail("deferred_retention_scope_mismatch", table.name);
    }
    assertColumnsDeclared(table, entry);
    if (entry.coverage === "user_root" && entry.ownership.length === 0) {
      fail("ownership_undeclared", table.name);
    }
  }
  for (const name of Object.keys(NON_OWNERSHIP_COLUMNS)) {
    if (!(name in ACCOUNT_OWNERSHIP_INVENTORY)) {
      fail("non_ownership_unknown_table", name);
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
  assertDescendantReachDeclared(columns);
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
