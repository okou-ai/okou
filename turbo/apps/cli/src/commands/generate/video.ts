import { createListerOnlyCommand } from "./lister-only";

export const videoCommand = createListerOnlyCommand({
  name: "video",
  generationType: "video",
  description: "List connectors that provide video generation",
});
