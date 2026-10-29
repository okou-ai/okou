import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  halloweenOperationsContract,
  type HalloweenParticipant,
} from "@okouai/api-contracts/contracts/halloween";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const batch = {
  id: "00000000-0000-4000-8000-000000000001",
  capturedAt: "2026-10-30T12:05:00Z",
  participants: [
    {
      userId: "user_halloween_participant",
      email: "=campaign@example.com",
      orgId: "org_halloween_participant",
      firstPlayedAt: "2026-10-30T12:00:00Z",
      lastPlayedAt: "2026-10-30T12:04:00Z",
      rounds: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          outcome: "success",
          startedAt: "2026-10-30T12:00:00Z",
          completedAt: "2026-10-30T12:04:00Z",
        },
      ],
      decision: "pending",
      notifiedAt: null,
      rewardedAt: null,
    },
  ],
} satisfies {
  id: string;
  capturedAt: string;
  participants: HalloweenParticipant[];
};

function button(name: string) {
  const found = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!found) {
    throw new Error(`Missing button: ${name}`);
  }
  return found;
}

test("captures a batch, records a review, and exports the immutable snapshot", async () => {
  const downloads = context.mocks.browser.blobDownload();
  context.mocks.api(
    halloweenOperationsContract.capture,
    ({ body, respond }) => {
      return respond(200, { ...batch, id: body.id });
    },
  );
  context.mocks.api(halloweenOperationsContract.review, ({ body, respond }) => {
    expect(body).toMatchObject({
      userId: batch.participants[0].userId,
      decision: "winner",
    });
    return respond(200, { saved: true });
  });
  await setupPage({ context, path: "/halloween/operations" });
  await screen.findByRole("heading", { name: "Halloween participant review" });
  click(button("Capture new batch"));
  await screen.findByText(batch.participants[0].email);
  click(button("Select for reward"));
  await screen.findByText("Select for reward · Review saved");
  click(button("Export full JSON"));
  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(1);
  });
  const json = downloads.downloads[0]!;
  expect(json.filename).toMatch(/^halloween-[\da-f-]+\.json$/u);
  await expect(json.blob!.text()).resolves.toContain('"decision": "pending"');
  await expect(json.blob!.text()).resolves.toContain(
    batch.participants[0].userId,
  );
  click(button("Export CSV"));
  await waitFor(() => {
    expect(downloads.downloads).toHaveLength(2);
  });
  const csv = downloads.downloads[1]!;
  expect(csv.filename).toBe(json.filename.replace(".json", ".csv"));
  await expect(csv.blob!.text()).resolves.toContain(
    '"\'=campaign@example.com"',
  );
});

test("loads a saved batch URL with its review snapshot", async () => {
  context.mocks.api(
    halloweenOperationsContract.batch,
    ({ params, respond }) => {
      expect(params.id).toBe(batch.id);
      return respond(200, batch);
    },
  );
  await setupPage({ context, path: `/halloween/operations?batch=${batch.id}` });
  await screen.findByText(batch.participants[0].email);
  expect(screen.getByText("Pending")).toBeInTheDocument();
  expect(button("Export full JSON")).toBeEnabled();
});

test("shows the staff-access failure when capture is forbidden", async () => {
  context.mocks.api(halloweenOperationsContract.capture, ({ respond }) => {
    return respond(403, {
      error: {
        code: "FORBIDDEN",
        message: "Staff administrator access required",
      },
    });
  });
  await setupPage({ context, path: "/halloween/operations" });
  await screen.findByRole("heading", { name: "Halloween participant review" });
  click(button("Capture new batch"));
  await screen.findByText(
    "This operation couldn’t be completed. Check staff access and try again.",
  );
  expect(
    screen.queryByText(batch.participants[0].email),
  ).not.toBeInTheDocument();
  expect(button("Capture new batch")).toBeEnabled();
});
