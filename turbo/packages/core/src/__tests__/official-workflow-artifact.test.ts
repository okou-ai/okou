import { describe, expect, it } from "vitest";
import { prepareContentBundle, readContentBundle } from "../content-bundle";
import {
  officialWorkflowArtifactFiles,
  officialWorkflowExecutionFiles,
  verifyOfficialWorkflowArtifact,
} from "../official-workflow-artifact";

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
const storageId = "12345678-1234-4234-8234-123456789abc";
// Fixed encoding vectors from the published Storage file-hash protocol.
const executionVersion =
  "dee1fea274505538743b68a2c747e8792c5d3c535f293a0947f766796a108561";
const legacyVersion =
  "de8c0d295b2ee61737429a8d39585ab303e043008f09f1863440966921f3fd36";
const definitionManifest =
  '{"blueprints":[{"desiredState":{"kind":"schedule","schedule":{"cronExpression":"0 7 * * *","type":"cron"}},"fingerprint":"c6ffda39f8aa39893697589e1aae2b824f407ff659b7679569fb245b20d1771b","key":"daily-delivery","parameters":[]}],"name":"weekly-report","revision":"e642ea52dea36c92671acfea448dd2281197f42eaf448905feb0ef4383e06837","schemaVersion":3,"workflow":{"description":"Summarize weekly activity","displayName":"Weekly Report","files":[{"content":"Review changes.\\n","path":"references/checklist.txt"}],"instruction":"# Weekly report\\n\\nSummarize the week."}}\n';

describe("Official Workflow artifact file encoding", () => {
  it("builds the complete executable skill file set", () => {
    expect(officialWorkflowArtifactFiles(definition)).toEqual([
      skill,
      ...definition.workflow.files,
    ]);
  });

  it.each([
    {
      layout: "execution",
      storageVersion: executionVersion,
      files: [skill, ...definition.workflow.files],
    },
    {
      layout: "legacy",
      storageVersion: legacyVersion,
      files: [
        skill,
        ...definition.workflow.files,
        {
          path: ".vm0/official-workflow-definition.json",
          content: definitionManifest,
        },
      ],
    },
  ])(
    "reproduces a published $layout archive's authenticated files",
    (vector) => {
      expect(
        officialWorkflowArtifactFiles(definition, {
          storageId,
          storageVersion: vector.storageVersion,
          definitionManifest,
        }),
      ).toEqual(vector.files);
    },
  );

  it("rejects files that do not match the published artifact digest", () => {
    expect(
      officialWorkflowArtifactFiles(
        {
          ...definition,
          workflow: { ...definition.workflow, instruction: "Changed content" },
        },
        { storageId, storageVersion: legacyVersion, definitionManifest },
      ),
    ).toBeNull();
  });

  it("packages all 500 supplementary files within the current bundle format", async () => {
    const files = officialWorkflowArtifactFiles({
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
    if (!files) {
      throw new Error("Expected an unpublished execution package");
    }
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

it("checks actual archive bytes against the pinned legacy file hashes", async () => {
  const files = officialWorkflowExecutionFiles(definition).map((file) => {
    return {
      path: file.path,
      content: Buffer.from(file.content, "utf8"),
    };
  });
  const valid = await prepareContentBundle(files);
  const published = {
    storageId,
    storageVersion: executionVersion,
    definitionManifest,
  };
  expect(() => {
    return verifyOfficialWorkflowArtifact(valid.archive, definition, published);
  }).not.toThrow();
  const forged = await prepareContentBundle(
    files.map((file) => {
      return {
        ...file,
        content:
          file.path === "SKILL.md"
            ? Buffer.from(
                file.content
                  .toString()
                  .replace("Summarize the week.", "Summarize the weak."),
              )
            : file.content,
      };
    }),
  );
  expect(() => {
    return verifyOfficialWorkflowArtifact(
      forged.archive,
      definition,
      published,
    );
  }).toThrow("content is inconsistent");
});
