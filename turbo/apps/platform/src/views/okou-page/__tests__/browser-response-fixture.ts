import { vi } from "vitest";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

/** Hold a real JSON read at the browser boundary and observe the caller's first field access. */
export function holdResponseField(
  context: TestContext,
  matches: (url: URL, value: unknown) => boolean,
  field: string,
) {
  const received = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const consumed = context.mocks.deferred<void>();
  const decode = Response.prototype.json;
  vi.spyOn(Response.prototype, "json").mockImplementation(async function (
    this: Response,
  ) {
    const body: unknown = await decode.call(this);
    if (
      received.settled() ||
      !this.url ||
      !body ||
      typeof body !== "object" ||
      !Object.hasOwn(body, field)
    ) {
      return body;
    }
    const value: unknown = Reflect.get(body, field);
    if (!matches(new URL(this.url), value)) {
      return body;
    }
    received.resolve();
    await release.promise;
    Object.defineProperty(body, field, {
      enumerable: true,
      configurable: true,
      get() {
        if (!consumed.settled()) {
          consumed.resolve();
        }
        return value;
      },
    });
    return body;
  });
  return { received, release, consumed };
}
