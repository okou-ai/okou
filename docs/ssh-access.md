# SSH access for owners and Agents

SSH is a standalone capability behind the `SshAccess` (`sshAccess`) feature
switch, enabled by default for staff organizations and disabled by default for
other organizations. Explicit user overrides still take precedence, including
disabling SSH for a staff user or enabling it for a non-staff user. The switch
appears in Lab's Beta group and is the only feature-eligibility gate; there is no
additional staff-membership check. Owner, Agent grant and Run authorization
checks remain mandatory. The Connectors entry and Agent control are hidden
while the switch is off. SSH uses neither connector accounts nor connector
permissions.

## Owner setup

Open **Connectors -> Remote access -> SSH** (`/connectors/ssh`) to manage hosts for your
current organization and user, without selecting or creating an Agent. The SSH
card uses the same presentation as connector cards: no hosts shows the service
description and add affordance; one configured host shows its display name and
multiple hosts show their count. Hosts without a reported failure use a green dot;
current failures use an amber dot and `failed/total need attention`, including
`1/1 need attention` for a single failed host. The footer keeps **Add access** or
**Used by** Agent authorization. The authorization
dialog lists your currently visible Agents with search and the same switches as
Connector access management, while writing only the standalone SSH grant API.
The count is configuration, not tested connectivity. It participates in
search and category navigation. Connection-status filters mean configured or
not configured for SSH; an Agent filter uses its independent SSH grant, even
when no hosts are configured. SSH never opens generic connector account or
permission dialogs.

The zero-host card enters `/connectors/ssh?add=1`. The page consumes this intent
once, checks the current inventory and opens **Add host** only if it is still
empty. Cancelling, refreshing, or receiving a notification does not reopen it.

The management page follows the Agent and Workflow detail-page layout, with
**Connectors / SSH** breadcrumbs on desktop and mobile. Use the Connectors
breadcrumb to return to the directory. Host management remains independent of
Agent grants.

The **Hosts** view configures a display name, public hostname or IP, port, and a
credential. Select an existing credential or create a named credential inline with
the host. The **Credentials** view manages reusable logins owned by the same
organization and user. Each credential contains an SSH username and either a
private key with an optional passphrase, or a password. Password authentication
uses SSH password authentication, not keyboard-interactive prompts.

Paste a key or use **Choose file** to read a non-empty key file up to 64 KiB
locally. File selection does not upload anything or parse the key format; Save
submits the credential. Keys, passphrases and passwords preserve whitespace.
Secrets are write-only and stay outside the sandbox. Use a least-privilege
remote SSH user. Submitted input stays only in the open form while saving;
controls are disabled until the request completes. A retryable failure preserves
the input so the user can correct it or click Save again. Successful saves close
the form and clear its secrets, as do cancellation, navigation and owner changes.
Changing authentication methods clears the previous method's inputs. Secrets
are never stored in reactive state or browser caches. A background notification
refreshes the lists without clearing an open form. Stale revisions still require
reopening the refreshed item rather than retrying an outdated write.

Each saved connection has its own ID. Multiple configurations may use the same
host and port, with different usernames or different keys for the same username.
Use display names to distinguish them. An authorized Run can use all of these
configurations by their exact IDs. Learned host keys, configuration generations
and observations remain independent per host. Editing a host can change its
credential reference without changing other hosts. Deleting a host keeps its
credential; deleting an in-use credential is rejected until all hosts are
rebound or deleted.

Saving a host is not a connectivity test. Configuration does not establish an
SSH session. **Edit credential** shows affected hosts. Changing its username or
explicitly selecting **Replace authentication** updates the login for every host
currently using that credential, atomically advancing their generations while
preserving learned host keys. Renaming a credential leaves host generations
unchanged. Host/port changes clear only that host's learned identity. Stale host
generations or credential revisions are not retried; reopen the refreshed item
and review current settings and affected hosts.

### Owner storage and pre-GA cutover

`/api/ssh/credentials` provides session-authenticated, feature-gated metadata
listing and credential creation/update/deletion. Host writes select
`credential: { id }` or atomically create `credential: { create: ... }`.
Responses never return plaintext or ciphertext. A composite database foreign key
requires the host and credential to have the same organization and user.

Current encrypted storage is `ssh_credentials.encrypted_private_key` plus
optional `encrypted_passphrase`, or `ssh_credentials.encrypted_password`.
The selected method is enforced by a database check; changing methods clears
the previous method's ciphertext columns. These fields use the normal stored
secret encryption envelope. Historical KMS rotation scripts remain immutable
records of the schema they migrated, not an inventory of current encrypted fields.

