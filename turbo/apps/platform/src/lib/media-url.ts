/** URL shape predicates shared by markdown rendering and tree preparation. */

/**
 * Only `http:` / `https:` URLs are safe to render as `<img src>` or `<video src>`.
 * Blocks `javascript:`, `data:`, `file:`, etc. in assistant-rendered markdown.
 */
export function isSafeMediaUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
