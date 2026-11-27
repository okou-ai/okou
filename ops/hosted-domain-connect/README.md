# Hosted website Domain Connect onboarding

Okou uses the signed synchronous `okou.ai / hosted-site` template in
[Domain-Connect/Templates](https://github.com/Domain-Connect/Templates).
It creates a website CNAME and an `okou-verification=` ownership TXT.
The template constrains the CNAME target to `*.okou.app` and uses the standard
`host` parameter for the customer's subdomain. Certificate validation uses HTTP.

## Signing key

Run **Provision hosted website Domain Connect key** on reviewed `main` in the
production environment, supplying the Doppler OIDC identity ID as the required
`doppler_identity_id` input. The workflow exchanges GitHub OIDC for Doppler
access, generates an RSA key inside the trusted runner, and stores these values
in `vm0 / prd`:

- `HOSTED_SITE_DOMAIN_CONNECT_PRIVATE_KEY_BASE64`: RSA PKCS#8 DER, base64.
- `HOSTED_SITE_DOMAIN_CONNECT_KEY_HOST`: `sites-v1`.

It reuses an existing matching configuration. Partial configuration or a
different key host requires operator review; an uncertain write is not retried.
Private key material must remain outside the sandbox and workflow artifacts.

For first-time initialization, create a temporary Doppler service account with
workplace role `no_access`. Grant a custom project role containing only
`enclave_project_config_secrets_read` and
`enclave_project_config_secrets_write`, scoped to project `vm0`, configuration
`prd` (not the whole environment). Give its OIDC identity a 300-second token
lifetime and require these exact GitHub claims:

- `aud`: `https://github.com/okou-ai`
- `sub`: `repo:okou-ai@242540347/okou@1096175506:environment:production`
- `repository_id`: `1096175506`
- `ref`: `refs/heads/main`
- `workflow_ref`: `okou-ai/okou/.github/workflows/hosted-domain-connect-key.yml@refs/heads/main`

Pass that identity ID to the workflow. Remove the temporary identity, service
account, and role after successful provisioning. Do not broaden the existing
production deployment identity or create a static bootstrap token. Recovery of
an existing matching key needs only read access; supply the normal production
read-only OIDC identity ID when exporting its public records again.

Download the `hosted-domain-connect-public-key` artifact and publish each of its
public TXT fragments at `sites-v1.domainconnect.okou.ai`. Confirm the published
fragments reconstruct the matching public key before deploying the API with
the new Doppler values. Keep previous public keys available during rotation.
Do not copy this production private key into development or PR configurations.

## HTTP certificate validation

The SaaS zone's Worker routes must let Cloudflare handle certificate challenges.
Alongside the existing catch-all Worker, configure null-script exclusions for:

- `*/.well-known/acme-challenge/*`
- `*/.well-known/pki-validation/*`

Keep the fallback origin active. Test a new owned subdomain using only its
ownership TXT and website CNAME; verify HTTPS becomes active and the selected
website loads. A verified but unselected hostname must not serve website content.

## Cloudflare template activation

Follow the current [Cloudflare Domain Connect procedure](https://developers.cloudflare.com/dns/reference/domain-connect/):

1. Submit the template to Domain-Connect/Templates with its Online Editor test
   link and successful official linter results; wait for upstream merge.
2. Publish and verify the signing public key, then deploy the signing settings.
3. Request initial onboarding at `domain-connect@cloudflare.com`, including the
   merged template link, `sites-v1.domainconnect.okou.ai`, the SVG logo below,
   and the CNAME default proxy setting **DNS only (`proxied: false`)**. The
   application checks public CNAME answers before issuing certificates.
4. Check Cloudflare's exact template-support endpoint, then complete a real
   signed consent flow. Until that support check and published-key validation
   succeed, the application keeps manual DNS setup available.

Logo: <https://static.okou.io/public/okou-logo-wordmark-light-339c25e162eb.svg>.
The redirect to `https://app.okou.ai/artifacts` is navigation only; it does not
verify ownership or select a website address. Users return to the setup panel
and click Verify; activation refreshes every 30 seconds while checks are pending.
