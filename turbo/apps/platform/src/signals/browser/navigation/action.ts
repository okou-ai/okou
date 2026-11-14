export type BrowserAddressAction = "submit-address" | "complete-address";

export type BrowserNavigationAction =
  "back" | "forward" | "reload" | BrowserAddressAction;

/** A failed action belongs to the page or recovery scope that invoked it. */
export class NavigationFault extends Error {
  constructor(
    readonly scope: object | null,
    cause: unknown,
  ) {
    super("The browser navigation could not be completed.", { cause });
    this.name = "NavigationFault";
  }
}
