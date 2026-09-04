import { createServer } from "node:http";
import { readServerEnv } from "@outcry/shared/env";

const env = readServerEnv();
const port = Number(process.env.PORT ?? 2567);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "world-server" }));
    return;
  }

  response.writeHead(404);
  response.end();
});

server.listen(port, () => {
  console.log(`OUTCRY world server listening on http://localhost:${port}`);
  console.log(`Solana RPC configured: ${env.NEXT_PUBLIC_SOLANA_RPC}`);
});
