import { createListerOnlyCommand } from "./lister-only";

export const avatarVideoCommand = createListerOnlyCommand({
  name: "avatar-video",
  generationType: "avatar-video",
  description: "List connectors that provide talking-avatar video generation",
});
