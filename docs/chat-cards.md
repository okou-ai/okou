# Chat Cards

## Overview

Action cards turn a specially recognized link inside a `ChatEvent` into a
rich, interactive React surface. The message remains the transport: an agent or
another producer can emit a normal URL, Markdown link, or relative platform
path, and the platform upgrades that link into a typed card when its path
matches a supported pattern. Failure recovery cards are the main exception:
they are derived from structured fields on a `run.failed` event instead of a
link in the message body.

The core pipeline is:

```text
ChatEvent content
  -> recognize a trusted link and parse a typed descriptor
  -> derive a stable resource key
  -> register signals at the message write/command boundary
  -> attach the signals object to a render block
  -> pass the signals object to the matching React component
```

This design keeps message content portable while allowing the platform to add
loading states, live data, actions, and other rich interaction without putting
state creation inside React render. Artifact resources use the same registration
boundary while preserving the Markdown link or image syntax that chooses their
presentation.

## Fixed Height and Stable Layout

Every card in the chat transcript must keep one outer height for the lifetime of
that card occurrence, at a given available width. This includes action, failure
recovery, billing, unavailable, and resource-preview cards. Different card types
may use different dimensions, and responsive breakpoints may select a different
height. Asynchronous data and status changes must not select the card's height.

The height itself may come from the card's own synchronous row structure rather
than from a hardcoded pixel value. A notice card that renders only a headline is
one row tall, and the same card with a supporting line is taller, because that
choice is made from props already present at mount and never changes afterwards.
Reserve geometry wherever the asynchronous read does reach. The notice cards in
`chat-thread-page.tsx` keep a two-line box for the supporting line, since
billing status and failure-recovery classification swap that text inside an
already mounted frame, and the billing states keep their action slot at the
shared action height whether or not an action is resolved yet. Below the card's
640px breakpoint the body is a column, so a late action row would add its own
height plus the container gap. Do not pay for either reservation on rows the
asynchronous read cannot introduce, such as the supporting line of a notice that
never carries one.

### Keep the frame mounted

Choose the geometry before the first asynchronous read completes and keep one
outer DOM frame mounted for the lifetime of that card occurrence. Loading,
ready, refreshing, error, unavailable, completed, and retry states replace only
the frame's contents. Do not return `null` for a missing or failed resource after
reserving its card slot; show an inert unavailable or retry state inside the
same frame. Transcript insertion, removal, and folding remain owned by the
transcript, rather than by a card's resource-loading state.

Equal heights before and after loading are insufficient if React replaces the
entire sized element. The intermediate removal can temporarily collapse the
transcript and make WebKit clamp its scroll position. A persistent parent frame
prevents that collapse even while its children are replaced.

Use `ConnectorAccountActionCard` in
`turbo/apps/platform/src/views/okou-page/connector-account-action-card.tsx` as
the reference for asynchronous action cards. Its outer frame stays mounted
while the content component handles every loading and action state:

```tsx
return (
  <ChatCard className="h-[136px] w-full sm:h-[88px]">
    <ConnectorAccountActionCardContent signals={signals} />
  </ChatCard>
);
```

`ChatCard` supplies the shared surface styling; it does not currently enforce
height or retain a frame across conditional component branches. Each card owner
must satisfy those layout requirements. `min-height`, equal-sized skeletons in
separate branches, and retaining the last resolved data do not establish this
contract by themselves.

### Reserve the contents and preview geometry

- Allocate bounded title, summary, status, and action areas within the frame.
  Showing a spinner, an account label, a reset time, a new action, or a terminal
  status must not add height or remove the reserved action area.
- Permission requests share the connector action card dimensions: 88px high
  when the chat container is at least 640px wide, and 136px otherwise. Keep
  permission scope and controls in that frame, with one compact line for an
  error or expiry when present. Do not reserve extra blank status rows or grow
  the frame; full explanations and expiry details remain in the details dialog.
- Keep long text and translated copy within their allocated rows. Do not let
  overflowing descendants enlarge the transcript's scrollable area. Full
  descriptions and diagnostics belong in an accessible dialog, popover, or
  detail sidebar. Required action controls, account identity, permission scope,
  and confirmation information must remain readable and reachable; clipping
  them is not a valid way to achieve fixed height.
