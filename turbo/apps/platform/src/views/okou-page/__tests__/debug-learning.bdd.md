# Debug learning

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [debug-learning.test.tsx](debug-learning.test.tsx).

## debug-learning-001

Original test `runs the current default agent's official Learning while its nightly schedule is paused`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L110).

- **Given** The current default agent has an installed official Learning workflow, alongside a same-name custom workflow and workflows belonging to other agents. Its nightly schedule is paused.
- **When** The user opens Debug and runs Learning.
- **Then** The official Learning automation for the current default agent is queued, a link opens its chat, and the run button is disabled.
- **Upstream change** `ec5330db` (#49438) gates Debug Learning on the agent-suggestion rollout instead of the retired proactive-learning rollout ([Registration](https://github.com/okou-ai/okou/blob/ec5330dbee67ad46e9dee4e000ba92863b223681/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L104)). Titles and visible behavior in this file are otherwise unchanged; set up every scenario in this file under the agent-suggestion rollout.

## debug-learning-002

Original test `explains the installation prerequisite instead of running a same-name custom workflow`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L173).

- **Given** Only a same-name custom Learning workflow is available; the official Learning installation is absent.
- **When** The user opens Debug.
- **Then** The app explains, “Enable Learning in Preferences before running it here,” and the run button is disabled rather than running the custom workflow.

## debug-learning-003

Original test `keeps an uncertain submission disabled rather than replaying it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L187).

- **Given** Official Learning is available in Debug.
- **When** The user starts Learning and the request response cannot be confirmed because the connection fails.
- **Then** The app reports, “The request could not be confirmed,” and leaves the run button disabled instead of replaying the request.

## debug-learning-004

Original test `dismissal cancels a pending Learning request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L211).

- **Given** Official Learning is available and its run request is still pending.
- **When** The user dismisses Settings with Escape.
- **Then** The pending request is canceled, and the run button remains disabled while it is in flight.

## debug-learning-005

Original test `dismissal also cancels Learning discovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L247).

- **Given** Learning discovery is still pending when the user opens Debug.
- **When** The user dismisses Settings with Escape.
- **Then** The pending discovery request is canceled.

## debug-learning-006

Original test `does not offer Learning outside its rollout`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L271).

- **Given** The user opens Debug while Learning is outside its rollout.
- **When** The Debug page loads.
- **Then** No Learning region is offered.
- **Upstream change** `ec5330db` (#49438) makes the agent-suggestion rollout the rollout that controls Debug Learning ([Registration](https://github.com/okou-ai/okou/blob/ec5330dbee67ad46e9dee4e000ba92863b223681/turbo/apps/platform/src/views/okou-page/__tests__/debug-learning.test.tsx#L271)).
