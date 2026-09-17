/**
 * Mermaid stub for tests.
 *
 * Parsing is delegated to the real lightweight module (through the
 * `mermaid-lite-real` alias), so source validity in tests is decided by
 * the same parser as in production. Rendering lays text out with the SVG
 * measurement APIs of a real browser layout engine (`getBBox`), which
 * happy-dom does not implement, so `render` returns a minimal stub SVG.
 */

const realMermaid = import("mermaid-lite-real");

const mermaid = {
  initialize: () => {},
  parse: async (text: string, options?: { readonly suppressErrors?: true }) => {
    const { default: real } = await realMermaid;
    return real.parse(text, options);
  },
  render: (id: string) => {
    return Promise.resolve({
      svg: `<svg id="${id}"></svg>`,
    });
  },
};

export default mermaid;
