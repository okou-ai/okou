# hosted-site-domains

## hosted-site-domains-001

- Vitest: "manual verification returns pending once, then makes the complete hostname selectable without applying it"
- Mode: run
- Given: A signed-in owner with a Pro entitlement has enabled the hosted-site custom domains switch and published a public site; DNS answers with the domain's TXT ownership value and a CNAME to `connect.okou.app`, and the Cloudflare custom-hostname certificate is first pending and later active.
- When: The owner sends `POST /api/host/sites/:siteId/domains` for `<site>.customer-example.net`, `POST /api/host/sites/:siteId/domains/:domainId/verify` before and after the certificate activates, `PATCH /api/host/sites/:siteId/domain-selection` to select it, `GET /api/host/custom-domains/:hostname`, a stale selection of `null`, `DELETE /api/host/sites/:siteId/domains/:domainId`, another resolve and `GET /api/host/sites/:siteId/domains`.
- Then: Adding returns effective URL `https://<site>.okou.app` with no DNS queries or provider creations. The first verify reports certificate `pending` and not ready; the second creates exactly one provider hostname, is ready, leaves `selectedDomainId` null and the default effective URL. Selection returns HTTP 200 with effective URL `https://<hostname>` and the resolve returns the site ID. The stale selection returns HTTP 409; removal returns HTTP 200, the resolve then returns null, and the domain list is empty with the default effective URL.

## hosted-site-domains-002

- Vitest: "tXT ownership is independent of a correct CNAME and prevents provider activation"
- Mode: run
- Given: A paid owner with custom domains enabled has a published site; DNS has a correct CNAME but publishes the wrong TXT ownership value.
- When: The owner adds a custom domain, calls `POST /api/host/sites/:siteId/domains/:domainId/verify`, and tries `PATCH /api/host/sites/:siteId/domain-selection` with it.
- Then: The ownership check status is `failed`, no Cloudflare custom hostname is created, and the selection returns HTTP 409.

## hosted-site-domains-003

- Vitest: "rejects URL syntax, suffixes, local addresses and reserved platform hosts before DNS"
- Mode: run
- Given: A paid owner with custom domains enabled has a published site.
- When: The owner sends `POST /api/host/sites/:siteId/domains` with each of `https://example.net/path`, `example.net/ignored`, `127.0.0.1`, `localhost`, `*.example.net`, `co.uk`, `foo.okou.app`, `foo.vm0.io`, `user@example.net` and `example.net:443`, then with `WWW.CUSTOMER-EXAMPLE.NET.`.
- Then: Every invalid hostname returns HTTP 400. The last request succeeds with hostname normalized to `www.customer-example.net`, and no DNS query is made.

## hosted-site-domains-004

- Vitest: "a free workspace cannot create custom domains even when its rollout is enabled"
- Mode: run
- Given: A free workspace owner has enabled the custom domains switch and published a site.
- When: The owner sends `POST /api/host/sites/:siteId/domains` for `www.customer-example.net`.
- Then: The response is HTTP 402.

## hosted-site-domains-005

- Vitest: "domain configuration remains scoped to the website owner"
- Mode: run
- Given: A paid owner with custom domains enabled has a published site, and a user from another workspace is signed in.
- When: The other user calls `GET /api/host/sites/:siteId/domains` and `POST /api/host/sites/:siteId/domains` for the owner's site.
- Then: Both requests return HTTP 404.

## hosted-site-domains-006

- Vitest: "root domains use only configured Apex Proxying addresses"
- Mode: run
- Given: A paid owner with custom domains enabled has a published site; the configured apex addresses are `203.0.113.3`, DNS for the root domain has no CNAME but an A record of `203.0.113.3` and the correct TXT value, and the certificate is active.
- When: The owner adds `<site>.net` and calls `POST /api/host/sites/:siteId/domains/:domainId/verify`.
- Then: The required records include an `A` record for the hostname with value `203.0.113.3`, and verification reports the domain ready.

## hosted-site-domains-007

- Vitest: "cNAME loops never make a custom domain selectable"
- Mode: run
- Given: A paid owner with custom domains enabled has a published site; DNS has the correct TXT value but the hostname's CNAME points to itself, and the certificate is active.
- When: The owner adds the domain and calls `POST /api/host/sites/:siteId/domains/:domainId/verify`.
- Then: The domain is not ready and the DNS check status is `failed`.

## hosted-site-domains-008

- Vitest: "temporary provider failures retain prior verification but a removed provider binding fails closed"
- Mode: run
- Given: A paid owner has a verified, ready custom domain; afterwards the Cloudflare custom-hostname lookup returns 503, then 404, then 503 again.
- When: The owner calls `POST /api/host/sites/:siteId/domains/:domainId/verify` after each provider change and finally resolves `GET /api/host/custom-domains/:hostname`.
- Then: With the first 503 the domain stays ready with verification status `unavailable`. After the 404 it is not ready and the provider check is `failed`. After the second 503 the status is `unavailable` and it remains not ready, and the hostname resolves to null.

## hosted-site-domains-009

