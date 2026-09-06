import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const browserBuffer = fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url));

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "NEXT_PUBLIC_"],
  envDir: "../..",
  publicDir: "../../maps",
  define: { global: "globalThis" },
  resolve: { alias: { buffer: browserBuffer } },
});
