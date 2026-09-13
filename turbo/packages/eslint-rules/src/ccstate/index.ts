/**
 * Custom ESLint plugin for ccstate patterns.
 *
 * This plugin enforces architectural patterns for the ccstate-based app:
 * - signal-dollar-suffix: Signal variables must end with $
 * - no-export-state: Don't export state() directly
 * - signal-check-await: Check AbortSignal after await in commands
 * - tsx-in-views: TSX files only allowed in views/
 * - no-catch-abort: Enforce throwIfAbort in catch blocks
 * - no-package-variable: Prevent mutable vars at package scope
 * - no-get-signal: Prevent getting AbortSignal from state
 * - no-computed-signal: Prevent computed callbacks from consuming AbortSignal
 * - test-context-in-hooks: Ensure testContext() in test hooks
 * - computed-const-args-package-scope: Enforce package scope for constant functions
 * - no-store-in-params: Prevent Store type in function params
 * - no-side-effect-in-render: Prevent side-effect calls (set, detach) directly in render
 * - command-async-signal: Async commands must accept AbortSignal as last param
 * - no-command-in-command: Prevent runtime command creation inside commands
 * - no-getter-setter-params: Functions must not accept ccstate Getter/Setter — use command()
 * - no-accessor-escape: ccstate get/set accessors must only be called directly
 * - no-new-abort-controller: Disallow new AbortController() — use signal hierarchy
 * - no-create-child-abort-controller: Disallow createChildAbortController() lifecycle escape hatches
 * - no-direct-local-storage: Disallow direct localStorage access — use localStorageSignals()
 * - no-direct-session-storage: Disallow direct sessionStorage access — use sessionStorageSignals()
 * - no-detach-in-signals: Disallow detach() in signals/ — use await or signal chain
 * - no-direct-fetch: Require typed API clients or the resource transport
 * - no-empty-promise-catch: Disallow .catch(() => {}) — use detach() for proper promise tracking
 * - no-test-delay: Disallow manual delays/timers in tests — use createDeferredPromise + waitFor
 * - no-manual-mock-cleanup: Disallow manual vi.*AllMocks()/unstub cleanup — Vitest config owns it
 * - no-test-after-each: Disallow file-level afterEach cleanup in platform tests
 * - require-accept: Enforce that apiClient$ calls are wrapped in accept()
 * - no-get-by-role-name: Avoid *ByRole(role, { name }) for text-content roles — causes ~300ms/call slowdown in happy-dom
 * - no-react-class-component: Disallow React class components — use function components with hooks
 * - prefer-ui-components: Disallow raw button/input/textarea styled like a @okouai/ui component
 */

import signalDollarSuffix from "./rules/signal-dollar-suffix.ts";
import noExportState from "./rules/no-export-state.ts";
import signalCheckAwait from "./rules/signal-check-await.ts";
import tsxInViews from "./rules/tsx-in-views.ts";
import noCatchAbort from "./rules/no-catch-abort.ts";
import noPackageVariable from "./rules/no-package-variable.ts";
import noGetSignal from "./rules/no-get-signal.ts";
import noComputedSignal from "./rules/no-computed-signal.ts";
import testContextInHooks from "./rules/test-context-in-hooks.ts";
import computedConstArgsPackageScope from "./rules/computed-const-args-package-scope.ts";
import noStoreInParams from "./rules/no-store-in-params.ts";
import setupPageRender from "./rules/setup-page-render.ts";
import noSideEffectInRender from "./rules/no-side-effect-in-render.ts";
import commandAsyncSignal from "./rules/command-async-signal.ts";
import noCommandInCommand from "./rules/no-command-in-command.ts";
import noGetterSetterParams from "./rules/no-getter-setter-params.ts";
import noAccessorEscape from "./rules/no-accessor-escape.ts";
import noNewAbortController from "./rules/no-new-abort-controller.ts";
import noCreateChildAbortController from "./rules/no-create-child-abort-controller.ts";
import noNewPromise from "./rules/no-new-promise.ts";
import noDirectLocalStorage from "./rules/no-direct-local-storage.ts";
import noDirectSessionStorage from "./rules/no-direct-session-storage.ts";
import noDetachInSignals from "./rules/no-detach-in-signals.ts";
import noDirectFetch from "./rules/no-direct-fetch.ts";
import noManualPolling from "./rules/no-manual-polling.ts";
import noEmptyPromiseCatch from "./rules/no-empty-promise-catch.ts";
import noVoidStatement from "./rules/no-void-statement.ts";
import noAbortSwallower from "./rules/no-abort-swallower.ts";
import noTestDelay from "./rules/no-test-delay.ts";
import noManualMockCleanup from "./rules/no-manual-mock-cleanup.ts";
import noTestAfterEach from "./rules/no-test-after-each.ts";
import requireAccept from "./rules/require-accept.ts";
import requireClientSignal from "./rules/require-client-signal.ts";
import noGetByRoleName from "./rules/no-get-by-role-name.ts";
import noUserClearTab from "./rules/no-user-clear-tab.ts";
import noDuplicateRouteParam from "./rules/no-duplicate-route-param.ts";
import noMockApiRawAsync from "./rules/no-mockapi-raw-async.ts";
import noReactClassComponent from "./rules/no-react-class-component.ts";
import preferUiComponents from "./rules/prefer-ui-components.ts";

const plugin = {
  meta: {
    name: "ccstate",
    version: "1.0.0",
  },
  rules: {
    "signal-dollar-suffix": signalDollarSuffix,
    "no-export-state": noExportState,
    "signal-check-await": signalCheckAwait,
    "tsx-in-views": tsxInViews,
    "no-catch-abort": noCatchAbort,
    "no-package-variable": noPackageVariable,
    "no-get-signal": noGetSignal,
    "no-computed-signal": noComputedSignal,
    "test-context-in-hooks": testContextInHooks,
    "computed-const-args-package-scope": computedConstArgsPackageScope,
    "no-store-in-params": noStoreInParams,
    "setup-page-render": setupPageRender,
    "no-side-effect-in-render": noSideEffectInRender,
    "command-async-signal": commandAsyncSignal,
    "no-command-in-command": noCommandInCommand,
    "no-getter-setter-params": noGetterSetterParams,
    "no-accessor-escape": noAccessorEscape,
    "no-new-abort-controller": noNewAbortController,
    "no-create-child-abort-controller": noCreateChildAbortController,
    "no-new-promise": noNewPromise,
    "no-direct-local-storage": noDirectLocalStorage,
    "no-direct-session-storage": noDirectSessionStorage,
    "no-detach-in-signals": noDetachInSignals,
    "no-direct-fetch": noDirectFetch,
    "no-manual-polling": noManualPolling,
    "no-empty-promise-catch": noEmptyPromiseCatch,
    "no-void-statement": noVoidStatement,
    "no-abort-swallower": noAbortSwallower,
    "no-test-delay": noTestDelay,
    "no-manual-mock-cleanup": noManualMockCleanup,
    "no-test-after-each": noTestAfterEach,
    "require-accept": requireAccept,
    "require-client-signal": requireClientSignal,
    "no-get-by-role-name": noGetByRoleName,
    "no-user-clear-tab": noUserClearTab,
    "no-duplicate-route-param": noDuplicateRouteParam,
    "no-mockapi-raw-async": noMockApiRawAsync,
    "no-react-class-component": noReactClassComponent,
    "prefer-ui-components": preferUiComponents,
  },
};

export default plugin;
