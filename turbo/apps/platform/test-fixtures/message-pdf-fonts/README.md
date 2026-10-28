# PDF regression fonts

These are test-only subsets of the production fonts, renamed to **PDF Regression Fixture**. They preserve the actual outlines, metrics, half-width OpenType substitutions and emoji ligatures used by the page export tests. The HTTP font-resource boundary serves these files so real PDF rendering stays within the normal test timeout. Production continues to load the complete fonts.

To regenerate after changing test text, install `fonttools[woff]==4.60.1` in a Python environment and run `generate.py` from this directory. It reads the font versions installed by the repository lockfile and `src/views/okou-page/__tests__/chat-message-pdf.test.tsx`. Commit the regenerated fonts and notices together.

The three source font packages are development dependencies used only by this Python generator. Knip cannot trace Python file reads, so the Platform workspace explicitly lists these packages in `ignoreDependencies`. Production uses the content-addressed URLs in `src/lib/static-assets.ts`; after a font upgrade, publish and verify the complete files in `okou-ai/static-files` before updating those URLs.

The source fonts and these subsets use the SIL Open Font License 1.1. Copyright and upstream license metadata are retained in `NOTICE.txt`; the full license is in `OFL.txt`.
