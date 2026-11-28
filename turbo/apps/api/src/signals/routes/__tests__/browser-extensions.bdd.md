# browser-extensions

## browser-extensions-001

- Vitest: "Browser extensions > installs configured extensions before CDP and keeps the running instance"
- Mode: run
- Given: The deployment configures one Browser Use extension ID (with surrounding whitespace). A workspace member's chat has a launched Run with cloud Browser use, and the Browser Use provider holds its create-Browser response until extension installation finishes.
- When: The Run token calls `POST /api/browsers/use`; after installation completes the request finishes; the configured extension ID is then changed and the Run token calls `POST /api/browsers/use` again.
- Then: The provider receives exactly one create-Browser request listing only the trimmed configured extension ID, and no CDP discovery happens before installation completes. The first use returns HTTP 200 with an `active` Browser, after which CDP discovery occurs. The second use returns HTTP 200 with an `active` Browser and does not create another provider Browser.

## browser-extensions-002

- Vitest: "Browser extensions > returns installation failures without CDP or an extension-free retry"
- Mode: run
- Given: The deployment configures one Browser Use extension ID. A workspace member's chat has a launched Run with cloud Browser use, and the Browser Use provider rejects Browser creation with HTTP 422 "Requested extension is unavailable".
- When: The Run token calls `POST /api/browsers/use`.
- Then: The API responds with HTTP 502. The provider received exactly one create-Browser request listing the configured extension ID, with no extension-free retry and no CDP discovery.
