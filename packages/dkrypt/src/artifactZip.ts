import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

export interface ArtifactZipEntry {
  path: string;
  name: string;
  size: number;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

async function crc32File(filePath: string): Promise<number> {
  let checksum = 0xffffffff;
  for await (const chunk of createReadStream(filePath)) {
    for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function localHeader(name: Buffer, checksum: number, size: number): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(0, 10);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function centralHeader(name: Buffer, checksum: number, size: number, offset: number): Buffer {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

export async function validateArtifactZipEntries(entries: ArtifactZipEntry[]): Promise<void> {
  if (entries.length === 0 || entries.length > 100) throw new Error('ZIP exports support 1 to 100 artifacts');
  if (entries.some((entry) => !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff)) {
    throw new Error('ZIP export contains an artifact too large for this archive format');
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if ((await stat(entry.path)).size !== entry.size) throw new Error('Artifact size changed before ZIP export');
    const name = Buffer.from(entry.name.replace(/[\\/\0]/g, '_'), 'utf8');
    if (name.length > 0xffff) throw new Error('ZIP export contains an invalid filename');
    const uniqueName = name.toString('utf8');
    if (names.has(uniqueName)) throw new Error('ZIP export filenames must be unique');
    names.add(uniqueName);
  }
}

export function streamArtifactZip(entries: ArtifactZipEntry[]): Readable {
  return Readable.from((async function* () {
    await validateArtifactZipEntries(entries);
    const centralRecords: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const name = Buffer.from(entry.name.replace(/[\\/\0]/g, '_'), 'utf8');
      const checksum = await crc32File(entry.path);
      if (offset + 30 + name.length + entry.size > 0xffffffff) throw new Error('ZIP export exceeds the supported archive size');
      const header = localHeader(name, checksum, entry.size);
      yield header;
      offset += header.length;
      for await (const chunk of createReadStream(entry.path)) {
        yield chunk;
        offset += chunk.length;
      }
      centralRecords.push(centralHeader(name, checksum, entry.size, offset - entry.size - header.length));
    }
    const centralOffset = offset;
    for (const record of centralRecords) {
      yield record;
      offset += record.length;
    }
    const centralSize = offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    end.writeUInt16LE(0, 20);
    yield end;
  })());
}
