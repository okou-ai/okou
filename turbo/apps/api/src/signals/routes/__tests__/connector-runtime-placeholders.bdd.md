# connector-runtime-placeholders

## connector-runtime-placeholders-001

- Vitest: "official connector runtime placeholders > dispatches all GitHub aliases without decrypting their secret and resolves auth on demand"
- Mode: run
- Given: A Chat owner has connected a GitHub OAuth account and starts a run with the account available. The GitHub provider has issued a real credential to the application.
- When: A Runner receives the execution input, requests firewall authorization first without the admitted account reference and then with it, and completes the run.
- Then: The execution supplies matching placeholders for GITHUB_TOKEN and GH_TOKEN with metadata naming the account and does not disclose the GitHub credential. No credential decryption is needed to prepare the execution. POST /api/webhooks/run/firewall/auth returns HTTP 424 CONNECTOR_NOT_CONFIGURED without the account reference and HTTP 200 with the provider Authorization header when the reference is present. Decryption then occurs and the run can be read as completed.
