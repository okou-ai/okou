# slack-preview-image

## slack-preview-image-001

- Vitest: "Slack preview image URLs > delivers a direct transformation URL whose signed source redirects to the literal original"
- Mode: run
- Given: A workspace admin installed the Slack bot with link scopes. An App page's Open Graph image is `https://images.example.com/original?token=a%2Fb%2Bc&size=large`.
- When: The page link is delivered in a signed `link_shared` event to `POST /api/webhooks/slack/events`, and the unfurl image's signed source is requested with `GET /api/artifact-og/slack.png`.
- Then: The unfurl image is a Cloudflare `width=320,height=112` transformation on the public artifacts origin, at most 3000 characters, whose source is the API's `/api/artifact-og/slack.png` with `url` equal to the original. That request returns HTTP 302 to exactly the original URL with `cache-control: private, no-store`, `cdn-cache-control` and `cloudflare-cdn-cache-control` `no-store`, and `referrer-policy: no-referrer`.

## slack-preview-image-002

- Vitest: "Slack preview image URLs > uses the existing policy-gated thumbnail URL for first-party file grants"
- Mode: run
- Given: A workspace admin installed the Slack bot with link scopes. An App page's Open Graph image is the first-party file `https://a.okou.io/0123456789.png`.
- When: The page link is delivered in a signed `link_shared` event to `POST /api/webhooks/slack/events`.
- Then: The unfurl image URL is `https://a.okou.io/0123456789.png` with exactly the query `thumbnail=1`, `width=320`, `height=112`, `fit=scale-down` and `quality=85`.

## slack-preview-image-003

- Vitest: "Slack preview image URLs > resolves republished nested CF images to their original instead of another derivative"
- Mode: run
- Given: A workspace admin installed the Slack bot with link scopes. An App page's Open Graph image is a Cloudflare transformation nested inside another transformation around `https://images.example.com/cover?signature=a%2Fb`.
- When: The page link is delivered to `POST /api/webhooks/slack/events`, and the unfurl image's signed source is requested with `GET /api/artifact-og/slack.png`.
- Then: The signed source returns HTTP 302 to the innermost original URL.

## slack-preview-image-004

- Vitest: "Slack preview image URLs > preserves HTTP, IPv6 and internal-host image sources for Cloudflare delivery"
- Mode: run
- Given: A workspace admin installed the Slack bot with link scopes. Three App pages have Open Graph images `http://10.0.0.1/cover.png`, `http://[fd00::1]/cover.png` and `https://internal.local/cover.png`.
- When: The three links are delivered to `POST /api/webhooks/slack/events`, and each unfurl image's signed source is requested with `GET /api/artifact-og/slack.png`.
- Then: Each signed source returns HTTP 302 to its exact original image URL.

## slack-preview-image-005

- Vitest: "Slack preview image URLs > keeps already-issued literal-URL HMAC capabilities resolving to originals"
- Mode: run
- Given: A previously issued v1 capability signs the literal Cloudflare URL `https://a.okou.io/cdn-cgi/image/height=112/https://images.example.com/legacy.png?token=a%2Fb` with the secrets key.
- When: The capability is requested with `GET /api/artifact-og/slack.png` using that URL and signature.
- Then: The response is HTTP 302 to the inner original `https://images.example.com/legacy.png?token=a%2Fb`.

## slack-preview-image-006

- Vitest: "Slack preview image URLs > rejects modified signed capabilities and does not create nested adapters or unbounded Slack URLs"
- Mode: run
- Given: A workspace admin installed the Slack bot with link scopes and obtained a signed preview capability for `https://images.example.com/cover.png` through a link unfurl.
- When: The capability is requested with `GET /api/artifact-og/slack.png` with a changed `url` and with a changed signature; then App pages whose Open Graph images are the adapter URL, a Cloudflare wrapper of the issued image URL, a URL over 2048 characters, a non-default port and an App artifact path are unfurled through `POST /api/webhooks/slack/events`.
- Then: Both modified capabilities return HTTP 403. None of the five pages receives an image in its unfurl.
