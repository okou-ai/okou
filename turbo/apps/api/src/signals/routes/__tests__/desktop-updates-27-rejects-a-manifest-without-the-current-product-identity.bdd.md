# desktop-updates-27-rejects-a-manifest-without-the-current-product-identity

## desktop-updates-27-rejects-a-manifest-without-the-current-product-identity-001

- Vitest: "desktop update routes > rejects unidentified manifests and recovers when the publisher corrects them"
- Mode: run
- Given: The stable manifest describes 1.2.3 but omits the product identity. The publisher can replace it with the same manifest including the product identity.
- When: The updater requests the stable macOS ARM64 appcast and neutral DMG against the unidentified manifest. It requests the appcast again after the correction.
- Then: Both initial responses are HTTP 500. The corrected appcast responds with HTTP 200, Sparkle version 1.2.3 and the 1.2.3 ZIP enclosure.
