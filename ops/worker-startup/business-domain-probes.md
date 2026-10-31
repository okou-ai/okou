# Business-capability Worker probes

This extends the opt-in [nine-role dependency experiment](nine-workers.md). The
business capability comes first; a protocol adapter or runtime container is not
itself a business owner. These roots are **partial build probes, not a complete
replacement fleet, native routing configuration, or deployment approval**.

## Scope

| Probe     | Selected HTTP registrations | Capability surface                                                                                            |
| --------- | --------------------------: | ------------------------------------------------------------------------------------------------------------- |
| Threads   |                          44 | Conversation entities, thread-scoped reads, snapshots, metadata, relations, artifacts, selections and sharing |
| Chat      |                           4 | Send/revoke input, global catch-up/search and input status                                                    |
| Runs      |                           7 | Run reads, queue inspection and cancellation                                                                  |
| Agents    |                          16 | Agent configuration, drafts, instructions and associated access/setup                                         |
| Workflows |                          23 | Workflow definitions and automation configuration/execution                                                   |

The five probes select **94 of 706** current method/path registrations, without
cross-probe duplicates. They reuse leaves from 14 of 239 aggregate groups. The
remaining **612 registrations / 225 groups are baseline-only**, not silently
assigned to a new fallback. Internal Runner callbacks, source events, cron,
billing, auth, organization, connector and other platform capabilities are not
claimed as complete domain ownership here.

The aggregate and original nine roles remain available with their existing
ownership. Default `build:worker` still produces the complete API. Node/Vercel,
production routing/release/rollback, cron and Worker activation are unchanged.
The experiment branch still skips only its auxiliary Worker preview deployment;
types, contracts, all experimental builds, Vercel and App checks remain enabled.

## Canonical leaves, not copied implementations

`signals/routes/chat-threads.ts` remains the ordered 39-entry compatibility
aggregate. Its previously inline entries now live in independently importable
thread-read, snapshot, detail, artifact, indicator and global Chat leaves. The
agent list has a single canonical `agents-list.ts` entry, spread in its original
position by `agents.ts`.

MCP imports only the canonical leaves it needs, instead of importing complete
agent/thread collections and applying a runtime allow-list filter. The **14
backing dispatch entries** retain their original filtered order; the unchanged
SDK adapter advertises **13 tools**. MCP-specific search presentation stays
separate from ordinary Web search. Other MCP routes and their auth wrappers are
the same route-entry objects used by Web, not reconstructed handlers.

This refactor does not move transaction or business-effect ownership. Contracts,
URLs, validation, capabilities/scopes, queue claiming, cancellation/completion
ordering and uncertain-outcome semantics stay unchanged. There is no new RPC,
MQ, proxy-to-monolith gateway, hostname or business stub.

The nested MCP request still uses `app-factory-core` and its real completion
registration with the operation signal and a fresh Store. Threads, Chat, Runs and
Workflows probes also install the real finished-event dispatcher. Agents uses
the existing no-services command only while the emitted audit confirms that the
completion dispatcher is unreachable. Removing a required registration to make
a bundle smaller is not an accepted optimization.

## Build and validation

From `turbo/apps/api`:

```sh
pnpm build:worker
pnpm build:worker-roles
pnpm build:worker-domains
node scripts/build-worker.mjs --domain threads
pnpm test:worker-build
pnpm check-types
```

Domain outputs live under `dist-worker-domains/<domain>/` with JavaScript,
source map, esbuild metafile and an `audit.json` explicitly marked
`partial-business-domain-probe-not-a-fleet`. Invalid/empty domain selections and
mixed role/domain selections fail closed. A failed build removes selected
outputs instead of leaving stale artifacts.

Static guards validate exact root imports, leaf composition, real initializer
selection, selected registration membership/order and MCP tool composition.
Emitted guards reject the complete aggregate route table, unregistered reachable
completion dispatch and non-native external packages. New roots belong only to
the existing Worker typecheck program; no route handler is executed by these
static checks.

## Source ownership is not a native route map

The probes are not installed as Cloudflare routes. Native routing cannot select
by HTTP method or an arbitrary suffix after a dynamic ID. Thread-scoped message
reads stay with the Thread surface, while global search/catch-up stay with Chat.
The historical input-status URL remains under `/api/chat-threads/:id/...` even
though its capability is exercised by the Chat probe; this must be resolved by
co-placement/capability composition before any native owner map is accepted.
The old ancillary `/api/indicators` and `/api/chat-thread-drafts` URLs remain.

No assertion in this experiment claims full route coverage, native prefix
compatibility, real-binding business acceptance or a safe fleet rollout. A
future complete design must classify the omitted capabilities and preserve
transaction/effect ownership before choosing physical process boundaries.

## Measurement limits

A build, bundle size, retained-module count, local workerd check or green CI is
not a Cloudflare startup result. The prior measurements for `656232fd` predate
this source extraction and the merge of main; they must not be relabeled or
pooled with these artifacts.

A fresh startup experiment needs frozen source/tree and bundle/fixture hashes,
new owned temporary resources, current provider authorization, predeclared
criteria, interleaved same-batch controls and preserved CPU refusals. It must
leave candidate versions inactive, disable public/preview URLs, avoid production
writes and business requests, and delete the temporary Worker with settings404
readback. Until that happens, no startup improvement or budget pass is claimed.
