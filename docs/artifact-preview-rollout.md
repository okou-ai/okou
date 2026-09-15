# Private site/video previews and short Public file links

Part of [#32492](https://github.com/vm0-ai/vm0/issues/32492).

## Behavior

- Completing a private hosted deployment with a run artifact schedules the
  existing Cloudflare Browser Rendering screenshot job. It obtains an isolated
  owner preview origin for that exact deployment and writes a WebP to private
  artifact storage. Only the stable private reference enters the catalog and
  thread metadata. Rendering failure leaves the existing live-preview fallback.
  A flag change during rendering cannot publish private screenshot bytes.
- Completing a new private MP4 upload or managed generation with a run artifact
  schedules a poster from the first second at 640 pixels wide. The API checks
  the stored file's owner and organization, then writes a five-minute capability for that exact
  object into private R2. It sends the capability only in an Authorization
  header on a POST to the host Worker. The `MEDIA` binding reads private bytes
  directly; no source URL or automatic derivative cache is involved. The API
  deletes the capability after success, failure or cancellation, and stores the
  JPEG as a stable private reference. A process interruption can leave an expired,
  unusable grant record. Changing the creation flag never makes the poster public.
  The POST carries the configured App origin as its Referer, matching the
  first-party exemption in the `okou.app` WAF read on 2026-09-15. The capability
  independently authorizes extraction. No WAF rule change is included.
  Chat cards resolve that reference and open the original video on click.
  Inputs must be MP4/H.264, below 100 MB and within the provider's ten-minute
  duration limit. Unsupported inputs and renderer failures retain the existing
  playable video fallback. Existing private videos are not backfilled.
- Public **file** shares allocate ten lowercase alphanumeric characters, with
  atomic delivery registration and at most ten collision attempts. Legacy files
  and new publications share one namespace; registration determines ownership.
  Repeated Public updates retain the active URL; revoking and republishing
  creates a new token. Existing 24-character URLs remain valid until revoked.
  Organization references, named Public sites and shared-thread resource tokens
  keep their current formats. The existing `privateArtifacts` switch owns new
  private artifacts/shares; no additional switch is introduced.
- Image cards request `?thumbnail=1&width=800&height=720&fit=scale-down&quality=85`
  on the file URL. Production and test hostnames use the same Worker path. It
  reads the current publication (or parent thread) policy **before** looking up
  transformed bytes, then uses the Cloudflare Images binding on private R2 bytes.
  Neither a public source URL nor an external Image Resizing derivative cache is
  involved. Immutable source keys and normalized options separate cached images
  from original downloads and other snapshots. The file viewer opens the original.
- Standalone Public thumbnails use `private, no-store`. Revocation, organization
  audience, missing policy and unavailable policy deny subsequent network
  requests, including cached thumbnails and HEAD. An already authorized request
  can finish, and downloaded bytes cannot be recalled. Shared-thread resources
  retain their existing private browser cache contract. Legacy public images
  retain one-year public caching and their original download URLs.
- The binding outputs WebP, limits dimensions to 2048 and accepts inputs up to
  20 MB. Unsupported formats (including SVG) and larger inputs return the
  authorized original. Transform failures remain errors. No public-copy fallback
  is added. No historical screenshot backfill is performed.

## Required deployment order

This change is not ready for production activation from a code merge alone.
On 2026-09-15 a read-only check found the live `a.okou.io` cache override excludes
only 24-character file names. Ten-character shares would otherwise receive a
one-year cache override, defeating revocation.

1. Deploy the host Worker reader and its `IMAGES` and `MEDIA` bindings in
   `wrangler.jsonc`.
   Verify legacy files, GET/HEAD/Range, Image Resizing and private previews on the
   actual deployment. Preserve the R2 custom domain and existing registration.
2. Before any API emits ten-character shares, update the existing `a.okou.io`
   cache rule below. Read back the rule and verify cold and warm legacy files
   still receive `public, max-age=31536000, immutable` from the Worker. Do not
   apply this exclusion while short legacy files are still delivered directly
   from R2, whose objects may lack origin cache headers.
3. Deploy the API and App only after the Worker and cache rule are verified.
   Keep the shared switch off for general users; use the existing authorized
   test cohort to verify a new ten-character Public PNG, its thumbnail, HEAD,
   original download, warm cache, revoke, organization audience, and republish.
   Repeat with a retained 24-character link and a legacy ten-character file.
   Verify private hosted screenshots, a new deployment version, and flag-off
   access to already-created screenshots and video posters. Verify a private
   generated MP4 and upload, successful grant cleanup, and failed/expired grants.
   Browser Rendering, Images and Media Transformations must be enabled on the
   deployed account; mocks do not prove those services.
4. Do not restore the old cache expression once ten-character shares exist.
   Any Worker rollback must retain policy-aware ten-character readers and
   response headers. API rollback can stop new creation, but it must not turn
   existing registrations into anonymous public objects. Old API readers may
   reject new policies during a rollback; keep the test cohort closed until
   compatible API readers are restored.

### Exact cache rule change

Zone `okou.io`: `07c2ef7906d26104fe345d5942e0732e`.
Ruleset: `200c70c98b854db79feaf13d084857d2`.
Rule: `d2d1fdfa9bcf4b378de11b8cd75ffb1e`.

For an authorized infrastructure rollout, first GET the current ruleset and
preserve every other rule and the selected rule's action parameters, enabled
state, ref and position. PATCH only this rule's expression through
`/zones/<zone>/rulesets/<ruleset>/rules/<rule>` using the current rule properties.
The replacement expression is:

```text
(http.host eq "a.okou.io" and not ((len(http.request.uri.path) ge 13 and len(http.request.uri.path) le 24 and substring(http.request.uri.path, 11, 12) eq ".") or (len(http.request.uri.path) ge 27 and len(http.request.uri.path) le 38 and substring(http.request.uri.path, 25, 26) eq ".") or (starts_with(http.request.uri.path, "/artifacts/") and len(http.request.uri.path) ge 23 and len(http.request.uri.path) le 34 and substring(http.request.uri.path, 21, 22) eq ".") or (starts_with(http.request.uri.path, "/artifacts/") and len(http.request.uri.path) ge 37 and len(http.request.uri.path) le 48 and substring(http.request.uri.path, 35, 36) eq ".")))
```

These bounded path shapes cover ten- and 24-character basenames with 1–12
extension characters, before and after the existing `/artifacts/` rewrite.
Queries, including thumbnail options, cannot escape the exclusion. Preserve the
existing error-response no-cache setting and unrelated CDN/static rules.
The canonical path check in the Worker still rejects alternate encoded or
trailing-slash paths for publication records. This PR does not apply the live
rule or modify production feature switches.

## Compatibility and acceptance

The maintainer's existing-link requirement for #32492 owns the retained
24-character readers and the legacy ten-character path. Neither can be removed
without accounting for retained links. URL-only code cannot identify a
publication from a ten-character basename: the immutable delivery registry
must make that decision. The existing catalog/public-object key helpers still
operate on registered source-file records, not share policy URLs.

The original-image fallback for formats/size outside the binding's documented
limits is a reachable input, owned by #32492 until the renderer supports those
inputs. Private screenshot rendering reuses the existing temporary owner grant
lifetime and cleanup policy. The existing playable-video fallback covers
unsupported containers, oversized inputs and rendering failures; #32492 owns
broader poster support. Remove that branch only when those inputs have another
supported preview. This change does not expand retention cleanup, provider
ingestion or historical registration work.

[Cloudflare Images binding API](https://developers.cloudflare.com/images/optimization/binding/).
[Cloudflare Media binding API](https://developers.cloudflare.com/stream/transform-videos/bindings/).
Local route/Worker/page tests check behavior with external services mocked.
Production service availability, real image fidelity and regional cold/warm
latency remain deployment acceptance checks; no latency target is inferred from
local test timings.
