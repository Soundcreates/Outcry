import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const browserBuffer = fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url));
const anchorBrowserDefine = { "process.env.ANCHOR_BROWSER": "true" };

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  envDir: "../..",
  publicDir: "../../maps",
  define: { global: "globalThis", ...anchorBrowserDefine },
  optimizeDeps: {
    // Vite pre-bundles the dynamic Pyth receiver import separately from app transforms.
    esbuildOptions: { define: anchorBrowserDefine },
  },
  resolve: { alias: { buffer: browserBuffer } },
});
