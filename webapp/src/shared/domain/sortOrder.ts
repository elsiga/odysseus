const MIN_GAP = 1e-9

export function sortOrderBefore(first: number | undefined): number {
  return first === undefined ? 0 : first - 1
}

export function sortOrderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return after! - 1
  if (after === undefined) return before + 1
  return (before + after) / 2
}

export function needsRebalance(before: number | undefined, after: number | undefined): boolean {
  return before !== undefined && after !== undefined && after - before < MIN_GAP
}

export function rebalanced<T extends { sortOrder: number }>(items: T[]): T[] {
  return items.map((item, i) => ({ ...item, sortOrder: i }))
}
