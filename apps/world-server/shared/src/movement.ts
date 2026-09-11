import { MAX_INPUT_DT_MS, MAX_WORLD_SPEED, type MovementInput } from "./domain";

export const WORLD_PLAYER_WIDTH = 18;
export const WORLD_PLAYER_HEIGHT = 24;

export type MovementState = {
  x: number;
  y: number;
  facing: string;
  mode?: string;
};

export type WorldCollision = {
  collides: (x: number, y: number, width: number, height: number) => boolean;
};

export function applyMovement(
  player: MovementState,
  input: Pick<MovementInput, "left" | "right" | "up" | "down">,
  collision: WorldCollision,
  dtMs: number,
) {
  if (player.mode && player.mode !== "WALKING") return;
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  dx /= length;
  dy /= length;
  player.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
  const distance = MAX_WORLD_SPEED * Math.min(Math.max(dtMs, 0), MAX_INPUT_DT_MS) / 1000;
  const nextX = player.x + dx * distance;
  const nextY = player.y + dy * distance;

  if (!collision.collides(nextX - WORLD_PLAYER_WIDTH / 2, player.y - WORLD_PLAYER_HEIGHT / 2, WORLD_PLAYER_WIDTH, WORLD_PLAYER_HEIGHT)) {
    player.x = nextX;
  }
  if (!collision.collides(player.x - WORLD_PLAYER_WIDTH / 2, nextY - WORLD_PLAYER_HEIGHT / 2, WORLD_PLAYER_WIDTH, WORLD_PLAYER_HEIGHT)) {
    player.y = nextY;
  }
}
