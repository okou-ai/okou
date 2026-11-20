import { pgTable } from "drizzle-orm/pg-core";
import { githubInstallationColumns } from "../columns/github-installation";

export const githubInstallations = pgTable(
  "github_installations",
  githubInstallationColumns(),
);
