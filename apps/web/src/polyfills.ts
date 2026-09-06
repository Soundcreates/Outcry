import { Buffer as BrowserBuffer } from "buffer";

const runtime = globalThis as typeof globalThis & { Buffer?: typeof BrowserBuffer };
runtime.Buffer ??= BrowserBuffer;
