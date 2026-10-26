import { Button } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  captureHalloweenBatch$,
  downloadHalloweenBatch$,
  halloweenBatch$,
  halloweenReviewed$,
  reviewHalloweenAccount$,
} from "../../signals/halloween/halloween-operations.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import type { HalloweenParticipant } from "@okouai/api-contracts/contracts/halloween";

// Internal campaign operations, intentionally English like the event itself.
const copy = {
  title: "Halloween participant review",
  back: "Back to Okou",
  subtitle:
    "Staff administrators only. Capture an immutable account list, export it, and record your review decisions.",
  capture: "Capture new batch",
  csv: "Export CSV",
  json: "Export full JSON",
  empty:
    "Capture a batch to load linked participants. Anonymous rounds become contactable only after account association.",
  snapshot:
    "This is the original batch snapshot. Capture a new batch to include later results and current review decisions.",
  paused:
    "Notifications and Pro grants are not enabled. Saving a review decision does not send an email or issue a reward.",
  winner: "Select for reward",
  notSelected: "Not selected",
  pending: "Pending",
  saved: "Review saved",
  account: "Account",
  rounds: "Rounds",
  review: "Review",
  error:
    "This operation couldn’t be completed. Check staff access and try again.",
  noEmail: "No account email available",
  final: "Final result",
  noParticipants: "No linked participants in this batch.",
} as const;
function Participant({
  participant: p,
}: {
  participant: HalloweenParticipant;
}) {
  const reviewed = useGet(halloweenReviewed$);
  const signal = useGet(pageSignal$);
  const [operation, review] = useLoadableSet(reviewHalloweenAccount$);
  const locked = Boolean(p.notifiedAt || p.rewardedAt);
  const decision = reviewed[p.userId] ?? p.decision;
  return (
    <tr className="border-t border-border align-top">
      <td className="p-4">
        <div className="text-sm font-medium">{p.email ?? copy.noEmail}</div>
        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {p.userId}
        </div>
        <div className="mt-2 text-xs text-muted-foreground">
          {p.firstPlayedAt} — {p.lastPlayedAt}
        </div>
      </td>
      <td className="p-4 text-sm">
        <details>
          <summary className="cursor-pointer">
            {p.rounds.length} {copy.rounds}
          </summary>
          <ul className="mt-2 space-y-2 text-xs">
            {p.rounds.map((round) => {
              return (
                <li key={round.id}>
                  {round.outcome} · {round.startedAt}
                </li>
              );
            })}
          </ul>
        </details>
      </td>
      <td className="p-4">
        <p className="mb-3 text-sm">
          {decision === "pending"
            ? copy.pending
            : decision === "winner"
              ? copy.winner
              : copy.notSelected}
          {reviewed[p.userId] ? ` · ${copy.saved}` : ""}
          {locked ? ` · ${copy.final}` : ""}
        </p>
        {!locked && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="neutral"
              disabled={operation.state === "loading"}
              onClick={() => {
                detach(review(p.userId, "winner", signal), Reason.DomCallback);
              }}
            >
              {copy.winner}
            </Button>
            <Button
              size="sm"
              variant="quiet"
              disabled={operation.state === "loading"}
              onClick={() => {
                detach(
                  review(p.userId, "not_selected", signal),
                  Reason.DomCallback,
                );
              }}
            >
              {copy.notSelected}
            </Button>
          </div>
        )}
        {operation.state === "hasError" && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {copy.error}
          </p>
        )}
      </td>
    </tr>
  );
}
export function HalloweenOperationsPage() {
  const batch = useGet(halloweenBatch$);
  const signal = useGet(pageSignal$);
  const [operation, capture] = useLoadableSet(captureHalloweenBatch$);
  const download = useSet(downloadHalloweenBatch$);
  return (
    <main className="mx-auto max-w-6xl p-6 sm:p-10">
      <Link pathname="/" className="text-sm text-muted-foreground underline">
        {copy.back}
      </Link>
      <h1 className="mt-8 text-3xl font-semibold">{copy.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{copy.subtitle}</p>
      <p className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
        {copy.paused}
      </p>
      <div className="my-6 flex flex-wrap gap-3">
        <Button
          pending={operation.state === "loading"}
          onClick={() => {
            detach(capture(signal), Reason.DomCallback);
          }}
        >
          {copy.capture}
        </Button>
        {batch && (
          <>
            <Button
              variant="neutral"
              onClick={() => {
                download("csv");
              }}
            >
              {copy.csv}
            </Button>
            <Button
              variant="neutral"
              onClick={() => {
                download("json");
              }}
            >
              {copy.json}
            </Button>
          </>
        )}
      </div>
      {operation.state === "hasError" && (
        <p role="alert" className="mb-5 text-sm text-destructive">
          {copy.error}
        </p>
      )}
      {batch ? (
        <>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {batch.id} · {batch.capturedAt}
          </p>
          <p className="my-3 text-sm text-muted-foreground">{copy.snapshot}</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-left">
              <thead className="bg-card">
                <tr>
                  <th className="p-4">{copy.account}</th>
                  <th className="p-4">{copy.rounds}</th>
                  <th className="p-4">{copy.review}</th>
                </tr>
              </thead>
              <tbody>
                {batch.participants.map((p) => {
                  return <Participant key={p.userId} participant={p} />;
                })}
              </tbody>
            </table>
            {batch.participants.length === 0 && (
              <p className="p-8 text-sm text-muted-foreground">
                {copy.noParticipants}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="mt-10 text-sm text-muted-foreground">{copy.empty}</p>
      )}
    </main>
  );
}
