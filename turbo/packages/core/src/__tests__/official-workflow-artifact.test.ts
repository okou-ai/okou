import { describe, expect, it } from "vitest";
import { prepareContentBundle, readContentBundle } from "../content-bundle";
import { officialWorkflowExecutionFiles } from "../official-workflow-artifact";

const definition = {
  name: "weekly-report",
  workflow: {
    displayName: "Weekly Report",
    description: "Summarize weekly activity",
    instruction: "# Weekly report\n\nSummarize the week.",
    files: [{ path: "references/checklist.txt", content: "Review changes.\n" }],
  },
};
const skill = {
  path: "SKILL.md",
  content:
    "---\nname: weekly-report\ndescription: Summarize weekly activity\n---\n\n# Weekly report\n\nSummarize the week.\n",
};
describe("Official Workflow artifact file encoding", () => {
  it("builds the complete executable skill file set", () => {
    expect(officialWorkflowExecutionFiles(definition)).toEqual([
      skill,
      ...definition.workflow.files,
    ]);
  });

  it("packages all 500 supplementary files within the current bundle format", async () => {
    const files = officialWorkflowExecutionFiles({
      ...definition,
      workflow: {
        ...definition.workflow,
        files: Array.from({ length: 500 }, (_, index) => {
          return {
            path: `references/${index}.txt`,
            content: `Item ${index}\n`,
          };
        }),
      },
    });
    const expected = files.map((file) => {
      return { path: file.path, content: Buffer.from(file.content, "utf8") };
    });
    const prepared = await prepareContentBundle(expected);
    const unpacked = readContentBundle(prepared.archive, prepared.descriptor);
    expect(unpacked).toHaveLength(501);
    expect(
      new Map(
        unpacked.map((file) => {
          return [file.path, file.content] as const;
        }),
      ),
    ).toEqual(
      new Map(
        expected.map((file) => {
          return [file.path, file.content] as const;
        }),
      ),
    );
  });
});

it("keeps execution hash independent of Blueprint and business revision changes", async () => {
  const first = {
    ...definition,
    revision: "a".repeat(64),
    blueprints: [{ key: "daily", schedule: "0 7 * * *" }],
  };
  const next = {
    ...first,
    revision: "b".repeat(64),
    blueprints: [{ key: "daily", schedule: "0 8 * * *" }],
  };
  const prepare = (value: typeof first) => {
    return prepareContentBundle(
      officialWorkflowExecutionFiles(value).map((file) => {
        return {
          path: file.path,
          content: Buffer.from(file.content, "utf8"),
        };
      }),
    );
  };
  expect((await prepare(first)).descriptor).toEqual(
    (await prepare(next)).descriptor,
  );
  expect(
    (
      await prepare({
        ...next,
        workflow: { ...next.workflow, instruction: "New instruction" },
      })
    ).descriptor.sha256,
  ).not.toEqual((await prepare(first)).descriptor.sha256);
});
