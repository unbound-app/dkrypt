import { statfsSync } from 'node:fs';

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export function getDiskUsage(dir: string): DiskUsage | undefined {
  try {
    const stats = statfsSync(dir);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return { totalBytes, freeBytes, usedBytes, usedPercent: totalBytes > 0 ? usedBytes / totalBytes : 0 };
  } catch {
    return undefined;
  }
}
