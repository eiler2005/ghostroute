export function canonicalDeviceKey(value: string | Record<string, any>): string;
export function loadDeviceAttributions(dataDir?: string): {
  devices: Record<string, Record<string, any>>;
  aliases: Record<string, string>;
};
export function deviceAttributionFor(value: string | Record<string, any>, registry?: Record<string, any>): Record<string, any> | null;
export function displayDeviceLabel(value: string | Record<string, any>, registry?: Record<string, any>): string;
export function applyDeviceAttribution(row: Record<string, any>, registry?: Record<string, any>): Record<string, any>;