- Forms, account lists, raw error details, and expanded document content open
  outside the transcript card. Do not expand the card inline for these details.
- Media cards may derive their height from a reserved width and aspect ratio.
  The frame, including any fixed header, must exist before a thumbnail, image,
  video metadata, or iframe loads. Loading and error content occupies that same
  frame; natural resource dimensions must not resize it.

For preview geometry, follow `AttachmentCardArtwork` and
`HtmlSitePreviewCard` in
`turbo/apps/platform/src/views/okou-page/attachment-preview.tsx`. They reserve
the artwork or preview area and place changing content inside it. Reading the
full document or interacting with a page happens in the existing viewer.

`ChatCardDetails` provides the shared dialog for banking account selection and
confirmation, permission explanations, credit checkout options, and a raw
provider error whose Markdown body cannot fit a notice row. A card whose
recovery is a single control resolves it in place instead: failure recovery and
the model-provider notices put their reset, retry, model, settings, and
new-session controls in the card's own action slot, and no dialog restates the
headline the card already shows. Banking keeps its connection polling owned by
the card even when the dialog is closed. Preserve those action and lifecycle
owners when adding another state.

Current frame owners are `AssistantErrorContent` (including billing),
`ConnectorActionCard`, `PermissionActionCard`, `BankingActionCard`,
`MailDraftCard`, and `BrowserSessionCard`. Their asynchronous subscriptions live
inside the sized parent. Browser cards reserve both the 40px header and 16:10
preview in the parent, independently of the replaceable preview content.

### No content-size observation or compensating scroll

Do not introduce `ResizeObserver`, DOM-mutation observers, or timer/frame loops
to watch card or transcript content dimensions and repair scrolling afterward.
Do not fix a card's asynchronous height changes by adding
`withChatScrollLayout` or calling `restoreScrollPosition$` after each update.
The card must preserve its geometry and mounted frame directly.

The transcript continues to own scrolling for new messages, navigation,
explicit folding, and viewport or composer layout changes. Those existing
layout causes do not relax the fixed-height contract for cards. A user already
following the latest message must stay at the bottom, and a user reading
history must retain their position, without card-specific scroll correction.

### Verify state transitions

Exercise delayed resource responses, errors and retries, unavailable resources,
action completion, and background refresh. At each supported layout width,
verify that the same outer DOM frame remains mounted, its height is unchanged,
and its contents and actions stay within the reserved geometry.

Browser verification must also check the observable scroll result: the bottom
gap and bottom-arrow control for a reader following the tail, and the visible
message position for a reader reviewing history. Cover cold and warm thread
navigation, long text, narrow layouts, and WebKit as well as Chromium. Checking
only CSS classes or final dimensions misses the transient-collapse failure.
The manual preview regression in
`e2e/playwright/regressions/connector-card-scroll.ts` provides an existing
example of browser scroll verification for the persistent-frame pattern.

`e2e/playwright/regressions/chat-card-scroll.ts` covers recovery, connector,
mail, browser, banking, and permission cards in both engines, at desktop and
mobile widths, at the bottom and while reading history. Run it against a
prepared preview thread using private authenticated storage state:

```sh
cd e2e
pnpm exec tsx playwright/regressions/chat-card-scroll.ts \
  <app-origin> <api-origin> <thread-id> <storage-state.json> <output-dir> \
  recovery 1
```

The thread must overflow by at least 240px. Choose the appropriate card-family
argument and count, and use fixtures with ready or unavailable resources as
needed. The script holds matching GET responses, preserves them unchanged,
then checks card geometry and reading position after release. It
saves geometry only. Exercise action dialogs and their completed/error states
in the page integration tests and in preview acceptance as well; this read-only
loading regression does not authorize or execute those actions.

## Failure Recovery Classification

The authoritative error category for a failed run is its optional
`failureReason` Chat Event field, persisted as `failure_reason` in storage. When
the field is present, consumers must use it to select recovery behavior. They
must not classify, replace, or override the category by matching the rendered
`error` text, even when the reason is newer than the consumer's known taxonomy
or does not select a recovery card. An unknown or non-recovery reason therefore
fails closed instead of falling through to text classification.

