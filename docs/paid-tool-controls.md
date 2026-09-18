# Personal paid-tool controls

Paid-tool controls are personal preferences within one workspace. They do not
change connector authorization, organization permissions, or billing policy.
The `paidToolControls` feature switch is disabled by default and controls the
settings and creation-guidance UI. Saved preferences and enforcement are
independent of it.

## Storage and API

`user_disabled_paid_tools` stores a row for each disabled `(org_id, user_id,
tool_id)` tuple. No row means enabled. The authenticated member can read their
own list with `GET /api/paid-tools` and change one tool with
`PATCH /api/paid-tools/:toolId` using `{ "disabled": true | false }`.
Independent tool updates do not replace the entire list. Both endpoints require
a user session; agent and sandbox credentials cannot
change preferences. Membership removal deletes only that member's workspace
rows; user and organization deletion remove their respective rows.

The shared catalog includes `web-search`, `people-search`, `scrape`, `finance`,
`maps`, `seo`, `social`, `image-recognition`, `image-generation`,
`video-generation`, `voice-generation`, and `avatar-video-generation`.

## Settings and run semantics

Settings → Personal → Paid tools shows the current workspace and saves each
switch immediately. `?settings=paid-tools` opens the same page on desktop and
mobile. A failed load shows a retry state rather than implying every tool is
enabled; a failed write retains the last confirmed value.

Run preparation reads the actual run owner's preferences regardless of the UI
feature switch, then captures a JSON string array in the trusted platform
environment as `OKOU_DISABLED_PAID_TOOLS`. A prepared queued run retains its
snapshot. Deferred Pi runs capture the preferences when their sandbox is
materialized. Existing sandbox environments do not change in place. With no
disabled tools, preparation emits an empty array. Hiding the settings UI does
not stop preference reads or change the captured policy.

The CLI checks the policy before a paid command's action, including before
uploads, output-file creation, or network calls. Help remains usable and
identifies disabled tools. Rejections link to the settings page on the current
platform environment. Social capabilities, status, download listing, and
`download --resume` remain available because they discover or recover existing
work. Collection `social resume` can fetch additional paid pages and is blocked.

Prompt injection is unchanged. A disabled paid invocation exits with status 1
and identifies the disabled tool, links to Settings → Personal → Paid tools,
and explains that re-enabling applies to later runs.

## Media execution

Media commands check the same snapshot at their paid execution boundary.
Provider discovery reports when a built-in option is disabled and preserves
connector alternatives. Free help, prompt compilation, template authoring,
resource catalogs and existing result observation remain available.

| Tool ID                   | Paid execution covered                                               | Free branches preserved                             |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `image-generation`        | Built-in image generation, image-batch start and hidden batch worker | Prompt compilation, provider and connector guidance |
| `video-generation`        | Built-in video generation                                            | Template authoring and provider guidance            |
| `voice-generation`        | Built-in voice generation                                            | Provider and connector guidance                     |
| `avatar-video-generation` | Built-in avatar video                                                | Avatar/voice catalogs and connector guidance        |

Checks precede uploads, artifact preparation and execution output writes. A
disabled batch worker does not create a misleading completion file.

The creation UI explains disabled choices and links to settings. Explicit
built-in image/video creation checks current owner preferences before sending;
a failed read does not assume the tools are enabled. Selected templates can
also be discussed without generating anything, so a template alone does not
block ordinary messages. The CLI checks the actual paid command selected by
the agent. Confirmed settings saves refresh creation hints. Workspace changes
do not retain the previous owner's preference state. New proactive UI follows
the UI feature switch; saved restrictions still apply to explicit creation and
CLI execution while the switch is off.

## Compatibility and activation

The migration is additive. Deploy it before the API and enable the switch only
after the API, settings client, and run-selected CLI include this implementation.
Do not enable it while an old serving API can prepare runs without the policy.
Runner job schemas are unchanged: the existing platform environment carries
the variable, and prepared jobs retain their commit-addressed CLI package.

The media catalog extension needs no database migration. Deploy the expanded
API and select a CLI that enforces the new IDs before deploying the App's media
creation checks, which read preferences even while the UI switch is off.
An older API rejects writes for unfamiliar IDs, and an older pinned
CLI ignores those IDs; already prepared jobs therefore do not gain media
enforcement retroactively.

Intro Video and managed cloud rendering were retired in
[#35196](https://github.com/vm0-ai/okou/pull/35196). Their hidden commands and
`okou video render` are gone, so `video-rendering` is no longer in the supported
catalog or settings. No database migration or snapshot rewrite is needed:
stored preferences and API read lists already carry arbitrary string IDs, and
current CLI commands do not act on this retired ID. Retaining existing rows
preserves restrictions for pinned CLI versions that still recognize the ID;
normal membership, user, and organization cleanup still applies. API writes
validate the current catalog; an older settings client trying to change the
retired tool must refresh. The UI remains behind the default-off feature switch.

An absent or empty variable means no disabled tools for contexts without this
policy. Unknown string IDs are ignored by older CLIs, allowing later catalog
additions. Invalid JSON or a non-string-array value rejects paid operations;
free operations and help remain usable. API read lists likewise allow unknown
string IDs, while writes validate the current catalog. These are the optional
input and additive catalog contracts, not recovery from database failures.
Preference query failures fail run preparation rather than silently enabling
tools. Turning the feature off only hides its proactive UI; saved rows remain
effective for newly prepared runs and accessible through the authenticated API.
After preferences have been saved, keep an API version that includes their
snapshot production and membership/user/organization cleanup; hiding the UI
does not provide a backend rollback mechanism.

Local verification covers authenticated preference isolation and cleanup,
queued and deferred snapshots, real CLI dispatch without paid side effects,
and settings save/error/lifetime behavior. Production activation is a separate
decision; this change does not enable the switch.