Migration `1113_reusable_ssh_credentials` implements the explicitly approved
pre-GA reset: it deletes old SSH hosts, their bound credentials, observations and
learned pins. Agent SSH grants and unrelated data are retained. There is no
backfill, legacy writer or rollback restoration; old hosts must be configured
again. Applying this migration is destructive. A production cutover must stop
outgoing owner API writers before applying the migration and starting the new
API; ordinary overlapping API deployment is not supported for this reset.
Already-loaded staff pages must reload. This is separate from the Runner's
existing support for both key and password authority responses.

Enable the **SSH** row in **Agent -> Authorization**, alongside connector rows
with the same search and loading switch, not in Profile. The description explains
the all-host grant; there is no information tooltip, permission-sliders or
host-management button in that row. With no hosts, the SSH
row is hidden without clearing grants. Adding the first host automatically
authorizes all Agents currently visible to you, including other users' public
Agents in the same workspace. Host creation and these grants commit together.
Adding more hosts preserves manually disabled grants. Deleting every host and
adding one again repeats automatic authorization, just like connecting the first
Connector account; Agents created afterward are not automatically authorized.

You can grant or revoke your own SSH access for any currently visible Agent.
The grant covers all your current and future hosts in that workspace, only for
your Runs. An Agent's creator or another user does not receive your credentials
or your grant. Agents cannot grant themselves access. This is not limited to
chat-triggered Runs.

Chat's services popover shows SSH alongside configured Connectors, with the
same authorization switch and an enabled trigger icon, without a host-management
action. Manage hosts through the global SSH card.
Both the service list and trigger icons order built-in Connectors before SSH,
then custom Connectors. The trigger keeps its three-icon limit and existing
computer/browser slots; SSH no longer displaces built-in Connector icons.
It always uses that composer's Agent, including split-pane chats. No hosts hides
the SSH row; **Add connectors** offers the same zero-host setup entry.
Both the legacy dialog and the Discover directory include this entry when
SSH is enabled and no hosts are configured. In Discover, it appears after
built-in shelves and under **Remote access**, participates in search, and stays
out of the Custom tab. Its link also supports normal keyboard activation.
Opening the popover refreshes SSH reads without dropping the last confirmed
display for the same user/workspace. Its switch waits for the refreshed result.
Changing owner discards that retained display, and each composer selects only
its own Agent's grant.

Owner API business errors use stable `SSH_*` codes. Platform translates them,
including recovery guidance for invalid input, stale generations and unavailable
hosts/Agents. A failed read shows a localized load error with **Retry**, distinct
from feature unavailability. There is no persistent Refresh button and background
failures do not show raw server-message toasts.

Successful host and grant changes publish best-effort `ssh:changed` on the owner's
user channel with only `{ orgId }`. Learning a new host key also refreshes the
browser. Platform checks the workspace and invalidates host, summary and grant
reads. Initial subscription also refreshes them; reconnect and foreground events
do not trigger extra reads. These refreshes do not close dialogs, clear unsaved
keys or automatically grant access. Browser notifications are separate from
Runner authority invalidation and do not tighten
the accepted Run-lifetime cache window.

## Recent connection failures

After an actual SSH attempt, the host card can show the last reported connection
failure, its observation time, and localized recovery guidance. The directory
card uses the same status-dot and attention-ratio presentation as Connector
cards. Chat service rows and compact icons do not add SSH-only warning badges,
matching Connector presentation. Multiple hosts retain independent observations;
a healthy sibling cannot clear another host's warning. Grants, service order
and the compact icon limit are unchanged.

Only credential parsing, destination, network, host identity, authentication and
pre-authentication handshake/timeout failures are connection failures. A verified
host key followed by successful SSH authentication clears the previous warning,
even if the command is rejected, returns nonzero, disconnects or times out later.
Command outcomes, cancellation, admission and authority failures do not create
host warnings. No command is retried and no trust or grant is changed.

Saving or editing a host is not a connection test. Any configuration generation
change hides observations for the previous configuration without claiming success.
No observation means unknown connectivity. A green directory dot means configured
with no currently reported failure, not a verified live connection; the UI does
not add an untested status line. A failed/unavailable diagnostic read is shown
separately and leaves host management available. Observations refresh through
the existing owner notification. A single-host name uses the existing owner-scoped
host-list read; while that name is unavailable, the configured count is the
presentational fallback.

This is best-effort recent evidence, not continuous monitoring. Reports may be
missed, arrive late or be rejected after a Run ends or authority changes. There
is no background probe, periodic poll or diagnostic history. Fleet clock skew
can affect cross-Run ordering; the displayed time describes the observation,
not a guarantee of current reachability.

## Agent commands

```sh
okou ssh host list --json
okou ssh exec <connection-id> --command 'uname -a' --json
```

Use the exact UUID from the live inventory, not the display name or hostname.
List again after an unavailable or unknown ID; never invent IDs or automatically
replay a command whose effects are unknown.
The inventory requires a current running Run, an Agent visible to its user, a current grant,
and `ssh:read`. An authorized empty inventory is distinct from unavailable
authority. Execution requires `ssh:write`. Both capabilities are minted only
for feature-enabled Runs; newly eligible Runs must start with a fresh token.
These commands are Run-only, not PAT commands. Agents cannot grant themselves
access or send target addresses, credentials or host keys to the helper.

