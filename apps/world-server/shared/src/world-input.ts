import { schema, t, type SchemaType } from "@colyseus/schema";

export const WorldMoveInput = schema({
  seq: t.number().default(0),
  left: t.boolean().default(false),
  right: t.boolean().default(false),
  up: t.boolean().default(false),
  down: t.boolean().default(false),
}, "WorldMoveInput");

export type WorldMoveInput = SchemaType<typeof WorldMoveInput>;
