import type { ZodType } from "zod";
import { orgContract } from "../contracts/org-routes";
import { userPreferencesContract } from "../contracts/user-preferences";
import { apiErrorSchema } from "../contracts/api-error";
import { androidUpgradeRequiredSchema } from "../contracts/android-client-compatibility";

interface KotlinRouteBinding {
  readonly name: string;
  readonly response: string;
  readonly request?: string;
  readonly route: {
    readonly method: string;
    readonly path: string;
    readonly body?: ZodType;
    readonly query?: unknown;
    readonly pathParams?: unknown;
    readonly responses: Readonly<Record<number, ZodType>>;
  };
}

/** The selected native bootstrap surface, not an export of every Web contract. */
export const kotlinRouteBindings: readonly KotlinRouteBinding[] = [
  { name: "organization", response: "Organization", route: orgContract.get },
  {
    name: "preferences",
    response: "UserPreferences",
    route: userPreferencesContract.get,
  },
  {
    name: "initializePreferences",
    response: "UserPreferences",
    request: "InitializePreferencesRequest",
    route: userPreferencesContract.initialize,
  },
];

export const kotlinTypeBindings: readonly {
  readonly name: string;
  readonly schema: ZodType;
  readonly direction: "input" | "output";
}[] = [
  {
    name: "Organization",
    schema: orgContract.get.responses[200],
    direction: "output",
  },
  {
    name: "UserPreferences",
    schema: userPreferencesContract.get.responses[200],
    direction: "output",
  },
  {
    name: "InitializePreferencesRequest",
    schema: userPreferencesContract.initialize.body,
    direction: "input",
  },
  { name: "ApiError", schema: apiErrorSchema, direction: "output" },
  {
    name: "AndroidUpgradeRequired",
    schema: androidUpgradeRequiredSchema,
    direction: "output",
  },
];
