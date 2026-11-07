import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "chrome102",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: {
        background: "src/background.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => {
        return `${entryName}.js`;
      },
    },
  },
});
