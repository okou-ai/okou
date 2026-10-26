# HTTP response handling

[ccstate guide](../SKILL.md)

## HTTP Error Handling with `accept`

All HTTP calls via `apiClient$` must use the `accept` utility function. This is the **only** permitted way to handle API response status codes. Manual status checks, try-catch for HTTP errors, and direct `toast.error` calls for API failures are all forbidden in the signals layer.

### Core Pattern

`accept` takes a ts-rest call promise and a **required non-empty** array of accepted status codes. It returns a type-narrowed result containing only the accepted status codes. Any response **not** in the accept list is automatically:

1. Shown as a `toast.error` (with the server's error message), except for 401
   responses and the dedicated force-upgrade response handled by the blocking
   update dialog. A 401 still propagates without redirecting or replaying the request.
2. Thrown as an `ApiError` (so the calling code stops executing)

```typescript
import { accept } from "../../lib/accept.ts";

// Signal: clean business logic, no manual error handling
export const inviteMember$ = command(
  async ({ get, set }, email: string, role: OrgRole, signal: AbortSignal) => {
    const client = get(apiClient$)(orgInviteContract);
    const result = await accept(
      client.invite({ body: { email, role } }),
      [200],
    );
    // result type is narrowed to { status: 200, body: OrgMessageResponse }
    // If status was 400/403/500 → toast + throw already happened.
    // A 401 throws without an error toast or request replay.
    toast.success(`Invitation sent to ${email}`);
    set(refreshOrgMembers$);
  },
);
```

### accept is required — `accept` list must be explicit

Every `apiClient$` call must be wrapped in `accept`. You must declare at least one status code. This forces every call site to explicitly state what it considers success.

```typescript
// ❌ Forbidden: raw status checks
const result = await client.invite({ body });
if (result.status !== 200) {
  throw new Error("Failed");
}

// ❌ Forbidden: try-catch for HTTP errors in signals
try {
  await client.invite({ body });
} catch (error) {
  toast.error("Failed");
}

// ✅ Required: use accept
const result = await accept(client.invite({ body }), [200]);
```

### Handling specific error codes (e.g. 404 → return null)

When a specific error code has business meaning, include it in the accept list:

```typescript
export const getAgent$ = computed(async (get) => {
  const client = get(apiClient$)(agentsByIdContract);
  const result = await accept(client.get({ params: { id } }), [200, 404]);
  if (result.status === 404) return null;
  return result.body;
});
```

### Fail fast for background fetches

For `computed` (background data fetching), call `accept` directly and let errors propagate. `accept` already handles API errors by showing the server message (except for 401 responses and the dedicated force-upgrade response owned by the blocking update dialog) and throwing an `ApiError`; application code should not catch or replace that error handling.

```typescript
export const billingStatus$ = computed(async (get) => {
  const client = get(apiClient$)(billingStatusContract);
  const result = await accept(client.get(), [200]);
  return result.body;
});
```

### View layer: use loadables for state

When `accept` throws, `useLoadable` / `useLoadableSet` transitions to `{ state: 'hasError', error: ApiError }`. Views should use loadable state for loading, disabled, and success UI. Do not catch errors in the view layer, do not show replacement toasts, and do not add application-level error handling around API failures; `accept` and the authenticated client already handled the error and the flow should fail fast.

```typescript
function ScheduleForm() {
  const [loadable, save] = useLoadableSet(saveSchedule$);

  return (
    <>
      <Button
        disabled={loadable.state === "loading"}
        onClick={() => detach(save(params, pageSignal), Reason.DomCallback)}
      >
        Save
      </Button>
    </>
  );
}
```

### Summary of rules

1. **All `apiClient$` calls must use `accept`** — no exceptions
2. **`accept` list is required and non-empty** — you must declare at least one status code
3. **No manual `throw` / `try-catch` for HTTP errors in signals** — `accept` handles it
4. **No application-level API error handling** — do not catch or replace `accept` errors
5. **View layer uses loadable state for lifecycle UI** — never `.catch()` for toast or inline error handling
