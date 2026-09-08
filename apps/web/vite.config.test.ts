import assert from "node:assert/strict";
import config from "./vite.config";

const anchorBrowserFlag = "process.env.ANCHOR_BROWSER";

assert.equal(config.define?.[anchorBrowserFlag], "true");
assert.equal(config.optimizeDeps?.esbuildOptions?.define?.[anchorBrowserFlag], "true");