- Vitest: "taking a website offline revokes its custom hostname while preserving manual cleanup"
- Mode: run
- Given: A paid owner has verified and selected a custom domain for a published site.
- When: The owner deletes the site with `DELETE /api/host/sites/:site`, resolves `GET /api/host/custom-domains/:hostname`, reads `GET /api/host/sites/:siteId/domains`, and removes the domain with `DELETE /api/host/sites/:siteId/domains/:domainId`.
- Then: The hostname resolves to null, the settings show `selectedDomainId` null and the domain marked `removing`, and the removal returns HTTP 200.

## hosted-site-domains-010

- Vitest: "private website sessions trust only the exact custom origin and do not survive rebinding"
- Mode: run
- Given: A paid owner has a verified custom domain on a site that the owner then makes private.
- When: The owner requests `POST /api/host/sites/:siteId/session-authorizations` for `https://<hostname>:8443` and for the exact `https://<hostname>` origin, exchanges the code at `POST /api/host/sites/:siteId/sessions`, checks `GET /api/host/sites/:siteId/access` with the site session, removes the domain, re-adds and re-verifies the same hostname, and checks access again with the old session.
- Then: The origin with a port returns HTTP 403 and the exact origin returns HTTP 200. The session is allowed on the custom origin before rebinding and is not allowed after the domain is removed and added again.

## hosted-site-domains-011

- Vitest: "does not adopt or delete a preexisting provider resource by hostname"
- Mode: run
- Given: A paid owner has added a custom domain with correct DNS, and Cloudflare already holds a custom-hostname resource for that hostname that Okou did not create.
- When: The owner calls `POST /api/host/sites/:siteId/domains/:domainId/verify` and then `DELETE /api/host/sites/:siteId/domains/:domainId`.
- Then: Verification returns HTTP 409 with error code `DOMAIN_IN_USE`. Removal returns HTTP 200 with no domains, and Okou neither creates nor deletes any provider resource.

## hosted-site-domains-012

- Vitest: "can retry a definitively rejected provider creation without an enterprise feature"
- Mode: run
- Given: A paid owner has added a custom domain with correct DNS and an active certificate, and Cloudflare first rejects custom-hostname creation with HTTP 403 and later accepts it.
- When: The owner verifies the domain, verifies again after Cloudflare accepts creation, and then removes the domain.
- Then: The first verification returns HTTP 200 with status `unavailable`; the retry makes the domain ready; removal returns HTTP 200 and deletes exactly one provider hostname.

## hosted-site-domains-013

- Vitest: "keeps an uncertain provider creation disconnected instead of adopting or deleting by name"
- Mode: run
- Given: A paid owner has added a custom domain with correct DNS, and Cloudflare creates the custom hostname but the creation response is lost in a network error.
- When: The owner verifies the domain, verifies again, tries `DELETE /api/host/sites/:siteId/domains/:domainId`, and reads `GET /api/host/sites/:siteId/domains`.
- Then: The first verify returns HTTP 200 and not ready; the retry returns HTTP 503 with `DOMAIN_PROVIDER_UNCONFIRMED`; removal returns HTTP 503. The domain is listed as `removing`, the effective URL stays the default, and there is exactly one provider creation and no provider deletion.

## hosted-site-domains-014

- Vitest: "records the exact provider ID when removal wins during creation and allows safe cleanup"
- Mode: run
- Given: A paid owner has added a custom domain with correct DNS, and Cloudflare holds the custom-hostname creation in progress.
- When: The owner starts verification, sends `DELETE /api/host/sites/:siteId/domains/:domainId` while creation is in progress, lets creation finish, and then removes the domain again.
- Then: The concurrent removal returns HTTP 503 and the verification returns HTTP 409. The second removal returns HTTP 200 with no domains and exactly one provider deletion.

## hosted-site-domains-015

- Vitest: "a provider identity mismatch disables selection and never deletes another hostname"
- Mode: run
- Given: A paid owner has a verified custom domain, and Cloudflare's resource under the recorded ID now reports hostname `another.customer-example.net`.
- When: The owner verifies the domain again and then sends `DELETE /api/host/sites/:siteId/domains/:domainId`.
- Then: Verification returns HTTP 200 with the domain not ready, removal returns HTTP 503, and no provider resource is deleted.

## hosted-site-domains-016

- Vitest: "verifies each additional TXT value independently without treating certificate activation as DNS evidence"
- Mode: run
- Given: A paid owner has added a custom domain with the correct TXT ownership value; Cloudflare's pending certificate lists two TXT validation values (`certificate-one`, `certificate-two`) at `_acme-challenge.<hostname>`, and DNS initially publishes only `certificate-one` (split across strings).
- When: The owner verifies the domain, reads `GET /api/host/sites/:siteId/domains`, then DNS publishes both values and the owner verifies again.
- Then: The first verify is not ready with certificate `pending`; its record checks show `certificate-one` `passed` and `certificate-two` `pending`, both observing `["certificate-one"]`, and the domain read returns the same record checks. After both values are published, every `_acme-challenge` record check is `passed` but the domain is still not ready.

## hosted-site-domains-017

