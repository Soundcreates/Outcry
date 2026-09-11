# Outcry

Outcry is a multiplayer social trading floor: walk through pixel-art markets, take a seat in a live pit, and trade through private quote rounds settled by an Anchor program on Solana.

The project combines a React/Vite client, Phaser world renderer, Colyseus world server, LiveKit media rooms, MagicBlock PER private state, Pyth SOL/USD pricing, and a Solana program for durable match identity, escrow, results, and settlement.

## Features

### Pixel-art multiplayer worlds

- World selector with live online-player and active-pit counts.
- Four playable Tiled worlds: Wall Street, Tokyo Night, Shibuya Crossing, and Kyoto Lanterns.
- Static map assets provide the visual style, backgrounds, map layers, collision geometry, pits, seats, portals, and decor.
- Phaser renders the maps and avatars and owns client-side presentation; the server remains authoritative for movement, collisions, seats, and leases.
- WASD or arrow-key movement with normalized diagonal speed and collision-safe movement.
- Remote players, deterministic avatar selection, chat bubbles, world chat, and camera following.
- Reconnection with a 30-second server grace period and a local Phaser preview when the world server is offline.

### Interactive seats and pits

- Walk close to a free seat and press `E` to reserve it.
- The world server validates proximity, availability, and the player state before creating a 60-second seat lease.
- Confirmed players are positioned at the seat and cannot move until they leave.
- Press `R` to leave a confirmed seat or cancel a pending wallet confirmation.
- Seat reservations expire safely, release on disconnect, and reconcile when a wallet reconnects.
- Every map currently contains two trading pits with four seat slots per pit.

### Wallet-gated match entry

- Browser wallet integration through `window.solana`.
- Join-match instructions validate the match account, seat index, wallet, and player membership before the media room opens.
- First-player match bootstrap can simulate and create the pit/match accounts before wallet approval.
- Stale or finished matches can be released by the host, with a fresh match nonce created afterward.
- Delegated MagicBlock matches can be restored to the Solana base layer by the host before RFQ execution.
- Wallet, RPC, account-owner, seat-conflict, and insufficient-balance errors are surfaced in the UI.

### Live trading matches

- A host starts a match once at least two players are seated; capacity is four players.
- Hosts choose between one and eight rounds.
- Each round has a taker, a buy or sell intent, a quantity of one, two, or five SOL, and a visible quote deadline.
- The match HUD shows host, player count, round, taker, quote count, deadline, last-round result, final ranking, and settlement state.
- Hosts can prepare rounds, resolve sealed quotes, skip empty rounds after the deadline, resume skipped rounds, and settle the winner’s payout.
- Final scores and round results are public match metadata; private inventories and quotes are not.

### Private RFQ and voice trading

- Takers can say commands such as `buy two SOL` or enter them as typed text.
- Browser microphone capture is sent to the server-side Groq Whisper transcription endpoint; speech is converted into a draft only.
- Every draft must be confirmed before an RFQ is submitted.
- Dealers unlock private inventory, prepare private quote access, and submit sealed quotes during the RFQ window.
- Quotes are checked against a verified SOL/USD mark and a configured deviation band before resolution.
- The speech service never signs or submits transactions.

### Media rooms

- LiveKit provides match-scoped camera, microphone, participant tiles, and data notifications.
- Player and spectator token roles are validated server-side.
- Camera and microphone can be toggled independently.
- Media can disconnect or reconnect without discarding onchain match state.

### Onchain settlement and oracle safety

- The Anchor program manages pits, matches, player seats, rounds, private-session grants, oracle state, escrow, results, delegation, and settlement.
- Durable match identity, match membership, round results, escrow, and payouts live on Solana’s base layer.
- MagicBlock PER handles private RFQ, quote, inventory, and fast game-resolution state.
- Pyth provides the SOL/USD price update used for quote validation and settlement calculations.
- Quote selection is deterministic: lowest valid price for buys, highest valid price for sells, with deterministic tie-breaking.
- Oracle freshness, price validity, quote bounds, quantities, session expiry, action masks, and arithmetic overflow are checked onchain.

