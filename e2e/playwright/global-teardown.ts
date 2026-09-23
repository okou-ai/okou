import { cleanupRecordedClerkTestResources } from "./lib/clerk-api";

export default async function globalTeardown(): Promise<void> {
  await cleanupRecordedClerkTestResources(["playwright"]);
}
