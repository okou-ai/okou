# Lab page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [lab-page.test.tsx](lab-page.test.tsx).

## lab-page-001

Original test `Lab remains available while onboarding is required`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L39).

- **Given** Onboarding is required, the Lab and Banking switches are enabled, and a pinned private agent is available.
- **When** The user opens Lab.
- **Then** Lab remains available, Banking appears in Alpha, and the pinned agent is shown.

## lab-page-002

Original test `Lab groups active feature switches`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L70).

- **Given** A staff member opens Lab with the Lab switch enabled.
- **When** The feature list loads.
- **Then** Every available switch appears once in its rollout-stage group; Banking is in Alpha, Test OAuth Connector is in Internal, and Reset all is enabled.

## lab-page-003

Original test `Staff see presentation format enabled by default in Beta`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L116).

- **Given** A staff member opens Lab with no explicit Presentation output format setting.
- **When** The feature list loads.
- **Then** Presentation output format appears in Beta and is enabled by default.
- **Upstream change** `4411c561` (#49461) makes the upstream test `Staff see %s enabled by default in Beta` cover Presentation output format and Markdown document typography ([Registration](https://github.com/okou-ai/okou/blob/4411c561192e7c85a6c8ecf89b9578c05f9c7f66/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L116)). This scenario keeps the Presentation output format row; the Markdown document typography row is pending as `upstream-4411c561-lab-page-116-02`.

## lab-page-004

Original test `External peers cannot opt into presentation format in Lab`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L141).

- **Given** An external peer opens Lab with the Lab and Presentation output format switches enabled.
- **When** The feature list loads.
- **Then** Banking is listed, but Presentation output format is not available.
- **Upstream change** `4411c561` (#49461) makes the upstream test `External peers cannot opt into %s in Lab` cover Presentation output format and Markdown document typography ([Registration](https://github.com/okou-ai/okou/blob/4411c561192e7c85a6c8ecf89b9578c05f9c7f66/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L144)). This scenario keeps the Presentation output format row; the Markdown document typography row is pending as `upstream-4411c561-lab-page-144-02`.

## lab-page-005

Original test `Maintainer filters narrow the feature list`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L158).

- **Given** A user opens Lab and sees the full list of feature switches.
- **When** The user selects the `bingjie` maintainer filter, then returns to `All`.
- **Then** The filtered list includes Presentation Convert but excludes Banking and has a lower count; the All count remains unchanged. Returning to All restores Banking and the original switch count.

## lab-page-006

Original test `Toggle and reset a Lab override: _testOauthConnector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L196).

- **Given** A user opens Lab with Test OAuth Connector disabled by default.
- **When** The user enables it and then selects Reset all.
- **Then** The switch becomes enabled, then returns to disabled after reset.

## lab-page-007

Original test `Toggle and reset a Lab override: _dummy`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/lab-page/__tests__/lab-page.test.tsx#L196).

- **Given** A user opens Lab with Dummy enabled by default.
- **When** The user disables it and then selects Reset all.
- **Then** The switch becomes disabled, then returns to enabled after reset.
