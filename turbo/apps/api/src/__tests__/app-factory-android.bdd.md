# app-factory-android

## app-factory-android-001

- Vitest: "Android installed-client compatibility at the API boundary > rejects an unsupported Android build before GET route matching"
- Mode: run
- Given: The API requires Android version 0.2.0 and the caller identifies itself with `X-Client-Type: Android` and `X-Client-Version: 0.1.0`.
- When: The caller sends `GET /health`.
- Then: The response is HTTP 426 with `Cache-Control: no-store`, error code `ANDROID_UPDATE_REQUIRED`, message `Update Okou for Android to continue.`, and `minimumSupportedVersion: "0.2.0"`.

## app-factory-android-002

- Vitest: "Android installed-client compatibility at the API boundary > rejects an unsupported Android build before POST route matching"
- Mode: run
- Given: The API requires Android version 0.2.0 and the caller identifies itself with `X-Client-Type: Android` and `X-Client-Version: 0.1.0`.
- When: The caller sends `POST /api/user-preferences/initialize`.
- Then: The response is HTTP 426 with `Cache-Control: no-store`, error code `ANDROID_UPDATE_REQUIRED`, message `Update Okou for Android to continue.`, and `minimumSupportedVersion: "0.2.0"`.

## app-factory-android-003

- Vitest: "Android installed-client compatibility at the API boundary > compares 0.9.9 against floor 0.10.0 by version components"
- Mode: run
- Given: The caller identifies itself as Android version `0.9.9` and the API requires Android version `0.10.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 426 with `minimumSupportedVersion: "0.10.0"`.

## app-factory-android-004

- Vitest: "Android installed-client compatibility at the API boundary > compares 0.1.1000 against floor 0.2.0 by version components"
- Mode: run
- Given: The caller identifies itself as Android version `0.1.1000` and the API requires Android version `0.2.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 426 with `minimumSupportedVersion: "0.2.0"`.

## app-factory-android-005

- Vitest: "Android installed-client compatibility at the API boundary > compares 0.9007199254740992.0 against floor 0.9007199254740993.0 by version components"
- Mode: run
- Given: The caller identifies itself as Android version `0.9007199254740992.0` and the API requires Android version `0.9007199254740993.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 426 with `minimumSupportedVersion: "0.9007199254740993.0"`.

## app-factory-android-006

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (Android, 0.2.0)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: Android` and `X-Client-Version: 0.2.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-007

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (Android, 1.0.0)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: Android` and `X-Client-Version: 1.0.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-008

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (Android, development)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: Android` and `X-Client-Version: development`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-009

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (Android, undefined)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: Android` and no client-version header.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-010

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (android, 0.1.0)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: android` and `X-Client-Version: 0.1.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-011

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (iOS, 0.51.12)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: iOS` and `X-Client-Version: 0.51.12`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-012

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (Desktop, 0.1.0)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies `X-Client-Type: Desktop` and `X-Client-Version: 0.1.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-013

- Vitest: "Android installed-client compatibility at the API boundary > preserves independently supported or non-Android calls (undefined, 0.1.0)"
- Mode: run
- Given: The Android minimum version is 0.2.0. The caller supplies no client-type header and `X-Client-Version: 0.1.0`.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.

## app-factory-android-014

- Vitest: "Android installed-client compatibility at the API boundary > does not enforce a floor before a verified Android release"
- Mode: run
- Given: The API has no configured Android minimum version. The caller identifies itself as Android version 0.0.1.
- When: The caller sends `GET /health`.
- Then: The API returns HTTP 200.
