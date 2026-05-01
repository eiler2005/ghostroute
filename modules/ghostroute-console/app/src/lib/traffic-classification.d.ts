export const trafficClasses: string[];
export const trafficClassLabels: Record<string, string>;
export function trafficClassFor(row: Record<string, any>): string;
export function trafficClassLabel(value?: string): string;
export function displayDestination(row: Record<string, any>): string;
export function deviceRole(row: Record<string, any>): string;
