# Platform lint boundaries

Platform uses error severity throughout its ESLint policy. `--max-warnings 0`
remains a guard against warnings introduced by dependencies. Oxlint owns the
general rules; ESLint owns the custom lifecycle and import boundaries.

## Requests

- Application API calls use `apiClient$`, an existing typed contract, `accept`,
  and the owning signal. Multipart bodies are supported by the contract client;
  they are not an exception. STT and Web Push both have contracts.
- Public assets and presigned object transfers use `fetchResource`. This
  boundary does not inject application tokens, client headers, or preview bypass
  headers, and always omits cookies. It preserves the supplied method, headers,
  body, cache policy, and cancellation signal. Initial locale loading may run
  before an application lifetime exists; its signal can be undefined.
- `no-direct-fetch` rejects native fetch references. Only
  `lib/resource-fetch.ts` implements the native primitive.
- The existing `signals/fetch.ts` now only exposes API navigation/base signals.

## Asynchronous ownership

`readImageDimensions` inherits the workspace dialog signal. Load, decode error,
and cancellation all release the image listeners and object URL. Browser event
adaptation uses `createDeferredPromise`; it does not justify a file exemption.

Within ESLint's application scope, `new AbortController` is reserved for
`signals/utils.ts`, the browser polyfill, and the shared test context that owns
the root test lifetime. Individual tests inherit `context.signal` or use a
stable `resetSignal()` command. `createChildAbortController()` is prohibited;
existing calls carry targeted `ccstate/no-create-child-abort-controller`
suppressions until they migrate to the signal hierarchy.

Polling and timed retries use `setLoop`. Do not implement a loop containing
`sleep`, `delay`, or a timer, including through an import alias. Tests
should await an event or operation completion instead. Testing Library's
observable UI waits remain supported. Paging, stream reads, synchronous
iteration, and a loop waiting for an explicit event are not timed polling.

The existing global ESLint exclusions for `src/mocks` and most top-level
`src/__tests__` files also exclude those files from these rules. They still
follow the polling policy; their current loops iterate data or dispatch events.
`src/__tests__/authentication-startup.test.tsx` remains in scope so its child
signals carry validated `ccstate/no-create-child-abort-controller` debt markers.
Raw primitives remain in the Web Animations, MSW, and Ably adapters that model
external browser/protocol lifetimes. These broad exclusions are separate from
the explicit primitive exceptions above.

The multipart upload retry uses `setLoop` with its existing bounded attempt
count and exponential delay. Its terminal error must propagate, so the helper's
additional transient-error retries are disabled for that operation.

## Active module state

Constructor permissions apply only at their definition files:

| Owner                 | State               | Lifetime                                |
| --------------------- | ------------------- | --------------------------------------- |
| `signals/location.ts` | `LocationOverrides` | Browser location overrides              |
| `signals/log.ts`      | `LoggerRegistry`    | Application logging registry            |
| `signals/utils.ts`    | `PromiseTracker`    | Private bookkeeping used only in Vitest |

The existing shared test teardown owns `clearAllDetached()`; see
[Test context and cleanup](./testing/app-testing.md#test-context-and-cleanup).
It awaits detached work, including work registered during teardown, without
timed polling. Production does not collect promises.

`PromiseTracker` and its instance are private to `signals/utils.ts`. They are
internal bookkeeping for `detach()` and the same `clearAllDetached()` mechanism.
Do not export the class or instance, expose its collection, or introduce another
tracker for test cases. The constructor exception applies only to this private
implementation.

## Import boundaries

`no-restricted-imports` keeps the modular Clerk and Ably runtimes out of the
eagerly loaded application bundle. `@clerk/clerk-js` stays behind
`lib/clerk-runtime.ts` and is restricted in every form; `ably` stays behind
`lib/ably-realtime.ts` and still permits type-only imports.

`@clerk/ui` is a live dependency again, used only by the auth pages and account
switching. `src/clerk-ui.ts` is the single entry allowed to import it at
runtime; it is built as its own asset by `scripts/clerk-ui.ts` and requested
through `ensureClerkUiLoaded$`. Every other `src/**` module may import the
package for types only. `scripts/check-runtime-imports.node.mjs` asserts that
boundary from the real ESLint configuration, so the entry cannot regain a lint
suppression and other entries cannot acquire a runtime import.

## Retired configuration

These entries describe removed implementations; they are not live lint policy:

- Direct-fetch exceptions for chat draft, STT, TTS, the agents page, settings
  tab, workspace general tab, API client, fetch tests, and Web Push. TTS, the old
  agents view, and `signals/__tests__/utils.test.ts` no longer exist. The fetch
  test no longer needs import-order or untyped-mock exceptions.
- The old claim that ts-rest cannot handle multipart uploads predates the
  current contract transport.
- The `custom-eslint/**/*.*` override referred to a removed local plugin tree.
- `@solana/web3.js` belonged to a retired authentication bundle; `katex`,
  `rehype-katex`, and `remark-math` belonged to retired Markdown math;
  `@tabler/icons-react` belonged to the replaced icon stack. Their historical
  removal is documented here instead of maintaining a dependency tombstone in
  `no-restricted-imports`. Current architecture still requires the modular Ably
  and Clerk runtime boundaries. `@clerk/ui` returned as a live dependency and is
  no longer a retired entry; see the import boundary above.
