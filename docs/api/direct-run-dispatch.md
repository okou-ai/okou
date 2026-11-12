# Direct Run dispatch

New Runs retain their ordinary Run, billing attribution, diagnostics and active
concurrency records. The API prepares their complete `ExecutionContext` within
the launching invocation. It does not insert a Runner job or store a temporary
execution payload in PostgreSQL. Existing content and presigned URL caches keep
their existing purposes.

## Delivery

The API reads one serving fleet snapshot. Candidates must have a recent official
heartbeat, a positive process generation, a canonical public hostname, active
ingress, and the requested profile in `admittableProfiles`. The default profile's
resource values are shared with native code through generated contract constants.
Advertised admission remains authoritative when reclaimable local resources make
the raw free-resource counters zero.

Before contacting a candidate, a conditional Run update binds its exact process
identity and marks it running. The update also refreshes its active owner and
establishes the Thread's first-start binding. Cancellation or replacement of the
expected owner prevents publication.

The request goes to
`POST https://<hostname>/runners/<runnerId>/control/runs/<runId>/dispatch` with
official service authentication and the complete input. The API freezes the
serialized bytes and a 30-second delivery deadline, capped by the remaining
300-second invocation budget with a cleanup margin. Every retry to that process
uses those same bytes and deadline. The receiver's maximum envelope lifetime is
60 seconds and its body limit is 4 MiB.

An accepted reply completes delivery. A definite refusal permits the next
candidate. A preferred process that reports `429 busy` receives bounded jittered
retries within the existing reuse preference's expiry. Other definite refusals
can proceed to another candidate immediately.

A lost response, malformed reply, pending result or other ambiguous observation
pins delivery to the same process. A later `429` cannot disprove an earlier
acceptance. At the original deadline the API stops sending and leaves recovery
to ordinary Run status, completion and finite stale-Run cleanup. It never creates
a replacement Run or moves possibly accepted execution to another process.

## Definite failure and cancellation

Preparation failure, no eligible candidate, or definitive refusal by every
candidate terminates only a Run still held by the expected tenant and owner.
That statement captures terminal billing, cleans eligible diagnostics and
disconnected providers, and releases the active slot atomically. It preserves a
concurrent cancellation. A preselected process that definitely did not accept
has no finalizer to release that slot, even though `startedAt` is already set.

Slot scheduling occurs after the write commits. The queue owner supplies that
operation to the launcher; terminal SQL does not import the queue orchestrator.
The existing cancellation entrypoints preserve this same scheduling order.

## Compatibility and deployment

This change does not add or drop database tables or columns. Existing queued
payloads remain readable through Poll/Claim and their historical decoders. New
Runs are absent from that queue. Acquisition-client retirement, legacy reader
retirement, and destructive schema removal are separate delivery steps.

Deploy serving native processes with the complete-input endpoint before the API
cutover. A fleet with only old, non-serving processes cannot receive new Runs.
Rehearse both new direct execution and draining a pre-cutover job against the
actual deployment artifacts before production release. API network-boundary tests
and native VM-mock tests establish separate parts of this behavior; they do not
by themselves establish a deployed end-to-end result.
