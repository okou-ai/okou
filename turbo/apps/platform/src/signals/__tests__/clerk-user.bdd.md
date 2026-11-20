# Clerk user

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [clerk-user.test.ts](clerk-user.test.ts).

## clerk-user-001

Original test `A signed-in user settles immediately after setup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L31).

- **Given** The mocked Clerk session is signed in as user-a before setup.
- **When** Clerk user state is initialized.
- **Then** The user value resolves immediately to user-a.

## clerk-user-002

Original test `A signed-out user settles as null instead of staying pending`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L41).

- **Given** The mocked Clerk session is signed out before setup.
- **When** Clerk user state is initialized.
- **Then** The user value resolves to null rather than remaining pending.

## clerk-user-003

Original test `The transitive state defers the value instead of reporting a sign-out`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L49).

- **Given** The Clerk user value is null, and the session then enters a transition.
- **When** A reader waits for the user while transitioning, then the session signs in as user-a and the transition ends.
- **Then** The read stays pending during the transition and resolves to user-a rather than reporting sign-out.

## clerk-user-004

Original test `Consecutive transitions never expose a null between two users`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L71).

- **Given** The current user is user-a and the Clerk session enters a transition.
- **When** The session changes successively to user-b and user-c, ending each transition.
- **Then** The waiting reads resolve to user-b and then user-c, with no null value exposed between users.

## clerk-user-005

Original test `A repeated emit for the same user keeps the settled promise identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L92). · **intent review**

- **Given** Clerk user state has settled for user-a.
- **When** Clerk emits the same user again.
- **Then** The settled user read retains the same promise identity.

## clerk-user-006

Original test `An owner claims the signal before it resolves the Clerk runtime`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L101). · **intent review**

- **Given** Clerk is signed in as user-a, and an owner is initializing user state.
- **When** A reader requests the user value synchronously before owner initialization finishes.
- **Then** The read is a promise the owner can resolve and eventually resolves to user-a.

## clerk-user-007

Original test `Aborting the owner keeps the last published value and stops listening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/clerk-user.test.ts#L115). · **intent review**

- **Given** Clerk user state has settled for user-a under an active owner.
- **When** The owner is replaced, then Clerk emits while the session is transitioning.
- **Then** The last published user value remains available as the same settled promise resolving to user-a; the new event is not observed.
