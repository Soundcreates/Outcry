export type WorldMeta = {
  id: string;
  name: string;
  blurb: string;
  pits: number;
};

export const WORLDS: WorldMeta[] = [
  { id: "wall-street", name: "Wall Street", blurb: "Brass, ticker tape, and a bell that means business.", pits: 2 },
  { id: "tokyo-night", name: "Tokyo Night", blurb: "Rain-lit rooftop desks and a faster, neon-lit pit.", pits: 2 },
  { id: "shibuya-crossing", name: "Shibuya Crossing", blurb: "Crowded, loud, and always mid-scramble to a table.", pits: 2 },
  { id: "kyoto-lanterns", name: "Kyoto Lanterns", blurb: "A quieter floor for patient dealers and slow reveals.", pits: 2 },
];
