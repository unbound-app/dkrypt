declare module 'bplist-parser' {
  export function parseBuffer<T = Record<string, unknown>>(buf: Buffer): T[];
}
