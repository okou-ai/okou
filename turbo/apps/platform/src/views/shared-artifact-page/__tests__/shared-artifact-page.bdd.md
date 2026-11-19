# Shared artifact page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-artifact-page.test.tsx](shared-artifact-page.test.tsx).

## shared-artifact-page-001

Original test `an image link stays in the app and reuses the lightbox preview and zoom controls`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L83).

- **Given** A visitor opens an image artifact link in the app.
- **When** The preview loads, and they use Zoom in followed by Reset zoom.
- **Then** The app stays on the artifact page without redirecting, shows the image, filename, and matching document title, and provides zoom controls. Zoom in raises the zoom above 100%; Reset zoom restores it to 100%.

## shared-artifact-page-002

Original test `Share copies the current app address without changing sharing or copying a signature`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L122).

- **Given** A visitor is viewing an image artifact URL with a fragment.
- **When** They select Share.
- **Then** The current app address, including its fragment, is copied and “Link copied” appears. Sharing is not changed and no share menu items appear.

## shared-artifact-page-003

Original test `downloads resolve attachment URLs and preserve the original filename`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L145).

- **Given** A visitor is viewing a shared artifact at a legacy path with a query and fragment.
- **When** They open Download options and select Download.
- **Then** The original filename is downloaded using the attachment download URL, without first fetching a blob.

## shared-artifact-page-004

Original test `HTML stays on its isolated origin and retains the requested slide`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L168).

- **Given** A visitor opens an HTML artifact link whose URL has a slide fragment.
- **When** The preview and Continue with Okou link are displayed.
- **Then** The preview stays on its isolated origin, retains the fragment, uses a sandbox allowing only same-origin and scripts, and uses the origin referrer policy. Continue with Okou returns to the app root and its prompt includes the full app artifact URL and fragment.

## shared-artifact-page-005

Original test `an external HTML preview receives no app or artifact referrer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L191).

- **Given** A visitor opens an HTML artifact hosted at an untrusted external origin.
- **When** The preview loads.
- **Then** The preview uses the no-referrer policy.

## shared-artifact-page-006

Original test `unavailable links preserve access controls without disclosing content: status 403`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L202).

- **Given** A signed-in visitor requests an artifact link that returns status 403.
- **When** The artifact request is denied.
- **Then** The viewer shows “You can’t view this artifact” and the Artifacts heading, without showing the filename, image, or iframe. It explains that the artifact may not exist or may be shared with another account or organization, not that it may be private or unavailable; Switch account is enabled, Back to Okou links to /, and the signed-in user and configured theme remain visible.

## shared-artifact-page-007

Original test `unavailable links preserve access controls without disclosing content: status 404`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L202).

- **Given** A signed-in visitor requests an artifact link that returns status 404.
- **When** The artifact request is denied.
- **Then** The viewer shows “You can’t view this artifact” and the Artifacts heading, without showing the filename, image, or iframe. It explains that the artifact may not exist or may be shared with another account or organization, not that it may be private or unavailable; Switch account is enabled, Back to Okou links to /, and the signed-in user and configured theme remain visible.

## shared-artifact-page-008

Original test `switching accounts keeps the artifact URL and leaves the current session signed in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L277).

- **Given** A signed-in visitor is on an unavailable artifact URL containing a query and fragment.
- **When** They select Switch account.
- **Then** Sign-in opens with both redirect URLs preserving the full artifact URL, query, and fragment. The current session is not signed out.

## shared-artifact-page-009

Original test `A shared Markdown artifact displays its diagram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L291).

- **Given** A visitor opens a shared Markdown artifact containing a Mermaid diagram.
- **When** They view the rendered content and expand the diagram.
- **Then** The Markdown heading and formatting render, and the diagram appears as an image with an enabled expand action. The expanded dialog displays the diagram and “diagram.svg,” with no Copy link action.

## shared-artifact-page-010

Original test `the viewer names who can reach the artifact without opening the share menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/shared-artifact-page/__tests__/shared-artifact-page.test.tsx#L339).

- **Given** A visitor views an image artifact whose sharing status reports public access.
- **When** They view the artifact details without opening the share menu.
- **Then** The viewer shows “Image · Public access.”
