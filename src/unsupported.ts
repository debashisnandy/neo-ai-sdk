/**
 * Fallback entry for browser targets. package.json maps the "browser" export
 * condition here so bundlers building for the browser get a clear error
 * instead of a cryptic failure deep in the SDK.
 *
 * Note this is deliberately NOT the "default" condition: "default" would also
 * catch bundler-style resolution (Vite, Next.js) building for Node, which
 * should receive the real package.
 *
 * If/when you add real browser or edge support, replace this with a proper
 * build entry and update the "exports" map in package.json.
 */

const message =
  "neo-ai-sdk is not supported in the browser. It currently targets Node.js >=20.11, " +
  "and API keys must never be shipped to a browser bundle. Call it from a server " +
  "route or backend service instead.";

throw new Error(message);

export {};
