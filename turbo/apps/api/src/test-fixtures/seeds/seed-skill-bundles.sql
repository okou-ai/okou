-- Fixed current Seed packages, shared by native PostgreSQL and PGlite.
-- Bytes and source identities are captured in dev-seed-skill-bundles.json and
-- test-fixtures/seed-skill-bundles; existing catalog authority is preserved.
INSERT INTO skills (
  url, name, full_path, version_hash, content_bundle,
  content_bundle_source_version_hash, commit_sha, size, file_count, frontmatter
)
SELECT
  'https://github.com/okou-ai/okou-skills/tree/main/' || seed.name,
  seed.name, 'okou-ai/okou-skills/tree/main/' || seed.name,
  seed."versionHash", seed."contentBundle", seed."versionHash",
  seed."commitSha", seed.size, seed."fileCount", seed.frontmatter
FROM jsonb_to_recordset($seed_skill_bundles$
[
  {
    "name": "computer-use",
    "versionHash": "bdd3bfad20983290212b877a24dbf386e61dffb45458ea7aebfa26bc5bb5817a",
    "commitSha": "5388dcf468a0bc02609903ea3de71518d13aec12",
    "contentBundle": {
      "sha256": "797feb18286cec55976dc8d6b11e0fa1e34a2aca43401f5a2138f48d36b8b660",
      "archiveBytes": 3299
    },
    "size": 8745,
    "fileCount": 1,
    "frontmatter": {
      "name": "computer-use",
      "description": "Operate apps on a desktop host through Computer Use, whether surfaced as Okou Desktop or the still-supported legacy Zero Desktop, when APIs are not enough. Not for remote browser sessions (`okou browser use`), surfaced as Okou Browser or legacy Zero Browser."
    }
  },
  {
    "name": "gen",
    "versionHash": "c723fd98e090dfda9439a320b669485df3f5e4c0d431d15877c0694c8de8ff17",
    "commitSha": "5388dcf468a0bc02609903ea3de71518d13aec12",
    "contentBundle": {
      "sha256": "06b6894a26b61c725fdb621f745364ee3ae88e550a7f08ad82e35a2d8e07672d",
      "archiveBytes": 2671
    },
    "size": 6821,
    "fileCount": 1,
    "frontmatter": {
      "name": "gen",
      "description": "Use Okou generation pipelines for images, presentations, websites, reports, and designs."
    }
  },
  {
    "name": "workflow-setup",
    "versionHash": "d5ab3c4203975656837763f52d7dc6e03e117432c8a3deaa4b7a0fbb639a519c",
    "commitSha": "5388dcf468a0bc02609903ea3de71518d13aec12",
    "contentBundle": {
      "sha256": "9380d168b79ca32081ba3df5e1650662710c11fcb3f367fe3019798a9be5a925",
      "archiveBytes": 7053
    },
    "size": 19942,
    "fileCount": 2,
    "frontmatter": {
      "name": "workflow-setup",
      "description": "Create, edit, inspect, run, schedule, pause, or delete workflows and automations."
    }
  }
]
$seed_skill_bundles$::jsonb) AS seed(
  name text, "versionHash" varchar(64), "commitSha" varchar(40),
  "contentBundle" jsonb, size bigint, "fileCount" integer, frontmatter jsonb
)
ON CONFLICT (url) DO NOTHING;
