import { createListerOnlyCommand } from "./lister-only";

export const voiceCommand = createListerOnlyCommand({
  name: "voice",
  generationType: "voice",
  description: "List connectors that provide voice generation",
});
