import { renderWordDocumentPreview } from "./lib/word-document-renderer.ts";

// This optional, separately built entry is loaded only by the Word preview.
window.__okouWordPreview = { render: renderWordDocumentPreview };
