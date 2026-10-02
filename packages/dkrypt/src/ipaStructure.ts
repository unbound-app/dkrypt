import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface IpaFileEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
}

export interface IpaStructureDiff {
  added: IpaFileEntry[];
  removed: IpaFileEntry[];
  changed: Array<{ path: string; before: IpaFileEntry; after: IpaFileEntry }>;
  counts: { added: number; removed: number; changed: number; unchanged: number };
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = readSync(fd, buffer, 0, length, position);
  if (bytesRead !== length) throw new Error('IPA archive structure is incomplete');
  return buffer;
}

export function readIpaStructure(filePath: string): IpaFileEntry[] {
  const fd = openSync(filePath, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize < 22) throw new Error('IPA archive is too small to contain a directory');
    const tailSize = Math.min(fileSize, 22 + 0xffff);
    const tailOffset = fileSize - tailSize;
    const tail = readAt(fd, tailSize, tailOffset);
    let endOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        endOffset = index;
        break;
      }
    }
    if (endOffset < 0) throw new Error('IPA archive directory could not be found');
    const entryCount = tail.readUInt16LE(endOffset + 10);
    const directorySize = tail.readUInt32LE(endOffset + 12);
    const directoryOffset = tail.readUInt32LE(endOffset + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 IPA archives are not supported for structural comparison');
    if (entryCount > 100_000 || directorySize > 64 * 1024 * 1024 || directoryOffset + directorySize > fileSize) throw new Error('IPA archive directory exceeds comparison limits');
    const directory = readAt(fd, directorySize, directoryOffset);
    const entries: IpaFileEntry[] = [];
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== 0x02014b50) throw new Error('IPA archive directory contains an invalid entry');
      const flags = directory.readUInt16LE(offset + 8);
      const crc32 = directory.readUInt32LE(offset + 16);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (entryEnd > directory.length) throw new Error('IPA archive directory entry is truncated');
      const rawName = directory.subarray(offset + 46, offset + 46 + nameLength);
      const fileName = rawName.toString(flags & 0x0800 ? 'utf8' : 'latin1');
      if (!fileName.endsWith('/')) entries.push({ path: fileName, compressedSize, uncompressedSize, crc32 });
      offset = entryEnd;
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  } finally {
    closeSync(fd);
  }
}

export function compareIpaStructures(before: IpaFileEntry[], after: IpaFileEntry[]): IpaStructureDiff {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const added: IpaFileEntry[] = [];
  const removed: IpaFileEntry[] = [];
  const changed: IpaStructureDiff['changed'] = [];
  let unchanged = 0;
  for (const entry of after) {
    const previous = beforeByPath.get(entry.path);
    if (!previous) added.push(entry);
    else if (previous.crc32 !== entry.crc32 || previous.uncompressedSize !== entry.uncompressedSize || previous.compressedSize !== entry.compressedSize) changed.push({ path: entry.path, before: previous, after: entry });
    else unchanged += 1;
  }
  for (const entry of before) if (!afterByPath.has(entry.path)) removed.push(entry);
  return { added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged } };
}
