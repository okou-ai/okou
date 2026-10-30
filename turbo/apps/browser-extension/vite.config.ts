import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "chrome102",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: "src/background.ts",
      formats: ["es"],
      fileName: () => {
        return "background.js";
      },
    },
  },
});
