export type TradeSide = "BUY" | "SELL";

export type TradeIntent = {
  side: TradeSide;
  baseAsset: "SOL";
  quoteAsset: "USDC";
  quantity: 1 | 2 | 5;
};

const WORD_NUMBERS: Record<string, 1 | 2 | 5> = { one: 1, two: 2, five: 5 };
const SIDE_WORDS = new Set(["buy", "take", "sell", "offer"]);
const UNSUPPORTED_ASSETS = new Set(["btc", "bitcoin", "eth", "ethereum", "usdc", "usd"]);
const NON_COMMAND_CONTEXT = new Set(["someone", "background", "ignore"]);
const INVALID_NUMBER_WORDS = new Set(["zero", "three", "four", "six", "seven", "eight", "nine", "ten", "twenty", "hundred", "thousand"]);

export function parseTradeIntent(text: string): TradeIntent | null {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const sides = tokens.filter((token) => SIDE_WORDS.has(token));
  if (sides.length !== 1 || !tokens.includes("sol") || tokens.some((token) => UNSUPPORTED_ASSETS.has(token) || NON_COMMAND_CONTEXT.has(token) || INVALID_NUMBER_WORDS.has(token))) return null;

  const side: TradeSide = sides[0] === "buy" || sides[0] === "take" ? "BUY" : "SELL";
  const quantities = [
    ...tokens.filter((token) => /^\d+$/.test(token)).map(Number),
    ...tokens.flatMap((token) => token in WORD_NUMBERS ? [WORD_NUMBERS[token]] : []),
  ];
  if (quantities.length !== 1 || ![1, 2, 5].includes(quantities[0])) return null;

  return { side, baseAsset: "SOL", quoteAsset: "USDC", quantity: quantities[0] as 1 | 2 | 5 };
}
