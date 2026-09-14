import { computed } from "ccstate";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { request$ } from "./hono";

// The route chooses the credential namespace; request bodies cannot override it.
export const feishuRequestPlatform$ = computed((get): FeishuPlatform => {
  const pathname = new URL(get(request$).url).pathname;
  return pathname === "/api/integrations/lark" ||
    pathname.startsWith("/api/integrations/lark/")
    ? "lark"
    : "feishu";
});