Within the same Run, a command or session can automatically reuse an idle SSH
connection after the previous channel finished. Each active process owns its
connection exclusively; independent commands keep separate shell state. Up to
eight idle connections are retained for 60 seconds. Run end and delivered
authorization changes close retained connections. No extra CLI option is needed.

The CLI sends exactly one version-1 `ssh.exec` request to the fixed packaged
`/usr/local/bin/runner-rpc-client`, with no shell, extra arguments or retry.
Commands must contain 1–65,536 UTF-8 bytes. Human output preserves binary
stdout/stderr; JSON exposes `stdout_base64`, `stderr_base64`, byte counts,
truncation flags and the structured outcome. Each output stream retains at most
1 MiB. No status, malformed output, duplicate terminal, lost transport or helper
exit zero without a valid SSH result counts as remote success.

`finished` carries a remote status or standard signal and `effects: completed`.
The CLI returns remote statuses 0–255 directly. Larger u32 statuses remain exact
in JSON and cause CLI exit 1. Signals also cause CLI exit 1. `failed` carries
`failure_reason` and `effects: not_started | unknown`. Generic helper failures
use `type: rpc_error`, `code` and `delivery: not_dispatched | unknown`. Diagnose
using these fields, never by matching error text. An uncertain result may have
performed the remote command: do not automatically retry it.

### Long commands and persistent shells

For work spanning several CLI calls, use a managed session:

```sh
okou ssh session start <connection-id> --command 'sleep 90; uname -a' --json
okou ssh session status <session-id> --json
okou ssh session read <session-id> --cursor 0 --json
okou ssh session close <session-id> --json
```

Start returns a session ID immediately; status reports setup failure, running
state, or observed exit. `--shell` starts a persistent shell instead of a command;
later `write --text <text>` calls share its working directory, environment and
stdin. Include newlines when submitting shell commands. Optional `--pty` requests
a terminal. `write --base64 <data>` preserves binary input, and `--eof` closes
stdin after the submitted bytes. Use `signal --signal TERM` to submit a signal.

Continue output reads with the returned `next_cursor`. Reading does not consume
output, and a `lost` range explicitly identifies discarded bytes. `session list`
recovers the current Run's IDs after a lost start reply. All session commands
require `ssh:write`. There are eight retained sessions per current Run; completed
records remain for five minutes or until closed. Running sessions last at most
two hours and always end with their Run; they cannot resume in another Run.

Input/signal submission and closing SSH do not prove the remote process stopped
or its effects completed. Never automatically replay uncertain starts or input.
An older Runner returns `unknown_method`; there is no automatic conversion into
independent exec calls. Observed authorization-notification disconnects cancel
managed sessions and prevent new starts until the subscription recovers.

## Host identity, errors and revocation

The first successful connection learns and persists the server key before
authentication (TOFU). A learned key is read-only. For `host_key_mismatch`,
independently verify the new identity before using **Reset host key**; that
explicit confirmation allows a later connection to trust and learn a new key.
Never reset automatically. For credential failures, ask the owner to review the
supported key format and replace credentials. For `unavailable`, check the
feature, owner grant, host and Run lifetime. For `unsafe_destination` or
`network_failure`, check the public endpoint and reachability. Capacity or
timeout failures do not justify replay when effects are unknown.

Inventory and owner configuration are live reads. Execution authority uses the
existing Run-lifetime Runner cache while notifications are connected. Host edits,
rotation, deletion, reset and Agent grant changes publish invalidation notices.
Grant notices use `{ runId, connectionId: null }` for active Runs of that exact
owner/Agent, including after deleting the grant. Notification failure does not
roll back a committed edit. A missed notice can leave cached authority until the
Run ends. End affected active Runs when immediate revocation is necessary.

See [Runner authority](runner-ssh-authority.md) for authorization and cache
semantics, [SSH execution](runner-ssh-execution.md) for supported keys, network
policy and resource limits, and [RPC transport](runner-rpc-transport.md) for
packaged-helper framing, deadlines and deployment constraints.

## Shared-endpoint rollout compatibility

The migration removes only the owner/host/port unique index and runs before API
promotion. Existing configuration rows, request/response shapes and ID-based
Runner operations remain valid. Outgoing or rolled-back API versions still
reject creates and edits at occupied endpoints, including edits to configurations
that a newer API created at a shared endpoint. Listing, execution and deletion
continue to select exact IDs.

API rollback does not restore the database index. Reintroducing endpoint
uniqueness would require explicit reconciliation of saved configurations;
never delete or merge them as an automatic rollback step. Host-key trust remains
per configuration, including separate first-use learning and explicit resets.
