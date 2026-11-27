import postgres from "postgres";
import {
  remainingInstallations,
  retireProactiveInstallations,
} from "./proactive-retirement/retire";

const databaseUrl = process.env.DATABASE_URL;
const release = process.argv[2];
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
      JSON.stringify(await retireProactiveInstallations(db, release)),
    );
  }
} finally {
  await db.end();
}
