import { formatUnits, parseUnits } from 'viem';
import { WAD } from './types.js';

export const abs = (v: bigint) => v < 0n ? -v : v;
export const max = (a: bigint, b: bigint) => a > b ? a : b;
export const min = (a: bigint, b: bigint) => a < b ? a : b;
export const usd = (v: bigint) => formatUnits(v, 18);
export function amount(s: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(s)) throw new Error('金额必须是最多 18 位小数的十进制字符串');
  return parseUnits(s, 18);
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? { $bigint: String(v) } : v);
}
export function fromJson<T>(s: string): T {
  return JSON.parse(s, (_, v) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v) as T;
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(done, ms);
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/0x[0-9a-fA-F]{64,}/g, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /private|secret|signed|signature|^r$|^s$/i.test(k) ? '[redacted]' : redact(v)]));
  return value;
}
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(json({ time: new Date().toISOString(), event, ...redact(fields) as object }));
}
export function errorText(e: unknown): string {
  // Never stringify HTTP payloads or viem error chains: they may contain signatures/keys.
  return String(redact(e instanceof Error ? e.message.split('\n')[0] : 'Unknown error'));
}
export const priceToUsd = (price: bigint, scale: bigint) => price * WAD / scale;
