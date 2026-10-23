import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  jobsContract,
  type Job,
  type JobInputCreate,
} from "@okouai/api-contracts/contracts/jobs";
import {
  userPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@okouai/api-contracts/contracts/user-permission-grants";
import { proactiveJobsContract } from "@okouai/api-contracts/contracts/proactive-jobs";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function queryControl(
  name: string | RegExp,
  role: "button" | "tab" | "link" = "button",
  container: ParentNode = document.body,
) {
  return (
    queryAllByRoleFast(role, container).find((element) => {
      const label =
        element.getAttribute("aria-label") ?? element.textContent?.trim() ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    }) ?? null
  );
}
function control(
  name: string | RegExp,
  role: "button" | "tab" | "link" = "button",
  container: ParentNode = document.body,
) {
  const element = queryControl(name, role, container);
  if (!element) {
    throw new Error(
      `Missing ${role}: ${name}; available: ${queryAllByRoleFast(
        role,
        container,
      )
        .map((item) => {
          return item.textContent;
        })
        .join(" | ")}`,
    );
  }
  return element;
}
async function findControl(
  name: string | RegExp,
  role: "button" | "tab" | "link" = "button",
  container: ParentNode = document.body,
) {
  return await waitFor(() => {
    return control(name, role, container);
  });
}

const agentId = "c0000000-0000-4000-a000-000000000001";
const jobId = "a0000000-0000-4000-a000-000000000001";
const resultId = "a0000000-0000-4000-a000-000000000002";
function makeJob(status: Job["status"] = "waiting_decision"): Job {
  return {
    id: jobId,
    title: "Research customers",
    objective: "Deliver ten verified prospects",
    sourceReferences: [],
    status,
    work: {
      progress: "Verified eight prospects",
      explanation:
        status === "waiting_decision"
          ? "Which region should I prioritize?"
          : "",
      authorization: null,
      processedInputIds: [],
      currentResultId: status === "completed" ? resultId : null,
    },
    authorizationRequests: [],
    inputs: [],
    results:
      status === "completed"
        ? [
            {
              id: resultId,
              text: "Ten verified prospects are ready",
              references: [
                { title: "Prospect report", url: "https://example.com/report" },
              ],
              publishedAt: "2026-10-22T00:00:00.000Z",
            },
          ]
        : [],
    viewedResultIds: [],
    hasPendingInput: false,
    hasUnseenResult: status === "completed",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  };
}
function mockJob(initial = makeJob(), failFirstReply = false) {
  let job = initial;
  let failed = false;
  const replies: JobInputCreate[] = [];
  context.mocks.api(jobsContract.list, ({ query, respond }) => {
    const included =
      query.filter === "archived"
        ? job.status === "archived"
        : query.filter === "history"
          ? job.status === "completed" && !job.hasUnseenResult
          : job.status !== "archived" &&
            (job.status !== "completed" ||
              job.hasUnseenResult ||
              job.hasPendingInput);
    return respond(200, { jobs: included ? [job] : [], nextAfter: null });
  });
  context.mocks.api(jobsContract.get, ({ respond }) => {
    return respond(200, job);
  });
  context.mocks.api(jobsContract.input, ({ body, respond }) => {
    replies.push(body);
    if (failFirstReply && !failed) {
      failed = true;
      return respond(409, {
        error: { code: "CONFLICT", message: "Please retry the saved reply" },
      });
    }
    job = {
      ...job,
      inputs: [
        ...job.inputs,
        {
          ...body,
          authorUserId: "user_12345678",
          createdAt: "2026-10-22T00:01:00.000Z",
        },
      ],
      hasPendingInput: true,
    };
    return respond(200, job);
  });
  context.mocks.api(jobsContract.viewed, ({ body, respond }) => {
    job = {
      ...job,
      viewedResultIds: [...job.viewedResultIds, body.resultId],
      hasUnseenResult: body.resultId !== job.work.currentResultId,
    };
    return respond(200, job);
  });
  context.mocks.api(jobsContract.archive, ({ respond }) => {
    job = { ...job, status: "archived" };
    return respond(200, job);
  });
  return { replies };
}
async function setupJobs() {
  await setupPage({
    context,
    path: `/agents/${agentId}/chat`,
    featureSwitches: { [FeatureSwitchKey.ProactiveJobs]: true },
  });
  return await findControl("Jobs", "tab");
}

test("opens a Job in a home dialog, saves its reply, and restores focus on Escape", async () => {
  const user = userEvent.setup();
  const fixture = mockJob();
  const tab = await setupJobs();
  await waitFor(() => {
    return expect(tab).toHaveAttribute("aria-selected", "true");
  });
  const card = await findControl(/Research customers/, "button");
  await user.click(card);
  const dialog = await screen.findByRole("dialog", {
    name: "Research customers",
  });
  expect(
    within(dialog).getByText("Deliver ten verified prospects"),
  ).toBeInTheDocument();
  expect(
    queryControl(/conversation|thread|chat/i, "link", dialog),
  ).not.toBeInTheDocument();
  await fill(
    within(dialog).getByRole("textbox", { name: "Reply" }),
    "Focus on Europe",
  );
  click(control("Save reply", "button", dialog));
  await within(dialog).findByText("Saved for the next evaluation");
  expect(fixture.replies).toMatchObject([
    { kind: "reply", text: "Focus on Europe" },
  ]);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  expect(card).toHaveFocus();
});

test("retains a failed reply draft and reuses its identity on retry", async () => {
  const fixture = mockJob(makeJob(), true);
  await setupJobs();
  click(await findControl(/Research customers/, "button"));
  const field = await screen.findByRole("textbox", { name: "Reply" });
  await fill(field, "Use this exact scope");
  click(control("Save reply", "button"));
  await screen.findByText("Please retry the saved reply");
  expect(field).toHaveValue("Use this exact scope");
  expect(
    screen.queryByText("Saved for the next evaluation"),
  ).not.toBeInTheDocument();
  click(control("Save reply", "button"));
  await screen.findByText("Saved for the next evaluation");
  expect(fixture.replies).toHaveLength(2);
  expect(fixture.replies[0]).toStrictEqual(fixture.replies[1]);
  expect(field).toHaveValue("");
});

test("keeps the completed dialog open while the card moves to history and accepts a further reply", async () => {
  const user = userEvent.setup();
  const fixture = mockJob(makeJob("completed"));
  await setupJobs();
  await user.click(await findControl(/Research customers/, "button"));
  const dialog = await screen.findByRole("dialog", {
    name: "Research customers",
  });
  await within(dialog).findByText("Ten verified prospects are ready");
  expect(control("Prospect report", "link", dialog)).toHaveAttribute(
    "href",
    "https://example.com/report",
  );
  await screen.findByText(
    "No jobs in this view. Ask Okou to create a Job when you want it to keep working on something.",
  );
  expect(dialog).toBeInTheDocument();
  await fill(
    within(dialog).getByRole("textbox", { name: "Reply" }),
    "Please add a contact at each company",
  );
  click(control("Save reply", "button", dialog));
  await within(dialog).findByText("Saved for the next evaluation");
  expect(fixture.replies).toHaveLength(1);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(await findControl("History", "tab"));
  await expect(
    findControl(/Research customers/, "button"),
  ).resolves.toHaveTextContent("Completed");
});

test("archives the Job from its dialog and keeps its record in the archived view", async () => {
  const user = userEvent.setup();
  mockJob();
  await setupJobs();
  await user.click(await findControl(/Research customers/, "button"));
  click(await findControl("Archive job", "button"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("textbox", { name: "Reply" }),
    ).not.toBeInTheDocument();
  });
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  click(await findControl("Archived", "tab"));
  await expect(
    findControl(/Research customers/, "button"),
  ).resolves.toHaveTextContent("Archived");
});

