# Domain glossary

## Voice draft

A local recording lifecycle initialized by the composer. It captures 16 kHz PCM
through AudioWorklet and continuously appends ordered chunks to IndexedDB,
isolated by user, organization, and thread or agent. IndexedDB is the sole
persistent recording source; recording identity and state are never TipTap
nodes or text-draft fields. A browser Web Lock owns each target, and writes and
deletions check the recording identity. Forwarding composers use the selected
thread or agent target too; their temporary text does not opt audio out of
persistence. Closing a composer releases its recording and transcription work,
even when the surrounding page remains open.

Recording and transcription block submission. Failures retain saved audio for
Retry; composer initialization restores interrupted work as retryable without
opening the microphone. Retry rereads the saved recording, and explicit Remove
deletes it. Valid polished text enters the prepared composer through ordinary
input, then the recording is deleted without waiting for text autosave. This
handoff is not atomic with text persistence. Storage failures remain visible
and protect only the committed audio prefix.

No-speech provider results and recordings with no captured samples complete
silently without inserting text, saving a draft, or showing a toast. The
transcription API returns 204 when there is no intelligible speech. Silent chunks
are omitted before the remaining spoken content is polished; entirely silent
recordings skip polishing.
Recorder startup failures and cancellation release microphone resources;
interrupted recordings with committed audio remain recoverable.

_Avoid_: Voice draft block, server-synced recording draft, live transcript

## Archived chat history

The durable portion of a chat thread's complete event history that no longer
belongs to the hot event window.

## Hot event window

The most recent 30 days of individual chat events kept available for routine,
latency-sensitive product operations. Thread activity does not extend the age
of an older event.

## Full chat export

A user data export containing the complete logical message history for every
exported chat thread, including archived history and newer messages.

## Archived message selection

Selecting a message from the complete logical chat history after that message
has left the hot event window, subject to the same visibility and revocation
rules as a newer message.

## Automatic session context

The best-effort recent chat context supplied automatically when a new session
starts. It is distinct from explicit retrieval of a thread's complete history.

## Model-originated thinking

Reasoning content emitted by the model or its runtime as part of the durable
assistant transcript.

## Initial progress

Server-generated, transient progress shown while waiting for model output. It
is distinct from model-originated thinking and durable completed-work history.

## Restricted explicit content

Content intended for sexual arousal, sexual depictions involving minors,
graphic violence or gore, or instructions or encouragement for suicide or
self-harm. It excludes non-graphic news, medical, educational, historical,
safety, moderation, and ordinary fictional discussion.

_Avoid_: 18+ content, adult content

# Built-in Generation Failure Context

This context distinguishes provider failures by the stage at which a built-in
generation request is rejected or fails.

## Language

**Output safety block**:
A terminal generation outcome where generated media is withheld because an
output safety check rejected it.
_Avoid_: Input safety rejection, generic generation failure

**Input safety rejection**:
A generation request rejected because its prompt or reference media fails an
input safety check before an acceptable output is available.
_Avoid_: Output safety block, provider outage

# Pi Model Routing Context

This context separates Pi's trusted model metadata from the endpoint and model
identity used for one provider request.

## Language

**Pi catalog model**:
The native Pi provider/model entry used to source model capabilities and limits.
It does not expand product admission and does not have to match a custom
gateway's upstream model identifier.
_Avoid_: Gateway model, requested model

**Pi request model**:
The model identifier sent to the selected provider endpoint. For a custom model
provider gateway, this is the surface's upstream model mapping.
_Avoid_: Catalog model, logical model

**Pi credential header**:
A non-secret header name and value template stored in Pi launch metadata. The
credential is substituted only inside the API first-turn process or the
Sandbox's protected runtime boundary.
_Avoid_: API key header value, stored credential

# Retired Goal History Context

Okou's persistent Goal lifecycle was retired through S5 on 2026-09-10; see the
[accepted archival record](docs/goal-retirement-archival.md). Retained events
and archives describe historical objectives and status, with no scheduling or
lifecycle authority. Ordinary chat and Workflow Automations remain separate.

## Language

**Recorded Goal status**:
The historical `active`, `paused`, `blocked`, or `complete` status preserved in
an immutable retirement archive. Retirement did not mark unfinished objectives
complete, and a recorded `active` status does not identify current work.
_Avoid_: Active run, running automation

# Billing Context

