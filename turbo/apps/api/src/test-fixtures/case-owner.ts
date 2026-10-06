import { AsyncLocalStorage } from "node:async_hooks";
import { singleton } from "../lib/singleton";

interface TestCaseOwner {
  readonly controller: AbortController;
  readonly cleanupController: AbortController;
  requestController: AbortController;
}
const ownerScope = singleton(() => {
  return new AsyncLocalStorage<TestCaseOwner>();
});

/** Optional outer fixture ownership; ordinary PG tests retain their own signal. */
export function testCaseAbortController(): AbortController | undefined {
  return ownerScope().getStore()?.requestController;
}

/** Abort foreground work but keep API-based cleanup on a live, owned signal. */
export function beginTestCaseCleanup(reason: unknown): void {
  const owner = ownerScope().getStore();
  if (owner) {
    owner.controller.abort(reason);
    owner.requestController = owner.cleanupController;
  }
}

/** Called before final native drainage and database close, including setup failure. */
export function abortTestCaseOwner(reason: unknown): void {
  const owner = ownerScope().getStore();
  owner?.controller.abort(reason);
  owner?.cleanupController.abort(reason);
}

export async function withTestCaseOwner<T>(
  controller: AbortController,
  work: () => Promise<T>,
): Promise<T> {
  return await ownerScope().run(
    {
      controller,
      cleanupController: new AbortController(),
      requestController: controller,
    },
    work,
  );
}
