---
name: feature-switch
description: Feature switch system guide for gating new user-facing features behind feature flags
---

# Feature Switch Skill

This skill documents the feature switch system and provides step-by-step instructions for adding new feature switches. **All new user-facing features must be gated behind a feature switch** for gradual rollout.

## When to Use

A feature switch is required when adding:

- New UI pages, sections, or sidebar navigation items
- New API endpoints exposed to users or agents
- New integrations (connectors, Slack, Telegram, etc.)
- New agent token capabilities

A feature switch is **not** required for:

- Internal refactors or code cleanup
- Test infrastructure changes
- Build/CI configuration
- Bug fixes to existing features
- Documentation updates

## How to Add a Feature Switch

### Step 1: Add a key to the enum

File: `turbo/packages/core/src/feature-switch-key.ts`

Add a new entry to `FeatureSwitchKey`:

```typescript
export enum FeatureSwitchKey {
  // ... existing keys
  MyFeature = "myFeature",
}
```

### Step 2: Register the switch

File: `turbo/packages/core/src/feature-switch.ts`

Add an entry to the `FEATURE_SWITCHES` record:

```typescript
[FeatureSwitchKey.MyFeature]: {
  maintainer: "you@okou.ai",
  enabled: false,
  enabledOrgIdHashes: STAFF_ORG_ID_HASHES, // optional: staff-only access
},
```

**Configuration options:**

| Field                | Type       | Description                                        |
| -------------------- | ---------- | -------------------------------------------------- |
| `maintainer`         | `string`   | Email of the responsible person                    |
| `enabled`            | `boolean`  | `true` = on for everyone, `false` = off by default |
| `enabledUserHashes`  | `string[]` | FNV-1a hashes of allowed user IDs                  |
| `enabledEmailHashes` | `string[]` | FNV-1a hashes of allowed emails                    |
| `enabledOrgIdHashes` | `string[]` | FNV-1a hashes of allowed org IDs                   |

**Common default states:**

- `enabled: false` — fully hidden unless enabled by a per-user API override
- `enabled: false` + `enabledOrgIdHashes: STAFF_ORG_ID_HASHES` — staff-only (most common for new features)
- `enabled: true` — on for everyone (use when feature is ready for GA)

### Step 3: Gate the feature in application code

Choose the pattern that matches where your feature is consumed.

#### Server-side (API routes)

```typescript
import { isFeatureEnabled, FeatureSwitchKey } from "@okouai/core";

// In route handler:
if (!isFeatureEnabled(FeatureSwitchKey.MyFeature, { userId, orgId })) {
  return createErrorResponse("FORBIDDEN", "Feature not available");
}
```

#### Client-side (Platform UI)

```typescript
import { FeatureSwitchKey } from "@okouai/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

// In component:
const features = useLastResolved(featureSwitch$);
const showMyFeature = features?.[FeatureSwitchKey.MyFeature] ?? false;

// Conditional rendering:
{showMyFeature && <MyFeatureComponent />}
```

#### Sidebar navigation gating

Sidebar entries are not gated declaratively. The nav item records in
`turbo/apps/platform/src/views/okou-page/sidebar.tsx` (`MANAGE_NAV`,
`FOOTER_NAV`) carry no feature-switch field. Read `featureSwitch$` in the
component that renders the entry and omit the item when the switch is off —
`turbo/apps/platform/src/views/okou-page/sidebar-account.tsx` gates the Lab
entry this way:

```typescript
const features = useLastResolved(featureSwitch$);
const labEnabled = features?.[FeatureSwitchKey.Lab] ?? false;

// In the render:
{labEnabled && <DropdownMenuItem>{/* ... */}</DropdownMenuItem>}
```

#### Connector gating

Connector definitions live in `vm0-ai/vm0-connectors`, but the platform owns
the rollout association. Add an entry to `FEATURE_SWITCH_BY_AUTH_METHOD` in
`turbo/apps/api/src/signals/services/connector-auth-method-feature-switches.ts`,
keyed by `` `${connectorSlug}\0${authMethodId}` ``:

```typescript
const FEATURE_SWITCH_BY_AUTH_METHOD = Object.freeze<
  Record<string, FeatureSwitchKey | undefined>
>({
  // ... existing entries
  "my-connector\0oauth": FeatureSwitchKey.MyConnector,
});
```

Deploy the association before publishing a method that should be gated, and
remove it once the switch graduates.

#### Agent token capability gating

In `turbo/apps/api/src/signals/auth/tokens.ts`, add to `CONDITIONAL_CAPABILITIES`:

```typescript
const CONDITIONAL_CAPABILITIES = [
  // ... existing entries
  ["my-feature:write", FeatureSwitchKey.MyFeature],
] as const satisfies readonly (readonly [Capability, FeatureSwitchKey])[];
```

## Key Files

| File                                                                            | Role                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `turbo/packages/core/src/feature-switch-key.ts`                                 | Enum of all feature switch keys                             |
| `turbo/packages/core/src/feature-switch.ts`                                     | Registry and evaluation logic                               |
| `turbo/apps/platform/src/signals/external/feature-switch.ts`                    | Client-side reactive state with override layers             |
| `turbo/apps/platform/src/views/okou-page/sidebar.tsx`                           | Sidebar nav item records (`MANAGE_NAV`, `FOOTER_NAV`)       |
| `turbo/apps/api/src/signals/services/connector-auth-method-feature-switches.ts` | Connector auth-method → feature switch rollout associations |
| `turbo/apps/api/src/signals/services/feature-switches.service.ts`               | Override loading/writing and the org-scoped key list        |
| `turbo/apps/api/src/signals/auth/tokens.ts`                                     | Token capability gating                                     |

## Override Layers

Evaluation has two layers (lowest to highest priority):

1. **Core registry** — static config in source code, evaluated against `userId` / `email` / `orgId` hashes.
2. **DB overrides** — most switches are per-user rows in
   `user_feature_switches` keyed by `(orgId, userId)`. Some switches are
   org-scoped and stored under the org sentinel user id (`ORG_SENTINEL_USER_ID`,
   `"__org__"`); `ORG_SCOPED_FEATURE_SWITCH_KEYS` currently holds
   `PiLoop` and `ReferenceImages`. Written
   via `POST /api/feature-switches` and cleared via
   `DELETE /api/feature-switches`. The Lab page lets users update or reset these
   overrides and groups the registry into Released, Beta, Alpha, and Internal
   categories. Switch keys beginning with `_` are Internal regardless of their
   rollout audience.

The same two-layer resolution applies on the server: route handlers that call
`isFeatureEnabled(..., { userId, orgId, overrides })` pass a context built by
`loadUserFeatureSwitchContext(db, orgId, userId)`.

There is **no** client-only or device-local override layer.
