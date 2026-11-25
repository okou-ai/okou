# slack-link-unfurl

## slack-link-unfurl-001

- Vitest: "Slack link previews > adds a divider, linked title and compact image without requiring membership or an Okou user connection"
- Mode: run
- Given: A workspace admin installed the Slack bot with `links:read` and `links:write` and published a public hosted site whose HTML title is `Report & <!channel> "标题"`. The link is posted by a Slack user not connected to Okou.
- When: Slack delivers a signed `link_shared` event to `POST /api/webhooks/slack/events` in channel `C_PREVIEW` with the immutable deployment URL (with query and `#cover|v1` fragment), the site alias `/index.html`, and the immutable URL again.
- Then: The webhook returns HTTP 200. Slack `chat.unfurl` is called exactly once with the bot token for `C_PREVIEW` and the message timestamp, giving each distinct URL a divider, a bold escaped linked title, and a 320x112 compact image of `/api/artifact-og/image?kind=host&id=<deploymentId>` with the unescaped title as alt text. No Slack message is posted and no public page is fetched.

## slack-link-unfurl-002

- Vitest: "Slack link previews > uses Open Graph for workspace members, unconnected sharers and events without an author"
- Mode: run
- Given: A Slack-installed workspace has an App page `/works` whose Open Graph title is "Published title" with image `https://images.example.com/cover.png`. A same-workspace peer is connected as `U_LINK_PEER`.
- When: The `/works` link is delivered to `POST /api/webhooks/slack/events` four times: by the connected peer, by an unconnected Slack user, with no author, and by the installer.
- Then: Each webhook returns HTTP 200 and each produces exactly one `chat.unfurl` with a divider, the linked title "Published title", and a signed 320x112 `/api/artifact-og/slack.png` image of the cover URL with alt "Published title". The page is fetched once per delivery.

## slack-link-unfurl-003

- Vitest: "Slack link previews > uses compact branding when anonymous App pages provide no Open Graph metadata"
- Mode: run
- Given: A Slack-installed workspace's App pages `/`, `/works`, `/settings` and a chat URL (with query and `#cover|v1` fragment) serve HTML without Open Graph metadata.
- When: All four links are delivered in one `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once with, for each URL, a divider, a linked brand title (with `&amp;` and `%7C` escaping in the chat link) and the compact 112-pixel brand image. No storage reads or Slack messages happen, and each page is fetched once without authorization or cookie headers.

## slack-link-unfurl-004

- Vitest: "Slack link previews > reads Open Graph for non-artifact App, shared-thread and hosted subpages"
- Mode: run
- Given: A Slack-installed workspace's App `/works` page, a hosted-site subpage, a shared-thread page, an unknown App page, and another hosted origin serve HTML with a `<base href="/assets/">`, escaped Open Graph title and description, and a relative `cover.png?x=1&y=2` image.
- When: All the links are delivered in one `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once; each URL gets a divider, the escaped linked title "Launch & <!channel> 计划", a plain-text description "Public & reviewed <!channel>", and a signed image of the base-resolved `/assets/cover.png?x=1&y=2` URL. No storage reads happen.

## slack-link-unfurl-005

- Vitest: "Slack link previews > uses partial Open Graph metadata for non-artifact pages"
- Mode: run
- Given: A Slack-installed workspace has four hosted pages that each expose only one Open Graph field: a title, a description, an external image, or the artifact OG image URL.
- When: All four links are delivered in one `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once. The title-only page uses its title with the compact brand image; the description-only page uses title "Okou", the description section and the brand image; the image-only pages use title "Okou" with a signed image of their own image URL.

## slack-link-unfurl-006

- Vitest: "Slack link previews > resolves redirected page images against the final URL"
- Mode: run
- Given: A Slack-installed workspace's App `/redirect` page redirects with 302 to `https://pages.example.com/guides/launch/`, which has Open Graph title "Redirected page" and relative image `cover.png`.
- When: The `/redirect` link is delivered to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once for the original URL with title "Redirected page" and a signed image of `https://pages.example.com/guides/launch/cover.png`.

## slack-link-unfurl-007

