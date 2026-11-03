import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import tailwindcss from "@tailwindcss/postcss";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import postcss from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

import { Switch } from "../switch";

let compiledSwitchCss = "";

function globalCssPath(): string {
  const candidates = [
    join(process.cwd(), "src/styles/globals.css"),
    join(process.cwd(), "packages/ui/src/styles/globals.css"),
  ];
  const path = candidates.find((candidate) => {
    return existsSync(candidate);
  });
  if (path === undefined) {
    throw new Error("Unable to locate UI global CSS");
  }
  return path;
}

async function compileSwitchCss(): Promise<string> {
  const path = globalCssPath();
  const packageRoot = resolve(dirname(path), "../..");
  const source = `${readFileSync(path, "utf8")}\n@source "../components/ui/switch.tsx";`;
  const result = await postcss([tailwindcss({ base: packageRoot })]).process(
    source,
    { from: path },
  );
  const rules: string[] = [];

  postcss.parse(result.css).walkRules((rule) => {
    const isSwitchState =
      rule.selector.includes("[data-checked]") ||
      rule.selector.includes("[data-unchecked]");
    const setsBackground = rule.nodes.some((node) => {
      return node.type === "decl" && node.prop === "background-color";
    });
    if (isSwitchState && setsBackground) {
      rules.push(rule.toString());
    }
  });

  if (rules.length === 0) {
    throw new Error("Tailwind did not compile switch state backgrounds");
  }
  return rules.join("\n");
}

function installSwitchStyles(segmentTrack: string): () => void {
  const style = document.createElement("style");
  style.textContent = `${compiledSwitchCss}
    :root {
      --color-primary-400: rgb(225, 145, 0);
      --color-segment-track: ${segmentTrack};
    }
  `;
  document.head.append(style);
  return () => {
    style.remove();
  };
}

beforeAll(async () => {
  compiledSwitchCss = await compileSwitchCss();
});

describe("Switch", () => {
  it.each([
    { name: "light", segmentTrack: "rgb(240, 236, 234)" },
    { name: "dark", segmentTrack: "rgb(62, 61, 60)" },
  ])("renders the $name track and checked Amber", async ({ segmentTrack }) => {
    const removeStyles = installSwitchStyles(segmentTrack);
    try {
      const user = userEvent.setup();
      render(<Switch aria-label="Notifications" />);
      const toggle = screen.getByRole("switch", { name: "Notifications" });

      expect(toggle).not.toBeChecked();
      expect(getComputedStyle(toggle).backgroundColor).toBe(segmentTrack);

      await user.click(toggle);

      expect(toggle).toBeChecked();
      expect(getComputedStyle(toggle).backgroundColor).toBe("rgb(225, 145, 0)");
    } finally {
      removeStyles();
    }
  });
});
