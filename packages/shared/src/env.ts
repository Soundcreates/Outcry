import { z } from "zod";

const optionalUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().url().optional(),
);
const optionalString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional(),
);

const publicEnvSchema = z.object({
  NEXT_PUBLIC_WORLD_WS: z.string().url().default("ws://localhost:2567"),
  OUTCRY_BASE_RPC: z.string().url().default("https://api.devnet.solana.com"),
  NEXT_PUBLIC_MAGICBLOCK_TEE_RPC: z
    .string()
    .url()
    .default("https://devnet-tee.magicblock.app"),
});

const serverEnvSchema = publicEnvSchema.extend({
  FRONTEND_BASE_URL: z.string().url().default("http://localhost:5173"),
  LIVEKIT_URL: optionalUrl,
  LIVEKIT_API_KEY: optionalString,
  LIVEKIT_API_SECRET: optionalString,
  GROQ_API_KEY: optionalString,
  PYTH_HERMES_URL: optionalUrl,
  PYTH_API_KEY: optionalString,
  ASSEMBLYAI_API_KEY: optionalString,
  OUTCRY_PROGRAM_ID: optionalString,
  OUTCRY_MATCH_ADDRESS: optionalString,
});

export function readPublicEnv(input: Record<string, unknown> = process.env) {
  return publicEnvSchema.parse(input);
}

export function readServerEnv(input: Record<string, unknown> = process.env) {
  return serverEnvSchema.parse(input);
}