The billing context decides whether a purchase can be reviewed and confirmed inside Okou or must continue on a Stripe-hosted page.

## Language

**Saved payment method**:
A Stripe payment method available to an organization through, in priority order, the subscription default, customer invoice default, an attached card, or a legacy default source.
_Avoid_: Bound card, default card

**Operation invoice**:
The invoice produced by confirming the current purchase or subscription change. Unpaid invoices from earlier operations are not part of this decision.
_Avoid_: Customer balance, historical invoice

**Hosted invoice payment**:
The Stripe-hosted invoice page used when an operation invoice remains unpaid after an in-app confirmation attempt.
_Avoid_: Checkout

# Banking Context

This context separates a user's provider-hosted bank connection consent from the narrower access delegated to an Okou agent.

## Language

**Mastercard Data Connect session**:
The Mastercard-hosted flow where a user links a financial institution and consents to Mastercard Open Finance accessing selected bank data.
_Avoid_: Okou bank login, banking agent grant

**Banking connection**:
A reusable link between an Okou user and bank accounts discovered through Mastercard Open Finance. It exists independently of any agent's access.
_Avoid_: Banking agent grant, Data Connect session

**Banking agent grant**:
An Okou authorization that lets one agent read selected connected accounts under explicit operations, duration, and automation rules.
_Avoid_: Bank consent, Mastercard connection

**Banking access request**:
An agent's user-visible request for a banking agent grant, including the purpose for access. The request may first require the user to create or repair a banking connection.
_Avoid_: Banking connection, automatic grant

# Acquisition Attribution Context

This context separates browser conversion delivery from its server-confirmed
source and server-side fallback.

## Language

**Browser conversion**:
A Google Ads website conversion emitted by gtag from an authenticated browser.
_Avoid_: Data Manager upload, server conversion

**Conversion milestone baseline**:
The first server-confirmed milestone snapshot recorded in a browser without
emitting historical conversions.
_Avoid_: Backfill, initial conversion batch

**Data Manager fallback**:
A server-side upload to the same conversion action using the same transaction
ID when browser delivery may be missed.
_Avoid_: Separate conversion, duplicate conversion

# Locale Selection Context

This context separates the authoritative workspace setting from hints used only
before a workspace preference exists.

## Language

**Workspace locale preference**:
The authoritative app locale stored for one user in one workspace. When it is
present and supported by the current client, it overrides every locale hint.
_Avoid_: Browser locale, site locale

**Locale fallback hint**:
A non-authoritative initial app locale derived from the shared Okou site cookie,
then the browser language list. It is used only when the workspace locale
preference is absent.
_Avoid_: Workspace preference, forced locale

# Morning Brief Context

This context separates a member's organization-scoped delivery settings from
their identity in other organizations.

## Language

**Member timezone preference**:
The authoritative IANA timezone stored for one user in one organization. The
same user can have a different timezone in another organization.
_Avoid_: Organization timezone, global user timezone

**Default Morning Brief enrollment**:
A one-time intent to install a private Morning Brief for a Clerk membership
created on or after the database rollout boundary. Enrollment waits for a valid
member timezone, a usable default Agent, and a connected source enabled for that
Agent. The worker retries unfinished enrollment without requiring another visit.
Cancellation and completed enrollment survive later initialization or membership
replays. An existing installation, including a paused one, takes precedence.
_Avoid_: Organization Morning Brief, existing-member backfill

# Product Identity Context

This context names the product identity used in application presentation.

## Language

**Okou product identity**:
The sole current public product, presentation, and application identity.
_Avoid_: Public brand, VM0 brand, selected brand

# Chat Image Annotation Context

This context separates an uploaded image, its editable annotation structure,
the rendered derivative shown to agents, and the transient composer session.

## Language

**Original image attachment**:
The immutable user-uploaded image identified by a file part's `fileId`. It
remains the canonical source even when annotations exist.
_Avoid_: Unannotated copy, source screenshot

**Image annotations**:
Structured editable marks attached to an image file part and sufficient to
reconstruct the confirmed editing result.
_Avoid_: Annotation prompt, mark text

**Annotated image**:
The rendered derivative identified by `annotatedFileId` and produced from an
original image attachment plus image annotations. It is not a second logical
attachment.
_Avoid_: Second attachment, rewritten original

**Annotation editing session**:
Composer-owned transient working state initialized from image annotations and
discarded with its owning composer.
_Avoid_: Global annotation session, saved annotation
