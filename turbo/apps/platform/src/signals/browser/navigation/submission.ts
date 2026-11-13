import { navigationAddress } from "../input/address.ts";

/** Classify submitted input without consulting history or requesting suggestions. */
export function addressSubmission(
  input: string,
  searchEnabled: boolean,
): { readonly url: string } | { readonly search: string } | null {
  const url = navigationAddress(input);
  if (url) {
    return { url };
  }
  const text = input.trim();
  if (
    !searchEnabled ||
    !text ||
    /^[a-z][\w+.-]*:/i.test(text) ||
    text.startsWith("/") ||
    text.startsWith("\\") ||
    Array.from(text).some((char) => {
      return char < " " || char === "\u007f";
    })
  ) {
    return null;
  }
  return { search: text };
}
