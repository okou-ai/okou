import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { ARTIFACT_VISIBILITIES, artifacts } from "../schema/artifact";
import { artifactUserShares } from "../schema/artifact-user-share";
import { FILE_ORIGINS, files } from "../schema/file";

describe("Release 1 files and artifact access schema", () => {
  it("defines pure File Meta on files without run_id or visibility columns", () => {
    const config = getTableConfig(files);
    const columnNames = config.columns.map((c) => {
      return c.name;
    });

    expect(config.name).toBe("files");
    expect(FILE_ORIGINS).toEqual(["user", "agent", "system"]);
    expect(columnNames).toEqual([
      "id",
      "org_id",
      "owner_user_id",
      "storage_key",
      "filename",
      "content_type",
      "size_bytes",
      "checksum_sha256",
      "origin",
      "created_at",
      "deleted_at",
    ]);
    expect(columnNames).not.toContain("run_id");
    expect(columnNames).not.toContain("visibility");
    expect(
      config.checks.map((c) => {
        return c.name;
      }),
    ).toEqual(["files_origin_check", "files_org_id_nonempty"]);
  });

  it("expands artifacts with visibility and category without removing legacy columns", () => {
    const config = getTableConfig(artifacts);
    const columnNames = config.columns.map((c) => {
      return c.name;
    });

    expect(ARTIFACT_VISIBILITIES).toEqual([
      "private",
      "organization",
      "public",
    ]);
    expect(columnNames).toContain("visibility");
    expect(columnNames).toContain("category");
    expect(columnNames).toContain("projection_file_id");
    expect(columnNames).toContain("video_source_url");
    expect(
      config.checks.some((c) => {
        return c.name === "artifacts_visibility_check";
      }),
    ).toBe(true);
  });

  it("defines artifact_user_shares with composite PK (user_id, org_id, artifact_id) and FK to artifacts", () => {
    const config = getTableConfig(artifactUserShares);
    const pkColumns = config.primaryKeys[0]?.columns.map((c) => {
      return c.name;
    });

    expect(config.name).toBe("artifact_user_shares");
    expect(pkColumns).toEqual(["user_id", "org_id", "artifact_id"]);
    expect(config.foreignKeys).toHaveLength(1);
    expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
  });
});
