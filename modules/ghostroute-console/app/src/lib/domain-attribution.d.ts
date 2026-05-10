export function trafficDomainLabel(row: Record<string, any>): string;
export function isDnsOnlyTraffic(row: Record<string, any>): boolean;
export function isUnclassifiedDomain(value: unknown): boolean;
export function isServiceDomain(value: unknown): boolean;
export function trafficClassForDomain(row: Record<string, any>): string;
export function normalizeDomainBreakdown(
  rows: Array<Record<string, any>>,
  targetBytes: number,
  options?: { limit?: number; minimumCoverageRatio?: number },
): {
  rows: Array<Record<string, any>>;
  rawTotalBytes: number;
  targetBytes: number;
  coverageRatio: number;
  scaled: boolean;
  unattributedBytes: number;
};