## Authority boundaries

| Concern | Authority |
| --- | --- |
| Map visuals and Tiled geometry | Static assets in `apps/world-server/maps` |
| Presence, movement, collision, seats, leases, and world chat | Colyseus world server |
| Camera and voice transport | LiveKit |
| Speech transcription and trade-intent drafting | Server-side Groq STT and client confirmation |
| Private inventory, quotes, RFQ, and fast resolution | MagicBlock PER |
| Durable match identity, membership, result, escrow, and settlement | Solana L1 Anchor program |

The frontend is never canonical. Movement is not put onchain, Colyseus never selects an economic winner, and STT cannot sign or submit transactions. Private actions fail closed when verified TEE access is unavailable.

## User controls

| Input | Action |
| --- | --- |
| `WASD` / arrow keys | Walk through the current world |
| `E` | Reserve the nearest available seat |
| `R` | Leave a seat or cancel seat confirmation |
| World chat field | Send an 80-character maximum message |
| Start voice command | Record a trade-intent draft |
| Typed trade intent | Parse a command such as `sell five SOL` |

## Supported worlds

| World | ID | Pits |
| --- | --- | ---: |
| Wall Street | `wall-street` | 2 |
| Tokyo Night | `tokyo-night` | 2 |
| Shibuya Crossing | `shibuya-crossing` | 2 |
| Kyoto Lanterns | `kyoto-lanterns` | 2 |

Maps are Tiled JSON assets with embedded tilesets and validated object layers for `ground`, `collision`, `objects_pits`, `objects_seats`, `objects_spawn`, `objects_portals`, `objects_decor`, and rendering layers. Seat and pit interaction stays in Phaser plus Colyseus so new triggers can be added without baking gameplay into the art asset.

## Architecture

```text
React/Vite + Phaser
        │
        ├── HTTP: VITE_API_BASE_URL ────────┐
        └── WebSocket: VITE_WORLD_WS ────────┤
                                             ▼
                                    Colyseus world server
                                    - world rooms
                                    - movement/collision
                                    - seats and leases
                                    - CORS/API endpoints

Browser wallet ───── Solana base layer ───── match, escrow, result, settlement
                         │
                         └──── MagicBlock PER ─ private RFQ/inventory/quotes

Colyseus session ───── LiveKit media room
Server ─────────────── Groq transcription and Pyth price updates
```

## Requirements

- Node.js 24 or newer.
- pnpm 10.14.0 for the workspace commands.
- Rust, Cargo, Solana CLI, and Anchor CLI for program development and deployment.
- A Solana Devnet wallet with Devnet SOL for onchain match actions.
- Optional service credentials for LiveKit, Groq, and Pyth.
- Docker or OrbStack for the world-server container.

## Local development

Install dependencies and create a local environment file:

```bash
cp .env.example .env
pnpm install
```

Start the world server and web client in separate terminals:

```bash
pnpm dev:world
pnpm dev:web
```

The web client runs at `http://localhost:5173`. The world server listens on `http://localhost:2567` and exposes the Colyseus WebSocket endpoint on the same port.

The frontend uses `VITE_API_BASE_URL` for HTTP requests and `VITE_WORLD_WS` for Colyseus. The server uses `FRONTEND_BASE_URL` for CORS. These values are intentionally configurable; URLs are not hardcoded into the communication layer.

## Environment variables

