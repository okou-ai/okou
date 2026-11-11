import { copyFile } from "node:fs/promises";
import { build } from "vite";

await build();
await copyFile("manifest.json", "dist/manifest.json");
