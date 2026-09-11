import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./polyfills";
import "./styles/tokens.css";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const wantsPlay = params.has("play") || params.has("world");

const Entry = wantsPlay
  ? lazy(() => import("./PlayApp"))
  : lazy(() => import("./landing/LandingPage"));

const root = document.getElementById("root");
if (!root) throw new Error("Missing Vite root element");

createRoot(root).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Entry />
    </Suspense>
  </StrictMode>,
);
