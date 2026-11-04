import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

export function signupControl(
  role: "button" | "link",
  name: string,
): HTMLElement {
  const control = queryAllByRoleFast(role).find((element) => {
    return (
      element.textContent?.trim() === name ||
      element.getAttribute("aria-label") === name
    );
  });
  if (!control) {
    throw new Error(`Signup ${role} "${name}" was not found`);
  }
  return control;
}
