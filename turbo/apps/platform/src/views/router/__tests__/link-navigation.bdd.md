# Link navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [link-navigation.test.tsx](link-navigation.test.tsx).

## link-navigation-001

Original test `An unknown route offers both of its destinations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L36).

- **Given** A user visits an unknown route.
- **When** The not-found page loads and the user selects Back to home.
- **Then** The page offers Back to home and Browse workflows destinations with the expected paths; selecting Back to home leaves the not-found page and shows the Agents navigation.

## link-navigation-002

Original test `The Okou error page uses Okou support`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L77).

- **Given** A user opens the Okou error page on app.okou.ai.
- **When** The page loads.
- **Then** The support link points to mailto:contact@okou.ai.

## link-navigation-003

Original test `A link activation creates one reversible navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L92).

- **Given** A user is on an unknown route with a Browse workflows link.
- **When** The user follows the link and then goes back in browser history.
- **Then** The app navigates to /workflows and then returns to the original unknown route.

## link-navigation-004

Original test `A link to the open page adds no history entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L120).

- **Given** A user is on an unknown route and follows Browse workflows.
- **When** The user selects the Workflows navigation link for the page already open, then goes back in browser history.
- **Then** Selecting the current page leaves the route at /workflows without adding a history entry; going back returns to the original unknown route.

## link-navigation-005

Original test `Meta-click leaves the internal destination to the browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L161). · **intent review**

- **Given** A user is on an agent chat page and the Agents navigation link targets /agents.
- **When** The user Meta-clicks the link.
- **Then** The app remains on the chat page with its navigation visible and the link destination remains /agents; native browser-context behavior is not verified here.

## link-navigation-006

Original test `A valid sign-in ticket returns the user home`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L187).

- **Given** A signed-out user opens a sign-in ticket URL with a valid ticket and no return destination.
- **When** The sign-in ticket is processed.
- **Then** The user is returned to / and ticket sign-in creates a session that becomes active.

## link-navigation-007

Original test `A valid sign-in ticket returns to its trusted Okou destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/router/__tests__/link-navigation.test.tsx#L209).

- **Given** A signed-out user opens a valid sign-in ticket on app.okou.ai with a trusted Okou return URL containing a path and query.
- **When** The sign-in ticket is processed.
- **Then** The browser returns to the trusted URL, preserving its path and query, and ticket sign-in is attempted.