test("grants the actual connector permission before persisting authorization input", async () => {
  const job = makeJob("waiting_authorization");
  job.work.authorization = {
    id: resultId,
    agentId,
    connector: "github",
    permission: "issues:write",
    action: "Create the requested issue",
  };
  const fixture = mockJob(job);
  let grants: UserPermissionGrantResponse[] = [];
  const order: string[] = [];
  context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
    return respond(200, grants);
  });
  context.mocks.api(userPermissionGrantsContract.apply, ({ body, respond }) => {
    order.push("grant");
    expect(body).toMatchObject({
      agentId,
      connectorSlug: "github",
      grants: [
        { permission: "issues:write", action: "allow", expiresIn: "24h" },
      ],
    });
    grants = [
      {
        agentId,
        connectorSlug: "github",
        permission: "issues:write",
        action: "allow",
        expiresAt: "2099-10-23T00:00:00.000Z",
        createdAt: "2026-10-22T00:00:00.000Z",
        updatedAt: "2026-10-22T00:00:00.000Z",
      },
    ];
    return respond(200, grants);
  });
  context.mocks.api(jobsContract.input, ({ body, respond }) => {
    order.push("input");
    expect(grants).toHaveLength(1);
    expect(body).toMatchObject({
      kind: "authorization",
      requestId: resultId,
      outcome: "granted",
    });
    return respond(200, job);
  });
  await setupJobs();
  click(await findControl(/Research customers/, "button"));
  click(await findControl("Authorize", "button"));
  await screen.findByText("Saved for the next evaluation");
  expect(order).toStrictEqual(["grant", "input"]);
  expect(fixture.replies).toStrictEqual([]);
});

test("a late initial Jobs response cannot override a task the user selected", async () => {
  mockJob();
  const gate = createDeferredPromise<void>(context.signal);
  context.mocks.api(jobsContract.list, async ({ respond }) => {
    await gate.promise;
    return respond(200, { jobs: [makeJob()], nextAfter: null });
  });
  await setupJobs();
  click(await findControl("Image", "tab"));
  gate.resolve(undefined);
  await expect(
    findControl("Remove Image", "button"),
  ).resolves.toBeInTheDocument();
  expect(queryControl(/Research customers/, "button")).not.toBeInTheDocument();
});

test("shows Proactive jobs and keeps Suggestions independently enabled", async () => {
  let enabled = true;
  context.mocks.api(proactiveJobsContract.get, ({ respond }) => {
    return respond(200, {
      enabled,
      status: "enabled",
      unavailableReason: null,
    });
  });
  context.mocks.api(proactiveJobsContract.update, ({ body, respond }) => {
    enabled = body.enabled;
    return respond(200, {
      enabled,
      status: enabled ? "enabled" : "paused",
      unavailableReason: null,
    });
  });
  context.mocks.api(proactiveSuggestionsContract.get, ({ respond }) => {
    return respond(200, {
      enabled: true,
      status: "enabled",
      unavailableReason: null,
    });
  });
  await setupPage({
    context,
    path: "/agents?settings=preference",
    featureSwitches: {
      [FeatureSwitchKey.ProactiveJobs]: true,
      [FeatureSwitchKey.AgentSuggestion]: true,
    },
  });
  const jobs = await screen.findByRole("switch", { name: "Proactive jobs" });
  const suggestions = await screen.findByRole("switch", {
    name: "Proactive Suggestions",
  });
  await waitFor(() => {
    expect(jobs).toBeChecked();
    expect(suggestions).toBeChecked();
  });
  click(jobs);
  await waitFor(() => {
    expect(jobs).not.toBeChecked();
    expect(suggestions).toBeChecked();
  });
});