- Vitest: "Slack link previews > skips failed, non-HTML and oversized pages without losing valid sibling previews"
- Mode: run
- Given: A Slack-installed workspace's App pages return 404, a 404 HTML shared-thread page, 403, a network error, JSON, and HTML over 4 MiB, while `/works` is a valid page.
- When: All seven links are delivered in one `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once with a preview only for `/works`.

## slack-link-unfurl-008

- Vitest: "Slack link previews > processes redelivery against the same message and supports composer targets"
- Mode: run
- Given: A Slack-installed workspace published a public hosted site.
- When: The deployment URL is delivered to `POST /api/webhooks/slack/events`, redelivered with `x-slack-retry-num: 1`, then delivered as a composer event with channel `UNFURL` and message `composer-target`.
- Then: The first two deliveries produce two identical `chat.unfurl` calls. The composer event unfurls the URL against channel `UNFURL` and ts `composer-target`.

## slack-link-unfurl-009

- Vitest: "Slack link previews > skips unsupported or unavailable links without losing artifact and App previews"
- Mode: run
- Given: A Slack-installed workspace published a public hosted site.
- When: One `link_shared` event to `POST /api/webhooks/slack/events` contains invalid URLs, lookalike or nested hosts, localhost, credentialed or other-port URLs, a hosted asset path, an unknown deployment, a missing artifact reference, plus the valid deployment URL and the App `/works` URL.
- Then: `chat.unfurl` is called exactly once with previews only for the deployment URL and `/works`, the latter using the compact brand image.

## slack-link-unfurl-010

- Vitest: "Slack link previews > leaves normal connections intact with old installation scopes"
- Mode: run
- Given: A workspace admin installed the Slack bot with the older scope set lacking `links:read` and `links:write`, and published a public hosted site.
- When: The deployment URL and App `/works` link are delivered to `POST /api/webhooks/slack/events`; the admin then reads `GET /api/integrations/slack`.
- Then: No unfurl is requested. Status reports installed, connected and `scopeMismatch` true with a `reinstallUrl`.

## slack-link-unfurl-011

- Vitest: "Slack link previews > preserves sharing for report.png with none page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.png` (`image/png`), and App artifact pages serve no Open Graph metadata (row `none`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.png`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-012

- Vitest: "Slack link previews > preserves sharing for report.png with brand page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.png` (`image/png`), and App artifact pages serve Open Graph with the brand title and image (row `brand`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.png`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-013

- Vitest: "Slack link previews > preserves sharing for report.png with artifact page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.png` (`image/png`), and App artifact pages serve Open Graph with a published title and external image (row `artifact`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.png`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-014

- Vitest: "Slack link previews > preserves sharing for report.pdf with brand page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.pdf` (`application/pdf`), and App artifact pages serve Open Graph with the brand title and image (row `brand`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.pdf`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-015

- Vitest: "Slack link previews > preserves sharing for report.docx with artifact page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.docx` (Word document), and App artifact pages serve Open Graph with a published title and external image (row `artifact`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.docx`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-016

- Vitest: "Slack link previews > preserves sharing for report.html with brand page metadata"
- Mode: run
- Given: A Slack-installed admin uploaded a private `report.html` (`text/html`), and App artifact pages serve Open Graph with the brand title and image (row `brand`).
- When: The private, query-and-fragment and reference URLs plus a missing reference are posted to `POST /api/webhooks/slack/events`; the admin then shares the file with the organization via `PUT /api/artifact-shares` and reposts with the short URL, publishes it publicly and reposts, and finally makes it private and redelivers.
- Then: While private and organization-shared, no unfurl happens and no artifact page is fetched. After publishing, `chat.unfurl` is called exactly once for every known URL with an image from `/api/artifact-og/image?kind=reference` and alt text `report.html`. After returning to private, a redelivery triggers no unfurl, and artifact pages are never fetched.

## slack-link-unfurl-017

- Vitest: "Slack link previews > keeps public hosted artifact metadata instead of page Open Graph"
- Mode: run
- Given: A Slack-installed workspace published a public hosted site titled `Report & <!channel> "标题"`, and its pages would serve a different Open Graph title and image.
- When: The deployment URL, the site alias root and the alias `/index.html` are delivered to `POST /api/webhooks/slack/events`.
- Then: `chat.unfurl` is called exactly once; each URL shows the hosted artifact's escaped title and the `/api/artifact-og/image?kind=host&id=<deploymentId>` image, and no page is fetched.

## slack-link-unfurl-018

- Vitest: "Slack link previews > does not preview a deleted site"
- Mode: run
- Given: A Slack-installed workspace published a hosted site and then deleted it.
- When: The deployment URL and the site alias URL are delivered to `POST /api/webhooks/slack/events`.
- Then: No unfurl is requested and no page is fetched.

## slack-link-unfurl-019

- Vitest: "Slack link previews > verifies the webhook signature and link payload before acknowledging"
- Mode: run
- Given: The Slack signing secret is configured and team `T_UNKNOWN` has no installation.
- When: A `link_shared` event with an invalid `x-slack-signature` is posted to `POST /api/webhooks/slack/events`, then a validly signed one for `https://alias.okou.app/`.
- Then: The invalid signature returns HTTP 401, the valid delivery returns HTTP 200, and no unfurl is requested.
