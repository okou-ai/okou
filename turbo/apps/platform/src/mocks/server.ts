/**
 * MSW Node Server Setup
 *
 * This configures MSW to run in Node.js for testing.
 * The server intercepts requests at the network level without needing a browser.
 */

import { setupServer } from "msw/node";
import { handlers } from "./handlers/index.ts";

export const server = setupServer(...handlers);
