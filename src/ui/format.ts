/** "62%", with the ends spelled out: never "100%" or "0%" unless it's certain. */
export const pct = (p: number) => {
  if (p >= 1) return '100%';
  if (p <= 0) return '0%';
  if (p >= 0.995) return '>99%';
  if (p < 0.005) return '<1%';
  return `${Math.round(p * 100)}%`;
};
