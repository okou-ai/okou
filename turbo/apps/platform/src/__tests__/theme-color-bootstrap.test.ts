import { expect, test } from "vitest";

import indexHtml from "../../index.html?raw";

test.each([
  {
    cookie: "__Secure-okou-theme=v1.dark",
    systemDark: false,
    theme: "dark",
    color: "#19191b",
  },
  {
    cookie: "__Secure-okou-theme=v1.light",
    systemDark: true,
    theme: "light",
    color: "#ffffff",
  },
  {
    cookie: "__Secure-okou-theme=v1.system",
    systemDark: true,
    theme: "dark",
    color: "#19191b",
  },
  { cookie: "", systemDark: false, theme: "light", color: "#ffffff" },
])(
  "First paint follows the resolved $theme theme",
  ({ cookie, systemDark, theme, color }) => {
    const page = new DOMParser().parseFromString(indexHtml, "text/html");
    const metas = page.querySelectorAll('meta[name="theme-color"]');
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toHaveAttribute("media");

    const source = page.querySelector("#theme-bootstrap")?.textContent;
    if (!source) {
      throw new Error("index.html is missing the theme bootstrap");
    }
    const bootstrap = new Function("window", "document", source) as (
      window: { matchMedia: (query: string) => { matches: boolean } },
      document: {
        cookie: string;
        documentElement: HTMLElement;
        querySelector: (selector: string) => Element | null;
      },
    ) => void;
    bootstrap(
      {
        matchMedia: (query) => {
          expect(query).toBe("(prefers-color-scheme: dark)");
          return { matches: systemDark };
        },
      },
      {
        cookie,
        documentElement: page.documentElement,
        querySelector: (selector) => page.querySelector(selector),
      },
    );

    expect(page.documentElement.dataset.theme).toBe(theme);
    expect(page.documentElement.classList.contains("dark")).toBe(
      theme === "dark",
    );
    expect(metas[0]).toHaveAttribute("content", color);
  },
);
