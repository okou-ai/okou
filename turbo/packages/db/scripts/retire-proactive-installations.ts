import postgres from "postgres";
import {
  remainingInstallations,
  retireProactiveInstallations,
} from "./proactive-retirement/retire";

const databaseUrl = process.env.DATABASE_URL;
const [release, operation, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  (operation !== undefined &&
    (operation !== "--prepare" || release === "--pending"))
) {
  throw new Error(
    "Expected --pending or a verified API release SHA with optional --prepare",
  );
}
if (!databaseUrl || !release) {
  throw new Error("A database URL and a verified API release SHA are required");
}
const db = postgres(databaseUrl, { max: 1 });
try {
  if (release === "--pending") {
    const pending = await remainingInstallations(db);
    console.log(pending.workflows > 0 || pending.enrollments > 0);
  } else {
    console.log(
      JSON.stringify(
        await retireProactiveInstallations(
          db,
          release,
          operation === "--prepare" ? "prepare" : "retire",
        ),
      ),
    );
  }
} finally {
  await db.end();
}
