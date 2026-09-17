import type { TestContext } from "../../../../__tests__/test-context";

export class ClerkUserNotFoundTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly status = 404;
  readonly errors = [{ code: "resource_not_found", message: "User not found" }];

  constructor() {
    super("Clerk user not found");
  }
}

/** Configure both Clerk user endpoints from the test's explicit directory. */
export function mockClerkUsers<T extends { readonly id: string }>(
  context: TestContext,
  profiles: readonly T[],
): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({ data: profiles });
  context.mocks.clerk.users.getUser.mockImplementation((userId: unknown) => {
    const user = profiles.find((profile) => {
      return profile.id === userId;
    });
    return user
      ? Promise.resolve(user)
      : Promise.reject(new ClerkUserNotFoundTestError());
  });
}
