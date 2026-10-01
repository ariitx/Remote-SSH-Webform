import * as fs from 'fs';

// Minimal ECMA-335 reader: just enough of a .NET assembly's metadata to list its public top-level types.
// Reflection would need the assembly's dependencies resolvable; reading the TypeDef table doesn't.

const TABLE_MODULE = 0x00;
const TABLE_TYPEREF = 0x01;
const TABLE_TYPEDEF = 0x02;
const TABLE_FIELD = 0x04;
const TABLE_METHODDEF = 0x06;
const TABLE_MODULEREF = 0x1a;
const TABLE_TYPESPEC = 0x1b;
const TABLE_ASSEMBLYREF = 0x23;

const cache = new Map<string, { mtimeMs: number; types: Set<string> }>();

/** Public top-level type full names ("Namespace.Name") defined in the assembly; empty if it can't be read. */
export function publicTypeNames(assemblyPath: string): Set<string> {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(assemblyPath).mtimeMs;
  } catch {
    return new Set();
  }
  const cached = cache.get(assemblyPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.types;
  let types: Set<string>;
  try {
    types = readTypeNames(fs.readFileSync(assemblyPath));
  } catch {
    types = new Set();
  }
  cache.set(assemblyPath, { mtimeMs, types });
  return types;
}

function readTypeNames(pe: Buffer): Set<string> {
  const peOffset = pe.readUInt32LE(0x3c);
  if (pe.readUInt32LE(peOffset) !== 0x00004550) throw new Error('not a PE file');
  const sectionCount = pe.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = pe.readUInt16LE(peOffset + 20);
  const optionalHeader = peOffset + 24;
  const dataDirectories = optionalHeader + (pe.readUInt16LE(optionalHeader) === 0x20b ? 112 : 96);
  const cliHeaderRva = pe.readUInt32LE(dataDirectories + 14 * 8);
  if (cliHeaderRva === 0) throw new Error('not a .NET assembly');

  const sectionTable = optionalHeader + optionalHeaderSize;
  const rvaToOffset = (rva: number): number => {
    for (let i = 0; i < sectionCount; i++) {
      const s = sectionTable + i * 40;
      const virtualSize = pe.readUInt32LE(s + 8);
      const virtualAddress = pe.readUInt32LE(s + 12);
      const rawSize = pe.readUInt32LE(s + 16);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rva - virtualAddress + pe.readUInt32LE(s + 20);
      }
    }
    throw new Error(`RVA ${rva} is outside every section`);
  };

  const metadata = rvaToOffset(pe.readUInt32LE(rvaToOffset(cliHeaderRva) + 8));
  if (pe.readUInt32LE(metadata) !== 0x424a5342) throw new Error('bad metadata signature');
  const versionLength = pe.readUInt32LE(metadata + 12);
  let p = metadata + 16 + versionLength + 2;
  const streamCount = pe.readUInt16LE(p);
  p += 2;
  let tablesStream = -1;
  let stringsStream = -1;
  for (let i = 0; i < streamCount; i++) {
    const offset = pe.readUInt32LE(p);
    const nameStart = p + 8;
    const nameEnd = pe.indexOf(0, nameStart);
    const name = pe.toString('ascii', nameStart, nameEnd);
    if (name === '#~' || name === '#-') tablesStream = metadata + offset;
    else if (name === '#Strings') stringsStream = metadata + offset;
    p = nameStart + ((nameEnd - nameStart + 4) & ~3);
  }
  if (tablesStream < 0 || stringsStream < 0) throw new Error('metadata streams missing');

  const heapSizes = pe.readUInt8(tablesStream + 6);
  const validLow = pe.readUInt32LE(tablesStream + 8);
  const validHigh = pe.readUInt32LE(tablesStream + 12);
  const rows: number[] = new Array(64).fill(0);
  p = tablesStream + 24;
  for (let table = 0; table < 64; table++) {
    const present = table < 32 ? (validLow >>> table) & 1 : (validHigh >>> (table - 32)) & 1;
    if (!present) continue;
    rows[table] = pe.readUInt32LE(p);
    p += 4;
  }

  const stringIndexSize = heapSizes & 0x01 ? 4 : 2;
  const guidIndexSize = heapSizes & 0x02 ? 4 : 2;
  const tableIndexSize = (table: number) => (rows[table] < 0x10000 ? 2 : 4);
  const codedIndexSize = (tagBits: number, tables: number[]) => (Math.max(...tables.map(t => rows[t])) < 1 << (16 - tagBits) ? 2 : 4);
  const readIndex = (offset: number, size: number) => (size === 2 ? pe.readUInt16LE(offset) : pe.readUInt32LE(offset));
  const readString = (index: number) => {
    const start = stringsStream + index;
    return pe.toString('utf8', start, pe.indexOf(0, start));
  };

  const moduleRowSize = 2 + stringIndexSize + 3 * guidIndexSize;
  const typeRefRowSize = codedIndexSize(2, [TABLE_MODULE, TABLE_MODULEREF, TABLE_ASSEMBLYREF, TABLE_TYPEREF]) + 2 * stringIndexSize;
  const extendsSize = codedIndexSize(2, [TABLE_TYPEDEF, TABLE_TYPEREF, TABLE_TYPESPEC]);
  const typeDefRowSize = 4 + 2 * stringIndexSize + extendsSize + tableIndexSize(TABLE_FIELD) + tableIndexSize(TABLE_METHODDEF);

  const types = new Set<string>();
  let row = p + rows[TABLE_MODULE] * moduleRowSize + rows[TABLE_TYPEREF] * typeRefRowSize;
  for (let i = 0; i < rows[TABLE_TYPEDEF]; i++, row += typeDefRowSize) {
    const flags = pe.readUInt32LE(row);
    if ((flags & 0x7) !== 1) continue; // TypeAttributes.Public (top-level only)
    const name = readString(readIndex(row + 4, stringIndexSize));
    const namespace = readString(readIndex(row + 4 + stringIndexSize, stringIndexSize));
    types.add(namespace ? `${namespace}.${name}` : name);
  }
  return types;
}
