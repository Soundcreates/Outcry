import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_WORLD_WS: z.string().url().default("ws://localhost:2567"),
  NEXT_PUBLIC_SOLANA_RPC: z.string().url().default("https://api.devnet.solana.com"),
  NEXT_PUBLIC_MAGICBLOCK_TEE_RPC: z
    .string()
    .url()
    .default("https://devnet-tee.magicblock.app"),
});

const serverEnvSchema = publicEnvSchema.extend({
  LIVEKIT_URL: z.string().url().optional(),
  LIVEKIT_API_KEY: z.string().min(1).optional(),
  LIVEKIT_API_SECRET: z.string().min(1).optional(),
  ASSEMBLYAI_API_KEY: z.string().min(1).optional(),
  OUTCRY_PROGRAM_ID: z.string().min(1).optional(),
});

export function readPublicEnv(input: Record<string, unknown> = process.env) {
  return publicEnvSchema.parse(input);
}

export function readServerEnv(input: Record<string, unknown> = process.env) {
  return serverEnvSchema.parse(input);
}
