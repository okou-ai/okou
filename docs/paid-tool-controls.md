# Personal paid-tool controls

Paid-tool controls are personal preferences within one workspace. They do not
change connector authorization, organization permissions, or billing policy.
The `paidToolControls` feature switch is disabled by default.

## Storage and API

`user_disabled_paid_tools` stores a row for each disabled `(org_id, user_id,
tool_id)` tuple. No row means enabled. The authenticated member can read their
own list with `GET /api/paid-tools` and change one tool with
`PATCH /api/paid-tools/:toolId` using `{ "disabled": true | false }`.
Independent tool updates do not replace the entire list. Both endpoints require
a user session and the feature switch; agent and sandbox credentials cannot
change preferences. Membership removal deletes only that member's workspace
rows; user and organization deletion remove their respective rows.

The shared catalog currently includes `web-search`, `people-search`, `scrape`,
`finance`, `maps`, `seo`, `social`, and `image-recognition`. Media generation and
rendering are tracked separately in [#35187](https://github.com/vm0-ai/okou/issues/35187).

## Settings and run semantics

Settings → Personal → Paid tools shows the current workspace and saves each
switch immediately. `?settings=paid-tools` opens the same page on desktop and
mobile. A failed load shows a retry state rather than implying every tool is
enabled; a failed write retains the last confirmed value.

Run preparation reads the actual run owner's preferences and resolved feature
switch context, then captures a JSON string array in the trusted platform
environment as `OKOU_DISABLED_PAID_TOOLS`. A prepared queued run retains its
snapshot. Deferred Pi runs capture the preferences when their sandbox is
materialized. Existing sandbox environments do not change in place. With the
feature disabled, preparation does not read this table or emit the variable.

The CLI checks the policy before a paid command's action, including before
uploads, output-file creation, or network calls. Help remains usable and
identifies disabled tools. Rejections link to the settings page on the current
platform environment. Social capabilities, status, download listing, and
`download --resume` remain available because they discover or recover existing
work. Collection `social resume` can fetch additional paid pages and is blocked.

## Compatibility and activation

The migration is additive. Deploy it before the API and enable the switch only
after the API, settings client, and run-selected CLI include this implementation.
Do not enable it while an old serving API can prepare runs without the policy.
Runner job schemas are unchanged: the existing platform environment carries
the variable, and prepared jobs retain their commit-addressed CLI package.

An absent or empty variable means no disabled tools, including when the feature
is off. Unknown string IDs are ignored by older CLIs, allowing later catalog
additions. Invalid JSON or a non-string-array value rejects paid operations;
free operations and help remain usable. API read lists likewise allow unknown
string IDs, while writes validate the current catalog. These are the optional
input and additive catalog contracts, not recovery from database failures.
Preference query failures fail run preparation rather than silently enabling
tools. Turning the feature off retains saved rows for a later re-enable.
After preferences have been saved, keep an API version that includes their
membership/user/organization cleanup; switch rollback does not remove that
cleanup requirement.

Local verification covers authenticated preference isolation and cleanup,
queued and deferred snapshots, real CLI dispatch without paid side effects,
and settings save/error/lifetime behavior. Production activation is a separate
decision; this change does not enable the switch.
