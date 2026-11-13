import { navigationAddress } from "../input/address.ts";

/** Classify submitted input without consulting history or requesting suggestions. */
export function addressSubmission(input: string): {
  readonly kind: "navigate" | "search";
  readonly url: string;
} | null {
  const url = navigationAddress(input);
  if (url) {
    return { kind: "navigate", url };
  }
  const text = input.trim();
  if (
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
  const searchUrl = new URL("https://www.google.com/search");
  searchUrl.searchParams.set("q", text);
  return { kind: "search", url: searchUrl.href };
}
