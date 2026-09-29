# Release 1 shared custom connector prefixes

Ethan accepted multiple connectors sharing a service URL prefix. Prefix exclusivity is no longer an invariant and therefore does not justify an advisory key or an outgoing-writer drain gate.

The create and update commands no longer acquire `custom_connector_prefixes:<orgId>`, initialize an organization row solely for prefix arbitration, lock that row, or scan every organization definition for an equivalent prefix. Each definition still validates its own URL templates, field references and injections. The existing `(org_id, slug)` unique index and UUID identity remain unchanged. No persistent field, trigger or coordination table is added.

The credential/routing boundary already identifies the connector independently of its prefix:

- `connector-check.service.ts:resolveUrlMode` supplies the requested target to `matchFirewallRequestDecision`. A run target must be admitted to that run. An unresolved multi-owner match returns an ambiguous diagnostic, not an arbitrary first account.
- `agent-run-create.service.ts:buildCustomConnectorRuntimeApis` builds each registered connector's APIs separately. Its runtime identity and credential markers contain the custom connector UUID, and the account selection belongs to that identity.
- Runner `matching.py:_selected_owner_name` rejects multiple winning owners without a valid explicit intent; `_owner_name_for_intent` accepts exactly one matching identity. The matched connector UUID and account source are forwarded to the existing firewall credential API. These behaviors already exist in the pre-change source, including release tree `c501c3b7bf0171489fb9ab1d0d2359725eb1b67d`; this change adds no Runner/App request field or protocol.
- The server credential resolution validates the admitted connector and current account ownership. A shared URL does not authorize a sibling connector's credential or resurrect a deleted selection.

API tests now permit concurrent definitions and edits with equivalent normalized prefixes while retaining independent UUIDs/slugs. The run diagnostic test constructs two connected definitions through the user APIs, verifies an ambiguous request without a target, resolves each explicit target, and confirms deleting one target does not make that target resolve through its surviving sibling. Existing cross-account credential, permission, unavailable-target and Runner intent tests remain.

The removed duplicate prefix-concurrency test added no distinct boundary beyond normalized equivalent URLs. Other definition validation and organization authorization tests remain. No internal row lock, trigger or artificial database gate is used.

This is the prefix exclusion slice only. Custom OAuth writes and shared skill Storage commits still have transaction-aware interfaces and remain implementation work in the main R1 inventory. A lower advisory count is not R1 readiness. Behavioral verification belongs to the combined PR pipeline.

## Definition write ownership

Custom connector create/update now execute their mode/config SQL directly in the
owning command. They no longer pass a transaction or callback through
`writeCustomConnectorOAuthState`; the existing parent identity protects updates,
new parent insertion protects creation, and final mode/config consistency is
checked before commit. Automatic-registration retirement and OAuth upsert builders
receive only business values. Definition preflight and accepted-catalog reads use
business-input commands, and runtime wakeups own their post-commit read. Both
runtime and organization invalidation complete before reporting cancellation.

This does not complete the whole Custom/Storage chain: Pi stable-context
invalidation/recapture still forwards the transaction, and other account writers
and Feishu's mode/config writer retain their legacy helpers. These are R1
implementation gaps, not outgoing-only compatibility boundaries. Provider/KMS
preparation and prepared Storage upload/verification remain outside these commits.
