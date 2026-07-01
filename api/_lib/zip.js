// Minimal, dependency-free ZIP writer (STORE method — no compression). Listing
// photos are already-compressed JP/PNG/WebP, so storing keeps this tiny and fast.
// Produces a standard .zip (local headers + central directory + EOCD).

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

// files: [{ name, data: Buffer }] -> Buffer
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const size = data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4);         // version needed
    lfh.writeUInt16LE(0x0800, 6);     // flags: UTF-8 filename
    lfh.writeUInt16LE(0, 8);          // method: 0 = store
    lfh.writeUInt16LE(0, 10);         // mod time
    lfh.writeUInt16LE(0, 12);         // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);      // compressed size
    lfh.writeUInt32LE(size, 22);      // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);         // extra length
    chunks.push(lfh, nameBuf, data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central dir header signature
    cdh.writeUInt16LE(20, 4);         // version made by
    cdh.writeUInt16LE(20, 6);         // version needed
    cdh.writeUInt16LE(0x0800, 8);     // flags
    cdh.writeUInt16LE(0, 10);         // method
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);         // extra length
    cdh.writeUInt16LE(0, 32);         // comment length
    cdh.writeUInt16LE(0, 34);         // disk number
    cdh.writeUInt16LE(0, 36);         // internal attrs
    cdh.writeUInt32LE(0, 38);         // external attrs
    cdh.writeUInt32LE(offset, 42);    // local header offset
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // EOCD signature
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // central dir start disk
  eocd.writeUInt16LE(files.length, 8);     // entries on this disk
  eocd.writeUInt16LE(files.length, 10);    // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(offset, 16);          // central dir offset
  eocd.writeUInt16LE(0, 20);               // comment length
  return Buffer.concat([...chunks, centralBuf, eocd]);
}
