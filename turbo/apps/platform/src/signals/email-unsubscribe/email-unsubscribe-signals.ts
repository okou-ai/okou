import { command, computed, state } from "ccstate";
import { emailUnsubscribeContract } from "@okouai/api-contracts/client/email-unsubscribe";
import { apiClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import { accept } from "../../lib/accept.ts";

type EmailUnsubscribeStatus = "idle" | "submitting" | "done" | "error";

export const emailUnsubscribeToken$ = computed((get) => {
  return get(searchParams$).get("token") ?? "";
});

const internalStatus$ = state<EmailUnsubscribeStatus>("idle");

export const emailUnsubscribeStatus$ = computed((get) => {
  return get(internalStatus$);
});

export const resetEmailUnsubscribeState$ = command(({ set }) => {
  set(internalStatus$, "idle");
});

export const confirmEmailUnsubscribe$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const token = get(emailUnsubscribeToken$);
    if (!token) {
      set(internalStatus$, "error");
      return;
    }

    set(internalStatus$, "submitting");
    const result = await accept(
      get(apiClient$)(emailUnsubscribeContract).unsubscribe({
        query: { token },
        body: undefined,
        fetchOptions: { signal },
      }),
      [200, 400],
    );
    signal.throwIfAborted();
    set(internalStatus$, result.status === 200 ? "done" : "error");
  },
);
