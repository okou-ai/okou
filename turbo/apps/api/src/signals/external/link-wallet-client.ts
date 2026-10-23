import { Link, LinkResponseError, LinkTransportError } from "@stripe/link-sdk";
import * as z from "zod";

import { settleIncludingAbort } from "../utils";

// Keep SDK declarations inside the gateway; callers own OAuth and the transport
// policy, and receive only values validated by the wallet provider boundary.
export type LinkWalletSpendRequest =
  | {
      readonly operation: "spend_create";
      readonly body: {
        readonly idempotency_key: string;
        readonly amount: number;
        readonly currency: string;
        readonly merchant_name: string;
        readonly merchant_url: string;
        readonly context: string;
        readonly credential_type: "card";
        readonly request_approval: true;
        readonly test: boolean;
        readonly totals: {
          type: "total";
          display_text: string;
          amount: number;
        }[];
      };
    }
  | {
      readonly operation: "spend_read" | "spend_cancel";
      readonly id: string;
    };

export type LinkWalletReadRequest =
  | {
      readonly operation: "transactions_read";
      readonly query: {
        readonly limit?: number;
        readonly starting_after?: string;
        readonly start_date?: string;
        readonly end_date?: string;
        readonly category?: string;
      };
    }
  | { readonly operation: "payment_methods_read" | "user_info_read" }
  | { readonly operation: "payment_method_read"; readonly id: string };

export type LinkWalletSdkRequest =
  | LinkWalletReadRequest
  | LinkWalletSpendRequest
  | {
      readonly operation: "spend_approval" | "spend_credentials";
      readonly id: string;
    };

const validationIssuesSchema = z.object({
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      code: z.string(),
    }),
  ),
});

export class LinkWalletSdkResponseError extends Error {
  readonly issues;

  constructor(cause: unknown) {
    super("Link SDK rejected the provider response");
    const parsed = validationIssuesSchema.safeParse(cause);
    this.issues = parsed.success ? parsed.data.issues : undefined;
  }
}

export async function callLinkWalletSdk(
  accessToken: string,
  request: LinkWalletSdkRequest,
  fetchImplementation: typeof globalThis.fetch,
): Promise<unknown> {
  // A fixed token leaves rotating refresh and replay decisions with our server.
  const link = new Link({ accessToken, fetch: fetchImplementation });
  const result = await settleIncludingAbort(async () => {
    switch (request.operation) {
      case "transactions_read": {
        return await link.transactions.list({
          ...request.query,
          origin: "link",
        });
      }
      case "payment_methods_read": {
        return await link.paymentMethods.list();
      }
      case "payment_method_read": {
        return await link.paymentMethods.retrieve(request.id);
      }
      case "user_info_read": {
        return await link.userInfo.retrieve();
      }
      case "spend_create": {
        return await link.spendRequests.create(request.body);
      }
      case "spend_read": {
        // Do not request card or payment-token expansions.
        return await link.spendRequests.retrieve(
          encodeURIComponent(request.id),
        );
      }
      case "spend_credentials": {
        return await link.spendRequests.retrieve(
          encodeURIComponent(request.id),
          {
            include: ["card"],
          },
        );
      }
      case "spend_cancel": {
        return await link.spendRequests.cancel(encodeURIComponent(request.id));
      }
      case "spend_approval": {
        return await link.spendRequests.requestApproval(
          encodeURIComponent(request.id),
        );
      }
    }
  });
  if (result.ok) {
    return result.value;
  }
  const error = result.error;
  if (error instanceof LinkTransportError && error.cause instanceof Error) {
    // Preserve the transport's redacted domain error or caller cancellation.
    throw error.cause;
  }
  if (error instanceof LinkResponseError) {
    // SDK messages can contain provider values; expose only validation paths.
    throw new LinkWalletSdkResponseError(error.cause);
  }
  throw error;
}
