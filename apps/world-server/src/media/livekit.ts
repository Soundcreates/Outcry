import { AccessToken, type VideoGrant } from "livekit-server-sdk";

export type LiveKitRole = "PLAYER" | "SPECTATOR";

export type LiveKitTokenRequest = {
  matchId: string;
  role: LiveKitRole;
  sessionId: string;
};

export function parseLiveKitTokenRequest(payload: unknown): LiveKitTokenRequest | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["matchId", "role", "sessionId"].includes(key))) return null;
  if (
    typeof value.matchId !== "string" ||
    value.matchId.length === 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    (value.role !== "PLAYER" && value.role !== "SPECTATOR")
  ) return null;
  return {
    matchId: value.matchId,
    role: value.role,
    sessionId: value.sessionId,
  };
}

export async function mintLiveKitToken(input: {
  apiKey: string;
  apiSecret: string;
  serverUrl: string;
  matchId: string;
  role: LiveKitRole;
}) {
  const room = `outcry_${input.matchId}`;
  const grant: VideoGrant = {
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish: input.role === "PLAYER",
    canPublishData: input.role === "PLAYER",
  };
  const accessToken = new AccessToken(input.apiKey, input.apiSecret, {
    identity: `p_${crypto.randomUUID()}`,
    ttl: 300,
  });
  accessToken.addGrant(grant);
  return {
    serverUrl: input.serverUrl,
    room,
    role: input.role,
    token: await accessToken.toJwt(),
  };
}
