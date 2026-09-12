import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// jest-dom still augments Vitest's removed single-parameter Assertion surface.
// Register its existing DOM matchers through Vitest 5's public matcher interface.
declare module "vitest" {
  interface Matchers<
    R extends void | Promise<void>,
  > extends TestingLibraryMatchers<unknown, R> {}
}
