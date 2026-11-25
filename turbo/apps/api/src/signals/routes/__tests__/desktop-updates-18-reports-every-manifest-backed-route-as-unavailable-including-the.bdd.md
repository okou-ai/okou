# desktop-updates-18-reports-every-manifest-backed-route-as-unavailable-including-the

## desktop-updates-18-reports-every-manifest-backed-route-as-unavailable-including-the-001

- Vitest: "desktop update routes > reports every manifest-backed route as unavailable, including the wall's download"
- Mode: run
- Given: The upstream desktop release manifest is unreachable and no cached manifest exists.
- When: An unauthenticated caller requests the product-specific stable macOS ARM64 appcast, and both neutral and product-specific DMG and release routes for the same platform.
- Then: All five responses are HTTP 503. The appcast JSON error code is `DESKTOP_UPDATE_UNAVAILABLE`.
