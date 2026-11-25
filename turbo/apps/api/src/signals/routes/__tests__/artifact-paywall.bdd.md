# artifact-paywall

## artifact-paywall-001

- Vitest: "a free plan keeps the banner, its address, and App downloads behind an upgrade"
- Mode: run
- Given: A limited-free owner has published a public hosted site with an index and secondary page.
- When: The owner checks banner settings and tries to hide the banner, rename the public slug and download site files. The delivery client checks authorization for the published site.
- Then: Banner settings return HTTP 200 with the banner on and no revision. Delivery is allowed with the banner on and downloads disabled. Hiding and renaming return HTTP 402 with `PRO_REQUIRED`, and listing files for download returns HTTP 402.

## artifact-paywall-002

- Vitest: "paid plans keep every artifact action with the paywall rolled out"
- Mode: run
- Given: A Pro owner has published a public hosted site with the paywall active.
- When: The owner hides the banner, checks delivery authorization, lists the site files and requests a new public slug.
- Then: All four calls return HTTP 200. Delivery remains allowed with the banner off and downloads enabled. The rename response contains the requested slug.
