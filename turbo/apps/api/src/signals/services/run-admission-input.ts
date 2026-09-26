/** Captured old inputs must never fall through to a supported launch variant. */
export function isUnsupportedRunAdmission(
  association: { readonly kind: string } | undefined,
): boolean {
  return (
    association !== undefined &&
    association.kind !== "user_message" &&
    association.kind !== "automation_event"
  );
}
