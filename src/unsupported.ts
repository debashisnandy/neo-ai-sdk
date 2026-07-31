/**
 * Fallback entry for runtimes that don't match the "node" export condition
 * (e.g. certain edge/browser bundler targets). package.json maps the
 * "default" export condition here so consumers get a clear error instead of
 * a cryptic failure deep in the SDK.
 *
 * If/when you add real browser or edge support, replace this with a proper
 * build entry and update the "exports" map in package.json.
 */

const message =
  "neo-ai-sdk is not supported in this runtime. It currently targets Node.js >=20.11. " +
  "If you reached this in a browser/edge bundle, ensure your bundler resolves the 'node' export condition.";

throw new Error(message);

export {};
