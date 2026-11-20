# Artifact sharing

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [artifact-sharing.test.tsx](artifact-sharing.test.tsx).

## artifact-sharing-001

Original test `the share menu describes each audience beneath its name by default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L141).

- **Given** An owner opens sharing for a private artifact whose organization is Acme.
- **When** The owner opens the Share menu.
- **Then** The three choices are Only me (“Only you can open it”), Anyone at Acme (“Teammates can view”), and Anyone with the link (“No sign-in needed”). Only me is selected, and Copy link is enabled.

## artifact-sharing-002

Original test `owners can change three access levels separately from copying the stable app link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L166).

- **Given** An owner opens sharing for a private artifact.
- **When** The owner selects Organization, Public access, then Only me, copying the link after each change.
- **Then** Each selected access level becomes checked, and the API receives the changes in that order: organization, public, private. Each copy writes the same canonical app link; there is no text box or copied-link notice before copying, and only one permission-status read occurs.

## artifact-sharing-003

Original test `a recipient's share button copies directly without a permissions menu or mutation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L220).

- **Given** A recipient opens sharing for an artifact whose permission-status request returns not found.
- **When** The recipient clicks Share.
- **Then** The canonical app link is copied directly and “Link copied” appears, with no permissions radio group or Copy link control.

## artifact-sharing-004

Original test `owner copying uses the canonical version reference returned by the API`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L239).

- **Given** An owner opens sharing when the permission response supplies a canonical owner URL distinct from its short URL.
- **When** The owner copies the link.
- **Then** The clipboard receives the canonical owner URL returned by the API, not the short URL.

## artifact-sharing-005

Original test `An unavailable permission read keeps the audience unknown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L258).

- **Given** An owner opens sharing when reading permission status fails with a server error.
- **When** The owner clicks Share.
- **Then** “Unable to load permissions” appears; the three audience choices remain visible but disabled and unchecked, and no link is copied. The organization choice says “Anyone in your organization” without naming Acme.

## artifact-sharing-006

Original test `denied links display no artifact metadata or content`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L289).

- **Given** A user opens a shared artifact link that the server denies as unavailable.
- **When** The link is loaded.
- **Then** The page says “You can’t view this artifact” and displays no artifact metadata or embedded content.

## artifact-sharing-007

Original test `sign-in treats an artifact query as part of the same-origin return URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/artifacts-page/__tests__/artifact-sharing.test.tsx#L306).

- **Given** A signed-out user opens an artifact URL containing a redirect_url query pointing to an external site and a fragment.
- **When** The user selects Sign in.
- **Then** The browser does not navigate immediately on page load. Sign in redirects to the same-origin app sign-in page, whose return URL preserves the complete artifact path, query, and fragment rather than honoring the external redirect target.
