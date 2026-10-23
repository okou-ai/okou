import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { Command } from "commander";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";
import { createJobCommand } from "../index";

const id = "a0000000-0000-4000-a000-000000000001";
const item = {
  id,
  title: "Research prospects",
  objective: "Deliver a verified shortlist",
  sourceReferences: [],
  status: "active",
  work: {
    progress: "",
    explanation: "",
    authorization: null,
    processedInputIds: [],
    currentResultId: null,
  },
  authorizationRequests: [],
  inputs: [],
  results: [],
  viewedResultIds: [],
  hasPendingInput: false,
  hasUnseenResult: false,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const log = vi.spyOn(console, "log").mockImplementation(() => {});
const error = vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation(() => {
  throw new Error("process.exit called");
});
beforeEach(() => {
  vi.stubEnv("OKOU_TOKEN", "test-token");
  vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
});
const run = (...args: string[]) => {
  return createJobCommand().parseAsync(["node", "okou", ...args]);
};

it("lists runnable Tasks through okou task with the existing API contract", async () => {
  const requests: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/jobs", ({ request }) => {
      requests.push(request.url);
      return HttpResponse.json({ jobs: [item], nextAfter: id });
    }),
  );
  const argv = [
    "node",
    "okou",
    "task",
    "list",
    "--runnable",
    "--after",
    id,
    "--limit",
    "25",
    "--json",
  ];
  const program = new Command("okou");
  await registerRequestedCommand(program, argv);
  await program.parseAsync(argv);
  const url = new URL(requests[0]!);
  expect(url.searchParams.get("filter")).toBe("runnable");
  expect(url.searchParams.get("after")).toBe(id);
  expect(url.searchParams.get("limit")).toBe("25");
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ jobs: [item], nextAfter: id }),
  );
});

it("sends the stable creation identity and inspected update precondition from JSON files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-cli-"));
  try {
    const create = {
      id,
      title: item.title,
      objective: item.objective,
      sourceReferences: [],
    };
    const update = {
      expected: { status: item.status, work: item.work },
      status: "waiting_decision",
      work: { ...item.work, explanation: "Which region?" },
    };
    const path = join(directory, "job.json");
    const received: unknown[] = [];
    server.use(
      http.post("http://localhost:3000/api/jobs", async ({ request }) => {
        received.push(await request.json());
        return HttpResponse.json(item);
      }),
      http.patch(
        `http://localhost:3000/api/jobs/${id}`,
        async ({ request }) => {
          received.push(await request.json());
          return HttpResponse.json({
            ...item,
            status: update.status,
            work: update.work,
          });
        },
      ),
    );
    await writeFile(path, JSON.stringify(create));
    await run("create", "--file", path, "--json");
    await writeFile(path, JSON.stringify(update));
    await run("update", id, "--file", path, "--json");
    expect(received).toEqual([create, update]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports a structured conflict without retrying an uncertain progress update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "job-cli-conflict-"));
  try {
    const path = join(directory, "job.json");
    await writeFile(
      path,
      JSON.stringify({
        expected: { status: item.status, work: item.work },
        status: item.status,
        work: item.work,
      }),
    );
    let requests = 0;
    server.use(
      http.patch(`http://localhost:3000/api/jobs/${id}`, () => {
        requests++;
        return HttpResponse.json(
          { error: { code: "CONFLICT", message: "Read the current Job" } },
          { status: 409 },
        );
      }),
    );
    await expect(run("update", id, "--file", path, "--json")).rejects.toThrow(
      "process.exit called",
    );
    expect(requests).toBe(1);
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({
        error: { code: "CONFLICT", message: "Read the current Job" },
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