- Vitest: "offers a signed cloudflare apply URL only for the owned domain and supported Okou template"
- Mode: run
- Given: A paid owner has added `<site>.customer-example.net`; a Domain Connect signing key is configured with key host `_test` and its public key is published in DNS, `APP_URL` is `https://app.okou.ai`, and DNS discovery points `customer-example.net` to Cloudflare's Domain Connect, which supports the `okou.ai` `hosted-site` template (row: `cloudflare`).
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup` and then `GET /api/host/sites/:siteId/domains`.
- Then: Setup status is `supported` and the automatic URL path contains `/providers/okou.ai/services/hosted-site/apply` with `domain` `customer-example.net`, `host` set to the subdomain label, `target` `connect.okou.app`, `redirect_uri` `https://app.okou.ai/artifacts`, sorted parameters and `sig` last; the RSA-SHA256 signature verifies with the published key. The domain list still has `selectedDomainId` null and no verification.

## hosted-site-domains-018

- Vitest: "offers a signed vercel apply URL only for the owned domain and supported Okou template"
- Mode: run
- Given: A paid owner has added `<site>.customer-example.net`; a Domain Connect signing key is configured with key host `_test` and its public key is published in DNS, `APP_URL` is `https://app.okou.ai`, and DNS discovery points `customer-example.net` to Vercel's Domain Connect, which supports the `okou.ai` `hosted-site` template (row: `vercel`).
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup` and then `GET /api/host/sites/:siteId/domains`.
- Then: Setup status is `supported` and the automatic URL path contains `/providers/okou.ai/services/hosted-site/apply` with `domain` `customer-example.net`, `host` set to the subdomain label, `target` `connect.okou.app`, `redirect_uri` `https://app.okou.ai/artifacts`, sorted parameters and `sig` last; the RSA-SHA256 signature verifies with the published key. The domain list still has `selectedDomainId` null and no verification.

## hosted-site-domains-019

- Vitest: "keeps manual DNS setup when only other templates are supported"
- Mode: run
- Given: A paid owner has added a custom domain whose DNS discovery points to Cloudflare's Domain Connect, but the `okou.ai` `hosted-site` template is not supported there (HTTP 404).
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The setup is `manual` with provider name `Cloudflare`, control panel URL `https://dash.cloudflare.com/` and `automaticUrl` null.

## hosted-site-domains-020

- Vitest: "never follows an untrusted DNS discovery endpoint"
- Mode: run
- Given: A paid owner has added a custom domain, and DNS discovery returns the TXT value `127.0.0.1/private` for every name.
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The response is HTTP 200 with `automaticUrl` null and `controlPanelUrl` null.

## hosted-site-domains-021

- Vitest: "domain setup is denied when the feature is off and remains scoped to the website owner"
- Mode: run
- Given: A paid owner has added a custom domain, and a user from another workspace is signed in.
- When: The other user calls `GET /api/host/sites/:siteId/domains/:domainId/setup`; the owner then turns off the custom domains switch with `POST /api/feature-switches` and calls the same setup route.
- Then: The other user gets HTTP 404 and the owner gets HTTP 403 once the feature is off.

## hosted-site-domains-022

- Vitest: "a delegated zone cannot inherit automatic setup from its parent provider"
- Mode: run
- Given: A paid owner has added a custom domain whose own NS records point to `ns1.dnspod.net`, while the parent domain's discovery record points to Vercel's Domain Connect.
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The setup is `manual` with provider name `DNSPod`, control panel URL `https://console.dnspod.cn/` and `automaticUrl` null.

## hosted-site-domains-023

- Vitest: "a supported template without a published signing key keeps manual setup available"
- Mode: run
- Given: A paid owner has added a custom domain discovered at Vercel's Domain Connect with a supported template, and a signing key is configured with key host `_unpublished` whose public key is not published in DNS.
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The setup is `manual` with provider name `Vercel` and `automaticUrl` null.

## hosted-site-domains-024

- Vitest: "free workspaces cannot request automatic DNS setup"
- Mode: run
- Given: A free workspace owner has enabled the custom domains switch and published a site.
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup` for a random domain ID.
- Then: The response is HTTP 402.

## hosted-site-domains-025

- Vitest: "keeps manual setup for provider settings with untrusted URL"
- Mode: run
- Given: A paid owner has added a custom domain discovered at Vercel's Domain Connect, but the provider settings advertise the API URL `https://untrusted.example/collect` (row: `untrusted URL`).
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The setup is `unavailable` with provider name `Vercel`, control panel URL `https://vercel.com/domains` and `automaticUrl` null.

## hosted-site-domains-026

- Vitest: "keeps manual setup for provider settings with invalid JSON"
- Mode: run
- Given: A paid owner has added a custom domain discovered at Vercel's Domain Connect, but the provider settings response is not valid JSON (row: `invalid JSON`).
- When: The owner calls `GET /api/host/sites/:siteId/domains/:domainId/setup`.
- Then: The setup is `unavailable` with provider name `Vercel`, control panel URL `https://vercel.com/domains` and `automaticUrl` null.
