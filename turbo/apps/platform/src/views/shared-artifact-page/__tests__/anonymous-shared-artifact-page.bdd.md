# Anonymous shared artifact page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [anonymous-shared-artifact-page.test.tsx](anonymous-shared-artifact-page.test.tsx).

## anonymous-shared-artifact-page-001

Original test `a signed-out recipient can preview, copy, and download a public image`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/anonymous-shared-artifact-page.test.tsx#L49).

- **Given** A signed-out recipient opens a shared public PNG artifact with a source query and detail fragment.
- **When** The recipient previews it, copies its link, and downloads it.
- **Then** The image preview preserves the fragment, the artifact filename and Okou page title appear, and the browser URL remains unchanged without sign-in. Sharing copies the current URL, and download uses the supplied filename and download URL without navigation.

## anonymous-shared-artifact-page-002

Original test `a signed-out legacy HTML link previews its requested slide on the isolated public origin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/anonymous-shared-artifact-page.test.tsx#L97).

- **Given** A signed-out recipient opens a legacy shared HTML artifact link with the slide-2 fragment.
- **When** The recipient views the artifact.
- **Then** The HTML preview loads from its isolated public origin with the slide-2 fragment, restricted sandbox permissions, and origin referrer policy. The app URL is unchanged.

## anonymous-shared-artifact-page-003

Original test `an unavailable anonymous artifact stays in the viewer and signs in only on request: /artifacts/00000000000040008000000000000011.png`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/anonymous-shared-artifact-page.test.tsx#L130).

- **Given** A signed-out recipient opens an unavailable shared PNG artifact with a source query and detail fragment.
- **When** The artifact cannot be retrieved.
- **Then** The viewer stays on the artifact route and shows that it cannot be viewed, with an Artifacts heading and no preview or sign-in prompt. It says the artifact may be private or unavailable, not that it may be shared with a different account. Sign in is offered only on request and returns to the original artifact URL.

## anonymous-shared-artifact-page-004

Original test `an authenticated recipient with resolution status 403 can preview a public artifact inside the app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/anonymous-shared-artifact-page.test.tsx#L187).

- **Given** An authenticated recipient opens a public image artifact whose resolution request returns 403, while its public preview URL is available.
- **When** The recipient views the artifact.
- **Then** The public image preview and filename appear inside the app without a sign-in prompt or browser navigation.