Start from [.env.example](.env.example). Never put server secrets in a `VITE_*` variable or commit a real `.env` file.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | Web | HTTP base URL for worlds, LiveKit tokens, speech, and oracle updates |
| `VITE_WORLD_WS` | Web | Colyseus WebSocket URL |
| `FRONTEND_BASE_URL` | World server | Allowed browser origin for CORS |
| `OUTCRY_BASE_RPC` / `VITE_SOLANA_BASE_RPC` | Server / web | Solana base-layer RPC |
| `OUTCRY_DEPLOY_RPC` | Deployment tools | RPC used for program deployment |
| `OUTCRY_DEPLOY_TRANSPORT` | Deployment tools | `quic` or `rpc` deployment transport |
| `NEXT_PUBLIC_MAGICBLOCK_TEE_RPC` / `VITE_MAGICBLOCK_TEE_RPC` | Server / web | MagicBlock TEE RPC |
| `VITE_MAGICBLOCK_ROUTER_RPC` | Web | MagicBlock router RPC |
| `VITE_OUTCRY_PROGRAM_ID` / `OUTCRY_PROGRAM_ID` | Web / server | Deployed Outcry program address |
| `VITE_OUTCRY_MATCH_NONCE` / `OUTCRY_MATCH_ADDRESS` | Web / server | Match selection and active-match reconciliation |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Server | LiveKit token generation |
| `GROQ_API_KEY` | Server | Whisper trade-intent transcription |
| `PYTH_HERMES_URL`, `PYTH_API_KEY` | Server | Verified SOL/USD price updates |
| `ASSEMBLYAI_API_KEY` | Server environment | Reserved optional speech-provider configuration |

The default Devnet program ID is `D2rYtfu8x3CxJ89YoAUrWbfiMGhFbAtE9Hq8RNoJaUZt`, matching `Anchor.toml` and the checked-in browser IDL.

## Docker

The world-server Dockerfile is intentionally buildable when the deployment platform sends `apps/world-server` as its context. Build it directly with:

```bash
docker build -f apps/world-server/Dockerfile -t outcry-world-server apps/world-server
docker run --env-file .env -p 2567:2567 outcry-world-server
```

Or use Compose from the repository root:

```bash
docker compose up --build world-server
```

The image includes the server source, shared runtime package, Tiled maps, a `/health` endpoint, and a Docker healthcheck. The default container port is `2567`.

## Solana program workflow

Build the Anchor program and refresh the browser IDL:

```bash
pnpm build:program
```

Deploy using the configured wallet and RPC:

```bash
pnpm deploy:program
```

Run the deployment preflight against the configured program and match:

```bash
pnpm verify:deployment
```

The deployment scripts require a configured Solana wallet at `~/.config/solana/id.json` and valid public-key environment variables. Program deployment and match bootstrap are separate operations; `prepare:devnet-match` generates a dry-run bootstrap plan and does not silently sign player transactions.

## Tests and quality checks

Run the normal project gate:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm validate:maps
```

Additional checks:

```bash
pnpm test:phase0       # architecture and secret-boundary smoke checks
pnpm test:world        # map and collision validation
pnpm test:integration  # browser/server integration; services must be running
pnpm test:program      # Anchor source and harness smoke checks
pnpm test:program:localnet
pnpm test:program:phase7
pnpm test:program:phase9
```

The test suite covers movement and collision, seat leasing and expiry, world-room behavior, reconnect state, map structure, chat validation, wallet instruction construction, match-account decoding, privacy boundaries, LiveKit tokens, Groq requests, Pyth updates, trade-intent parsing, and program integration harnesses.

## Repository layout

```text
apps/web/                  React + Vite frontend, Phaser world, wallet and match UI
apps/world-server/         Colyseus/Express server and Docker deployment context
apps/world-server/maps/    Tiled maps and pixel-art assets
apps/world-server/shared/  Shared domain, env, movement, input, and state types
programs/outcry/           Anchor program and trading-game logic
tests/                     World, program, voice, and integration fixtures
tools/                     Build, deploy, validation, and localnet harnesses
docs/AUTHORITY.md          Authority and trust-boundary contract
```

## Current deployment scope

The checked-in configuration targets Solana Devnet and MagicBlock Devnet services. LiveKit media, Groq transcription, and Pyth updates are optional at startup, but their corresponding features remain unavailable until their credentials and endpoints are configured. For production deployment, use dedicated RPC endpoints, rotate all service credentials, set the exact frontend origin in `FRONTEND_BASE_URL`, and keep the browser-visible environment limited to public configuration.
