# Team navigation

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [team-navigation.test.tsx](team-navigation.test.tsx).

## team-navigation-001

Original test `Chat connector accounts keeps agent editing available without old authorization controls:`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L16).

- **Given** The user can edit the Research Agent, and chat connector account access is enabled; the URL has no tab query.
- **When** The user opens the agent details section selector and chooses Instructions.
- **Then** Only the Profile and Instructions tabs appear, Authorization is not an option, and the URL becomes ?tab=instructions.

## team-navigation-002

Original test `Chat connector accounts keeps agent editing available without old authorization controls: ?tab=authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L16).

- **Given** The user can edit the Research Agent, and chat connector account access is enabled; the URL has ?tab=authorization.
- **When** The user opens the agent details section selector and chooses Instructions.
- **Then** Only the Profile and Instructions tabs appear, Authorization is not an option, and the URL becomes ?tab=instructions.

## team-navigation-003

Original test `Chat connector accounts preserves a member's chat access without exposing agent editing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L43).

- **Given** A member views another user's Research Agent while chat connector account access is enabled and the URL requests the authorization tab.
- **When** The member opens the agent details page.
- **Then** The member can access chat through the agent's chat link, but agent-editing tabs and the Name field are not shown.

## team-navigation-004

Original test `The agent header opens avatar customization on the current avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L87).

- **Given** The Research Agent has an avatar with an oval face, rounded-crop green hair, a neutral smile, deep skin, and a lime sweater.
- **When** The user opens avatar customization from the agent header.
- **Then** The Edit avatar dialog displays the current avatar with those face, hair, expression, skin, and sweater details.

## team-navigation-005

Original test `A member cannot customize another user's public agent avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L119).

- **Given** A member views another user's public Research Agent.
- **When** The member opens the agent profile.
- **Then** Neither avatar customization nor custom avatar creation is offered.

## team-navigation-006

Original test `An org admin cannot customize another user's private agent avatar`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L142).

- **Given** An organization admin views another user's private agent.
- **When** The admin opens the agent profile.
- **Then** Neither avatar customization nor custom avatar creation is offered.

## team-navigation-007

Original test `A user starts a chat from an agent's detail page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/team-page/__tests__/team-navigation.test.tsx#L166).

- **Given** The user is viewing the Research Agent's details.
- **When** The user follows the agent's chat link.
- **Then** The page navigates to the agent's chat and displays the prompt, “Ask me to automate workflows, manage tasks...”
