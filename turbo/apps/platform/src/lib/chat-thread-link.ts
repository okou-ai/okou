/** The canonical production App, which a link copied from it names. */
const PRODUCTION_APP_ORIGIN = "https://app.okou.ai";

/**
 * `ROUTES.chat` written out: an optional http(s) origin, then exactly
 * `/chats/<lowercase uuid>` with at most a trailing slash, an optional query
 * and an optional hash. Credentials or any deeper path leave the link
 * external.
 */
const CHAT_THREAD_LINK =
  /^(https?:\/\/[^/?#@\\\s]+)?\/chats\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:\?([^#\s]*))?(?:#(\S*))?$/u;

export interface ChatThreadLink {
  readonly threadId: string;
  readonly searchParams?: URLSearchParams;
  readonly hash?: string;
}

/**
 * The chat thread a link opens inside this App, with the query and hash it
 * carries, or null for any other link.
 *
 * A relative `/chats/<id>` link resolves against this App. An absolute one
 * counts only when it names this App's own origin or the production App.
 */
export function parseChatThreadLink(
  href: string,
  currentOrigin: string,
): ChatThreadLink | null {
  const match = CHAT_THREAD_LINK.exec(href);
  if (!match) {
    return null;
  }
  const [, origin, threadId, search, hash] = match;
  if (threadId === undefined) {
    return null;
  }
  if (origin !== undefined) {
    if (!URL.canParse(origin)) {
      return null;
    }
    const linkOrigin = new URL(origin).origin;
    if (linkOrigin !== currentOrigin && linkOrigin !== PRODUCTION_APP_ORIGIN) {
      return null;
    }
  }
  return {
    threadId,
    ...(search ? { searchParams: new URLSearchParams(search) } : {}),
    ...(hash ? { hash } : {}),
  };
}
