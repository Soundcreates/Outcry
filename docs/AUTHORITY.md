# OUTCRY authority contract

This is the Phase 0 boundary freeze from the technical Bible.

| Concern | Single authority |
|---|---|
| Tiled map geometry | Static map assets |
| World presence, movement, seats, leases | Colyseus world server |
| Video/audio transport | LiveKit |
| Speech transcription and parsing | STT/client draft only |
| Private RFQ, quotes, inventory, fast game resolution | MagicBlock PER |
| Durable match identity, result, escrow, settlement | Solana L1 |

Hard boundaries:

- Colyseus never selects an economic winner or settles funds.
- The frontend sends requests; it is never canonical.
- STT cannot sign or submit transactions.
- Movement never goes onchain.
- Private game actions fail closed when verified PER access is unavailable.
