# Agents page avatar framing

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agents-page-avatar-framing.test.tsx](agents-page-avatar-framing.test.tsx).

## agents-page-avatar-framing-001

Original test `Center each composer avatar and pull the cast toward one size`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page-avatar-framing.test.tsx#L130). · **intent review**

- **Given** The public agent list contains a flat-haired avatar whose artwork fills 250.4/380 of its box and a tall-haired avatar whose artwork fills 383.4/380.
- **When** The page frames both avatars.
- **Then** The flat-haired artwork is shifted upward by more than 10% and scaled above 1 but below 1.25; the tall-haired artwork stays within 1% vertically and is scaled below 1 but above 0.9. The initial fill-size ratio exceeds 1.5, and the framed ratio is reduced to approximately its square root.

## agents-page-avatar-framing-002

Original test `Keep legacy avatars on the scale they already shipped with`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page-avatar-framing.test.tsx#L166). · **intent review**

- **Given** The public agent list contains an avatar using the legacy asset URL “svg:r3s2h4c1f5h.”
- **When** The page frames the legacy avatar.
- **Then** The legacy artwork keeps a scale of 1.25.

## agents-page-avatar-framing-003

Original test `Move the head to the chin baseline instead of resizing it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/agents-page/__tests__/agents-page-avatar-framing.test.tsx#L186). · **intent review**

- **Given** The public agent list contains flat-haired and tall-haired avatars with different chin positions.
- **When** The page positions their heads to align with the collar baseline.
- **Then** Both head placements translate vertically without scaling, and the two heads use different vertical offsets.
