# android-updates

## android-updates-001

- Vitest: "Android public update recovery > retains a precise public bootstrap after business API exclusion"
- Mode: run
- Given: The published Android update manifest in static storage contains release 0.14.1, and Android clients below 0.12.0 are unsupported; the caller is an Android client at version 0.1.0.
- When: The client calls `GET /api/android/updates`, then calls `GET /api/org`, `GET /api/android/updates/other` and `POST /api/android/updates`; after the minimum version is cleared, an anonymous caller calls `GET /api/android/updates`.
- Then: The update request returns HTTP 200 with `cache-control: no-store` and `{ minimumSupportedVersion: "0.12.0", release }`. The three other requests each return HTTP 426. The anonymous request returns HTTP 200 with `minimumSupportedVersion: null` and the same release.

## android-updates-002

- Vitest: "Android public update recovery > discovers successive R2 releases while the public manifest is stale"
- Mode: run
- Given: The public manifest URL still advertises release 0.14.0, while the static R2 bucket (accessed with the static storage endpoint and credentials) holds release 0.14.1.
- When: The caller requests `GET /api/android/updates`, the bucket manifest is replaced with release 0.14.2, and the caller requests it again.
- Then: The first response returns release 0.14.1 and the second returns release 0.14.2, both read from R2 rather than the stale public manifest.

## android-updates-003

- Vitest: "Android public update recovery > reports missing object as an unavailable release"
- Mode: run
- Given: Android clients below 0.12.0 are unsupported, and static storage reports the manifest object as missing (`NoSuchKey`).
- When: The caller requests `GET /api/android/updates`, and an Android 0.1.0 client calls `GET /api/org`.
- Then: The update request returns HTTP 503 with `retry-after: 60`, `cache-control: no-store` and error code `ANDROID_UPDATE_UNAVAILABLE`. The business API request returns HTTP 426.

## android-updates-004

- Vitest: "Android public update recovery > reports temporary S3 failure as an unavailable release"
- Mode: run
- Given: Android clients below 0.12.0 are unsupported, and static storage fails with a temporary HTTP 503.
- When: The caller requests `GET /api/android/updates`, and an Android 0.1.0 client calls `GET /api/org`.
- Then: The update request returns HTTP 503 with `retry-after: 60`, `cache-control: no-store` and error code `ANDROID_UPDATE_UNAVAILABLE`. The business API request returns HTTP 426.

## android-updates-005

- Vitest: "Android public update recovery > reports connection reset as an unavailable release"
- Mode: run
- Given: Android clients below 0.12.0 are unsupported, and the static storage connection is reset (`ECONNRESET`).
- When: The caller requests `GET /api/android/updates`, and an Android 0.1.0 client calls `GET /api/org`.
- Then: The update request returns HTTP 503 with `retry-after: 60`, `cache-control: no-store` and error code `ANDROID_UPDATE_UNAVAILABLE`. The business API request returns HTTP 426.

## android-updates-006

- Vitest: "Android public update recovery > reports an owned storage timeout as retryable"
- Mode: run
- Given: The static storage read exceeds the API's own 5-second deadline and is aborted with a timeout.
- When: The caller requests `GET /api/android/updates`.
- Then: The request returns HTTP 503 with error code `ANDROID_UPDATE_UNAVAILABLE`.

## android-updates-007

- Vitest: "Android public update recovery > surfaces missing static credentials as a configuration error"
- Mode: run
- Given: The static storage secret access key is not configured.
- When: The caller requests `GET /api/android/updates`.
- Then: The request fails with the server error "Static storage credentials are not configured" rather than an unavailable-release response.

## android-updates-008

- Vitest: "Android public update recovery > surfaces an incorrect static bucket as a configuration error"
- Mode: run
- Given: Static storage reports that the configured static bucket does not exist (`NoSuchBucket`, HTTP 404).
- When: The caller requests `GET /api/android/updates`.
- Then: The request fails with the server error "The specified bucket does not exist" rather than an unavailable-release response.

## android-updates-009

- Vitest: "Android public update recovery > preserves caller cancellation instead of reporting a retryable release"
- Mode: run
- Given: The caller cancels its request while the manifest read from static storage is in flight.
- When: The caller requests `GET /api/android/updates` with its own abort signal.
- Then: The request rejects with the caller's "Caller aborted" cancellation instead of a retryable unavailable response.

## android-updates-010

- Vitest: "Android public update recovery > surfaces oversized publication bytes as an error"
- Mode: run
- Given: The manifest object in static storage is 65,537 bytes long.
- When: The caller requests `GET /api/android/updates`.
- Then: The request fails with the server error "S3 object is too large".

## android-updates-011

- Vitest: "Android public update recovery > validates the published APK identity"
- Mode: run
- Given: The published manifest's release points to an APK at `https://example.com/untrusted.apk`, which does not match the release version and SHA-256 identity.
- When: The caller requests `GET /api/android/updates`.
- Then: The request fails with the server error "Android release identity is inconsistent".