Text-based error classification is a legacy compatibility path. It may run only
when `failureReason` is absent, which represents a historical event or a run
completed by an older sender. After a structured reason has selected a recovery
kind, the error text may still provide secondary presentation details such as
the framework, model, usage window, reset label, or failed model. Raw masked
error text also remains available for diagnostics, display, and integrations;
none of those uses make it a classification authority.

New error types must be classified at the authoritative guest or runner
boundary and propagated through `failureReason`. Do not add a downstream error
text matcher as the normal implementation of a new recovery category. See
[Chat Event schema versioning](./chat-event-schema-versioning.md#optional-v7-failure-reasons)
for the transport and rollout contract.

## Recognized Link Shapes

The body parser accepts platform links in common message forms:

```markdown
https://app.okou.ai/agents/c0000000-0000-4000-a000-000000000001/permissions?connectorSlug=slack&permission=messages.write

[Review permission](https://app.okou.ai/agents/c0000000-0000-4000-a000-000000000001/permissions?connectorSlug=slack&permission=messages.write)

/computer-use/authorize/request-token
```

Absolute URLs must use an allowed Okou platform origin. Relative paths resolve
against the configured platform origin. A URL becomes a card only when its path
and required parameters match a card parser exactly. Unrecognized links remain
ordinary Markdown. Recognized connector and permission actions are different:
their URL targets are untrusted claims and must match the authenticated chat
thread's agent and optional callback thread. A mismatch renders an inert
unavailable card instead of a link or command.

Current link-backed card patterns include:

- `/connectors/:connectorSlug/connect` and
  `/connectors/:connectorSlug/authorize`
- `/connectors/custom/proposal?p=...`
- `/agents/:agentId/permissions?...`
- `/agents/:agentId/connector-accounts/:connectionId/select?...`
- `/computer-use/authorize/:requestToken`
- `/?settings=billing&billingView=plans`
- `/mail/drafts/:mailDraftId`
- `/browsers/:threadId`
- platform artifact URLs such as legacy `/f/...` and `/artifacts/.../.../...`
  paths, plus hosted site URLs that support a preview. Flat V2 artifact
  paths such as `/artifacts/97ngzkxdyn.mp4` require a complete URL with an
  allowed Okou origin.

Recognized billing-plan links render as rich upgrade cards.

On eligible assistant-message lines, each action link is recognized independently
even when another action or an ordinary link shares the line. Explanatory prose,
formatting, and ordinary links stay in place; action-link labels stay in the
sentence and the cards follow it in source order. A standalone action still
renders only its card. Raw action destinations are removed from retained prose,
including invalid actions that render as unavailable. Code spans, fenced and
indented code, image destinations, and Markdown table rows remain content.
Every action retains its own origin and chat-context validation.
Bare action URLs stop before adjacent prose punctuation, and retained labels
stay literal text or keep their original inline formatting. For indented or
quoted content, Markdown block tokens distinguish code from nested list prose;
indentation by itself does not disable an action.
Blocks containing a multiline code span are recognized together, so URLs inside
the span remain code while real actions beside it follow the intact block.
Existing character references in retained link labels keep their displayed text.

Artifact recognition does not choose its presentation. After Markdown parsing,
each supported artifact `<a>` or `<img>` node registers its URL in the owning
thread's artifact registry and receives the same `ArtifactSignals` object as
other occurrences of that URL. Its original tag and label remain on the node:

- `[label](url)` and bare URLs parsed as links remain text links. A normal click
  opens the artifact's existing lightbox or active split view; modified clicks
  retain native link navigation.
- `![label](url)` renders an image or the resource's corresponding preview card.
- URLs inside code remain code. Artifact recognition does not rewrite source
  lines, discard surrounding prose, or turn fenced hosted-site URLs into cards.

Resource state does not contain a link/card presentation flag. The same image
can appear as a link and a preview in one event while sharing its resource URL
and load state. Artifacts carried out of folded work history retain their
original nodes, so folding does not change links into cards.

CLI artifact producers return `inlineMarkdownLink`, `previewMarkdownBlock`, and
`artifactPresentationContext` alongside successful JSON results. Text output
shows the same forms and explains their presentation. This applies to file
uploads, hosting, built-in image/video/voice/avatar generation, completed social
downloads, and internal Intro Video media. The forms use the stable artifact
reference; an image's HTML embed URL has a separate authoring purpose. Pending
Intro Video jobs return continuation guidance until a completed artifact exists.

Image batches keep their authoring assets in `results.tsv` and record stable
chat references plus both Markdown forms in `artifacts.json`, outside the
authored bundle. `okou generate image-batch wait --json` returns this metadata.
Persisted batches without that optional metadata remain readable through their
TSV and provide upload guidance for selected local files.

A path such as `/chats/:threadId` can use the same design when a chat-thread
card is introduced: add an exact parser for the path, derive a canonical
resource key, define the card's signals and registry, and add its render case.
The generic URL parser must not treat every `/chats/*` link as a card before
that card type exists.

## Producing User-facing Action URLs

CLI producers must complete the action path and every action-defining query
parameter before calling the shared action URL finalizer. For callback-capable
actions, the finalizer appends `threadId` and then terminal `callbackPrompt`
and returns the serialized URL. Callers must not append fields after that
boundary.

The CLI handoff output and run-level Agent Tools prompt require agents to return
user-facing action URLs exactly as printed. Agents must not rewrite, shorten,
reconstruct, or omit query parameters. Consumers continue to treat URL fields
as untrusted claims: an incomplete or context-mismatched mutating action fails
closed, and the parser must not infer missing authorization or target data.

## Data Flow

### 1. Parse content into pure descriptors

`chatEventTreePlan` extracts renderable content from a `ChatEvent` and passes it
to `eventBodyPlan`. The parser separates normal Markdown from recognized cards.
Artifact occurrences are recognized on the parsed Markdown tree instead of
being converted to action slots by this scanner. The current thread ID and
server-derived primary agent ID are supplied as
immutable planning context. Parsing is synchronous and does not query an API or
database.

A recognized card is first represented as a pure `ParsedBodyBlock`:

```ts
type ParsedPermissionBlock = {
  type: "permission-action";
  resourceKey: string;
  descriptor: PermissionActionDescriptor;
};
```

The descriptor contains parsed domain data only. It must not create `state`,
`computed`, `command`, subscriptions, or other runtime resources. This keeps
parsing deterministic and safe to run for persistent, IndexedDB, realtime, and
optimistic messages.

Connector and permission descriptors are created only after their URL agent ID
matches the context agent ID and any callback contains both a non-empty prompt
and the context thread ID. Valid descriptors use the context identities rather
than copying URL claims. Recognized context-invalid actions produce only a
static unavailable descriptor, so they register no action signals and cannot
fall back to a clickable Markdown slot.

### 2. Derive a stable resource key

Every card type defines the identity of the resource it represents. Examples
include an artifact URL, a normalized permission URL, or a computer-use request
path.

The resource key has two jobs:

- repeated cards for the same resource reuse one signals object within a
  thread;
- the render layer combines it with the card type and occurrence index to
  produce a stable React key for each rendered occurrence.

The key should represent domain identity, not message identity. URL forms that
refer to the same resource should be normalized before they are used as a key.

### 3. Register signals before transcript rendering

Each chat thread creates one independent registry for each card type. When a
message enters the transcript through a command or another write boundary,
`create-chat-thread.ts` dispatches each parsed block to its matching registry.

Conceptually, a registry performs:

```ts
interface PermissionCardSignalsRegistry {
  register(descriptor: PermissionActionDescriptor): PermissionSignals;
  resolve(resourceKey: string): PermissionSignals;
}
```

`register` creates the signals object once or returns the existing object for
the resource key. `resolve` only returns a previously registered object and
fails if registration was skipped.

Persistent messages, IndexedDB messages, realtime messages, initial optimistic
messages, and newly appended optimistic messages all register their card
signals before transcript projection. Transcript recomputation therefore does
not allocate new signal identities.

### 4. Produce a render block

Registration replaces the descriptor with the stable signals object:

```ts
type PermissionRenderBlock = {
  type: "permission-action";
  resourceKey: string;
  signals: PermissionSignals;
};
```

`create-chat-thread.ts` contains the body-block type dispatch, but it does not
own an aggregate card registry. Artifact, connector, custom connector,
permission, and computer-use authorization cards each keep their own typed
registry and resource model.

### 5. Render the matching React component

`MarkdownCardView` in
`turbo/apps/platform/src/views/okou-page/chat-body-cards.tsx` renders action
slots and explicit artifact preview cards. Artifact links and image tiles use
their original Markdown renderers and read the same signals. For a card,
the renderer selects the component by its discriminated `kind` and passes the
signals object directly:

```tsx
case "permission-action": {
  return <PermissionActionCard signals={card.signals} />;
}
```

The component reads computed values with ccstate React hooks and invokes
commands in response to user events. It does not parse the original URL, look
up a registry, or create signals during render.

## Registry Ownership and Lifetime

Card registries are owned by the chat thread that created them. Their maps are
not module-level caches and are released with the thread.

This gives the model the following properties:

- two occurrences of the same resource in one thread share state;
- separate threads have isolated signal identities;
- transcript recomputation does not cause resubscription or reload flicker;
- registry growth is bounded by the resources referenced by the owning thread;
- each card type can evolve its descriptor and signals without forcing other
  card types into a shared data structure.

The registry implementations may share small stateless map helpers, but there
is no common registry object or universal card signals interface.

## Examples

### Simple: computer-use authorization

A computer-use authorization link matches:

```text
/computer-use/authorize/:requestToken
```

Its descriptor contains the request token, original URL, and normalized `href`.
The current signals type is the descriptor itself because the card does not
need additional ccstate resources:

```ts
type ComputerUseAuthorizationSignals = ComputerUseAuthorizationDescriptor;
```

The registry still provides stable resource identity and keeps this card on the
same lifecycle path as more stateful cards.

### Read-only asynchronous data: artifact preview

An artifact URL produces an `ArtifactDescriptor` with `filename`, `url`, and
`kind`. Image, video, audio, PDF, and HTML previews can render directly from
that descriptor.

Text and JSON previews add an asynchronous computed resource:

```ts
interface ArtifactSignals extends ArtifactDescriptor {
  readonly text$?: Computed<Promise<string>>;
}
```

The component receives `text$`, renders its loadable state, and displays the
resolved preview. Repeated previews of the same artifact URL share the same
computed identity within the thread.

### Stateful action: connector card

A connector link such as:

```text
/connectors/slack/connect?agentId=agent-123
```

produces a descriptor containing the connector slug, agent ID, and
original URL. Its signals combine several reactive reads and an action:

```ts
interface ConnectorSignals extends ConnectorActionDescriptor {
  catalogItem$: Computed<Promise<PublicConnectorCatalogStatusItem | null>>;
  available$: Computed<Promise<boolean>>;
  connected$: Computed<Promise<boolean>>;
  authorized$: Computed<Promise<boolean>>;
  complete$: Computed<Promise<boolean>>;
  activate$: Command<Promise<void>, [AbortSignal]>;
}
```

The React card can show whether the connector is available, connected, and
authorized, then invoke `activate$` from a user action. All occurrences of that
connector `resourceKey` in the thread observe the same computed graph.

### Complex shared data: permission card

A permission URL matches `/agents/:agentId/permissions` and encodes the
connector, permission, action, optional request metadata, and expiration in its
query parameters.

The resulting signals include:

- `agent$` for agent presentation data;
- `grants$` for the user's current permission grants;
- `metadata$` for the connector permission catalog;
- normalized descriptor fields used to apply the allow or deny action.

Permission changes can arrive from another card or another product surface. A
user-level realtime event invalidates the shared grants source, so mounted
permission cards refresh without replacing their signals identities.

### Confirmed action: connector account switch

A connector account switch URL matches:

```text
/agents/:agentId/connector-accounts/:connectionId/select
  ?kind=builtin
  &connectorSlug=github
  &threadId=:threadId
  &callbackPrompt=:prompt
```

Custom connectors use `kind=custom` and `customConnectorId` instead of
`connectorSlug`. The parser requires exactly one well-formed target, the chat's
server-derived agent ID, and a callback bound to the current thread. These URL
values are untrusted claims. Before reading the account, the card resolves the
current agent's connector authorization and rejects an unauthorized target.
It then reads the exact account from the API and uses only the live account
metadata plus the current catalog or custom-connector metadata for presentation,
including the connector's own icon. If that presentation metadata cannot load,
the card keeps the account action available with the standard connector fallback
icon. A missing, cross-owner, wrong-target, or unauthorized account renders an
inert unavailable card.

Confirmation writes the exact account selection to the current thread before
starting the callback round. The selection endpoint resolves the externally
managed account reference again, so an account that was removed, reconnected,
or otherwise became invalid after the card loaded fails closed. A failed write
does not run the callback. A successful write updates only the sparse thread
override used by future runs; it does not mutate the global default or the run
that produced the card.

Repeated occurrences of the same action share one signals object. The card also
reads the composer's shared connector authorization and connector-account
preference state, so local confirmation and thread-detail realtime events
update every mounted occurrence. The action is gated by `ConnectorAccounts`;
older frontends that do not know the card continue to render the emitted
Markdown link.

### Provider-backed resource: Gmail draft

A mail link matches `/mail/drafts/:mailDraftId`. The mail-draft UUID is the
stable resource key; Gmail draft, thread, and message IDs remain provider
metadata and are not inferred from Gmail Web URLs. The thread-scoped signals
read the Gmail draft through one reloadable Okou Mail API computed. Repeated
card occurrences and the detail sidebar share that computed, while Send and
Delete invalidate it after their mutations complete.

The fixed-height card displays the Gmail identity, subject, sender, and
`Draft`, `Sent`, or `Deleted` status. Draft and Sent cards open the shared right
sidebar surface. Deleted cards retain their summary but are not interactive.

### Provider-backed live resource: managed browser

A managed-browser link matches `/browsers/:threadId`. The chat thread ID is the
canonical resource key: each thread owns at most one logical browser, and every
provider instance for that browser carries the same thread attribution. The card
never accepts a Browser Use `liveUrl` or CDP URL from message content. Instead,
its thread-scoped computed reads the browser through
`/api/chat-threads/:threadId/browser`. A copied card therefore cannot resolve a
browser owned by a different thread.

The message card follows the presentation and website preview treatment. It
shows a `Cloud browser` header with a simplified `Live` or `Stopped` status,
then a `16:10` static preview of the latest foreground tab at up to `400px`
wide. The preview fills its frame and stays aligned to the top, with a
placeholder until the first screenshot is available. The whole card opens the
shared right sidebar surface; it does not show browser-specific metadata or
charged credits. The live page remains in that sidebar and in the full-page
route rather than in the message stream, because it resizes as it loads and
would otherwise shift the transcript.

A provider instance outlives the run that opened it. Every terminal run callback
only extends the instance's idle lease, so the user can keep working in the same
window and a later run in the same thread attaches to it with
`okou browser use`. The reconciler reclaims an instance once its lease expires,
its hard timeout is reached, or the provider ends it. Deleting a chat thread
also reclaims its browser. While the sidebar or full-page viewer is open
and its page is visible, it refreshes the lease on a timer; the CLI can do the
same with `okou browser lease`. Each lease is a fixed window from now and cannot
be stacked. The once-per-minute reconciler captures the foreground tab of each
healthy active browser as a `640px`-wide WebP, preserves its aspect ratio, and
replaces the thread's previous immutable preview object. Viewer lease
heartbeats do not capture screenshots, and screenshot failure does not affect
the browser lease.

Starting or resuming appends a payload-free `browser.open` chat event; clicking
the sidebar close button appends a payload-free `browser.close` event without
stopping the provider instance. Automatic reclamation for an existing thread
also appends `browser.close` without inspecting the current sidebar state. The
frontend supplies each mutation's event UUID so it can optimistically
project the same event without duplicating it when the server response or
realtime delivery arrives. Folding these events in order yields the thread's
browser sidebar state. Opening a thread waits for the authoritative initial
event page before using that projection to auto-open the sidebar, so stale
IndexedDB events cannot override a later server close. A `browser.open`
projection opens the sidebar only when no other utility sidebar is already open;
a later `browser.close` projection does not auto-open it. The browser icon in
the thread header remains available in either state, and both a never-created
browser and a non-live browser keep the Start action. When a screenshot exists,
the suspended sidebar reuses it at full width and top-aligns it beneath a
half-transparent blurred mask, so the small preview fills the available surface
without being presented as a live browser.

Once an instance is reclaimed, the viewer keeps the stable
`/browsers/:threadId` link. Its Start action, and `okou browser use` in a later
run, create a new provider instance from the thread's saved profile: cookies and
storage come back, and saved HTTP(S) tab URLs are reopened on a best-effort
basis. Provider state changes publish a user-scoped realtime event carrying the
canonical thread ID so the card, sidebar, and full-page viewer refresh together.

Each thread owns an isolated login profile. Multiple threads may run provider
instances in parallel up to the organization's run concurrency entitlement.
Before starting another provider instance, the API reclaims the active browser
with the earliest idle lease until a slot is available. Provider stop requests
are best-effort and do not delay the new start. The API serializes each thread's
first profile creation so concurrent first use still creates one provider
profile for that thread.

The same universal link also has an authenticated full-page route. The browser
provider's CDP URL is reserved for the Okou CLI to connect `agent-browser` and
is never returned by the card read, lease, or resume endpoints, nor printed in
CLI output.

## Adding a Card Type

When adding a new link-backed card:

1. Define the accepted origins, exact path pattern, required parameters, and
   parser validation.
2. Define a pure descriptor and canonical resource key.
3. Add a distinct parsed-block and render-block variant.
4. Define the card-specific signals interface and factory.
5. Create an independent, thread-scoped registry for that card type.
6. Add the registration and resolution cases to the body-block dispatcher.
7. Add the React component case and pass only the typed signals object.
8. Define and retain the card's outer geometry across every asynchronous and
   action state, following [Fixed Height and Stable Layout](#fixed-height-and-stable-layout).
9. Cover absolute, relative, and Markdown link forms that the card accepts.
10. Test repeated-resource sharing, persistent and optimistic message paths,
    loading and mutation behavior. Define explicitly whether invalid recognized
    links remain Markdown or render inertly; mutating actions must fail closed.

Do not create signals in the parser, transcript computed, or React component.
Do not use a root-lifetime URL cache. Do not add a card to a shared aggregate
registry.

## Relevant Implementation Files

- `turbo/apps/platform/src/signals/chat-page/chat-event-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/chat-action-context.ts`
- `turbo/apps/platform/src/signals/chat-page/parse-body-blocks.ts`
- `turbo/apps/platform/src/signals/chat-page/create-chat-thread.ts`
- `turbo/apps/platform/src/signals/chat-page/artifact-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/markdown-artifacts.ts`
- `turbo/apps/platform/src/signals/chat-page/connector-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/connector-account-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/permission-action-block.ts`
- `turbo/apps/platform/src/signals/chat-page/permission-card-signals.ts`
- `turbo/apps/platform/src/signals/chat-page/mail-draft.ts`
- `turbo/apps/platform/src/signals/chat-page/browser-session-block.ts`
- `turbo/apps/platform/src/signals/chat-page/platform-action-url.ts`
- `turbo/apps/platform/src/signals/chat-page/computer-use-authorization-block.ts`
- `turbo/apps/platform/src/signals/chat-page/plan-upgrade-block.ts`
- `turbo/apps/platform/src/views/okou-page/chat-thread-page.tsx`
- `turbo/apps/platform/src/views/okou-page/browser-session-card.tsx`
- `turbo/apps/platform/src/views/okou-page/connector-account-action-card.tsx`
- `turbo/apps/platform/src/views/okou-page/chat-body-cards.tsx`
- `turbo/apps/platform/src/views/browser-session/browser-session-page.tsx`
