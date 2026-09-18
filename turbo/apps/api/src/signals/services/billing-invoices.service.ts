import { ZipArchive } from "archiver";
import { command, computed, type Computed } from "ccstate";
import type { BillingInvoicesResponse } from "@okouai/api-contracts/contracts/billing";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";
import { delay } from "signal-timers";

import { db$ } from "../external/db";
import { listStripeInvoices } from "../external/stripe-client";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  tapError,
} from "../utils";

interface ReceiptArchive {
  readonly filename: string;
  readonly content: Buffer;
}

type ReceiptArchiveResult =
  | { readonly kind: "ok"; readonly archive: ReceiptArchive }
  | { readonly kind: "not_found" }
  | { readonly kind: "upstream_error" };

interface ReceiptEntry {
  readonly path: string;
  readonly content: Buffer;
}

interface ReceiptDownload {
  readonly id: string;
  readonly number: string | null;
  readonly url: string;
}

const RECEIPT_DOWNLOAD_CONCURRENCY = 10;
const RECEIPT_DOWNLOAD_ATTEMPTS = 3;
const RECEIPT_DOWNLOAD_RETRY_BASE_DELAY_MS = 500;

function monthlyRange(
  startMonth: string,
  endMonth: string,
): {
  readonly gte: number;
  readonly lt: number;
} {
  const startYear = Number(startMonth.slice(0, 4));
  const startMonthIndex = Number(startMonth.slice(5, 7)) - 1;
  const endYear = Number(endMonth.slice(0, 4));
  const endMonthIndex = Number(endMonth.slice(5, 7)) - 1;
  return {
    gte: Date.UTC(startYear, startMonthIndex, 1) / 1000,
    lt: Date.UTC(endYear, endMonthIndex + 1, 1) / 1000,
  };
}

function receiptFilename(invoiceNumber: string | null, id: string): string {
  const reference = (invoiceNumber ?? id).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return `receipt-${reference}.pdf`;
}

async function downloadReceipt(
  receipt: ReceiptDownload,
  signal: AbortSignal,
): Promise<ReceiptEntry | null> {
  for (let attempt = 0; attempt < RECEIPT_DOWNLOAD_ATTEMPTS; attempt += 1) {
    const response = await tapError(fetch(receipt.url, { signal }));
    signal.throwIfAborted();
    if (!response) {
      return null;
    }

    const content = await tapError(response.arrayBuffer());
    signal.throwIfAborted();
    if (response.ok) {
      if (!content) {
        return null;
      }
      return {
        path: receiptFilename(receipt.number, receipt.id),
        content: Buffer.from(content),
      };
    }

    const retryable = response.status === 429 || response.status >= 500;
    const hasAnotherAttempt = attempt + 1 < RECEIPT_DOWNLOAD_ATTEMPTS;
    if (!retryable || !hasAnotherAttempt) {
      return null;
    }
    await delay(RECEIPT_DOWNLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt, {
      signal,
    });
  }
  return null;
}

async function downloadReceipts(
  receipts: readonly ReceiptDownload[],
  signal: AbortSignal,
): Promise<readonly (ReceiptEntry | null)[]> {
  const downloaded: (ReceiptEntry | null | undefined)[] = Array.from({
    length: receipts.length,
  });
  const workerCount = Math.min(RECEIPT_DOWNLOAD_CONCURRENCY, receipts.length);

  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIndex) => {
      for (
        let receiptIndex = workerIndex;
        receiptIndex < receipts.length;
        receiptIndex += workerCount
      ) {
        const receipt = receipts[receiptIndex];
        if (!receipt) {
          return;
        }
        downloaded[receiptIndex] = await downloadReceipt(receipt, signal);
      }
    }),
  );

  return downloaded.map((entry) => {
    return entry ?? null;
  });
}

async function assembleReceiptArchive(
  entries: readonly ReceiptEntry[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = createDeferredPromise<Buffer>(signal);

  archive.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  archive.on("end", () => {
    if (!done.settled()) {
      done.resolve(Buffer.concat(chunks));
    }
  });
  archive.on("error", (error) => {
    if (!done.settled()) {
      done.reject(error);
    }
  });

  const appendResult = safeSync(() => {
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.path });
    }
  });
  if ("error" in appendResult) {
    if (!done.settled()) {
      done.reject(appendResult.error);
    }
    return await done.promise;
  }

  const finalized = (async () => {
    await onRejection(archive.finalize(), (error) => {
      if (!done.settled()) {
        done.reject(error);
      }
    });
    signal.throwIfAborted();
    return await done.promise;
  })();
  return await Promise.race([done.promise, finalized]);
}

export function orgInvoices(
  orgId: string,
): Computed<Promise<BillingInvoicesResponse>> {
  return computed(async (get): Promise<BillingInvoicesResponse> => {
    const db = get(db$);

    const [row] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (!row?.stripeCustomerId) {
      return { invoices: [] };
    }

    const result = await listStripeInvoices(row.stripeCustomerId);

    return {
      invoices: result.map((inv) => {
        return {
          id: inv.id,
          number: inv.number,
          date: inv.created,
          amount: inv.amount_paid,
          status: inv.status,
          hostedInvoiceUrl: inv.hosted_invoice_url,
        };
      }),
    };
  });
}

export const downloadOrgReceiptArchive$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly startMonth: string;
      readonly endMonth: string;
    },
    signal: AbortSignal,
  ): Promise<ReceiptArchiveResult> => {
    const db = get(db$);
    const [row] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!row?.stripeCustomerId) {
      return { kind: "not_found" };
    }

    const invoices = await listStripeInvoices(
      row.stripeCustomerId,
      monthlyRange(args.startMonth, args.endMonth),
    );
    signal.throwIfAborted();
    const receipts = invoices.flatMap((invoice): readonly ReceiptDownload[] => {
      if (!invoice.invoice_pdf) {
        return [];
      }
      return [
        {
          id: invoice.id,
          number: invoice.number,
          url: invoice.invoice_pdf,
        },
      ];
    });
    if (receipts.length === 0) {
      return { kind: "not_found" };
    }

    const downloaded = await downloadReceipts(receipts, signal);
    signal.throwIfAborted();
    if (
      downloaded.some((entry) => {
        return entry === null;
      })
    ) {
      return { kind: "upstream_error" };
    }
    const entries = downloaded.filter((entry) => {
      return entry !== null;
    });

    return {
      kind: "ok",
      archive: {
        filename:
          args.startMonth === args.endMonth
            ? `receipts-${args.startMonth}.zip`
            : `receipts-${args.startMonth}-to-${args.endMonth}.zip`,
        content: await assembleReceiptArchive(entries, signal),
      },
    };
  },
);
