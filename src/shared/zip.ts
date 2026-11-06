/** read a .zip's files (stored or deflated — what every zip tool writes), and write one (stored); folder entries end in "/" */
const MAX_TOTAL = 20 * 1024 * 1024;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buf: ArrayBuffer, keep: (path: string) => boolean = () => true): Promise<Record<string, Uint8Array>> {
    return (await readZipEntries(buf, keep)).files;
}

/** the files and the folder entries (e.g. empty folders, without their trailing "/") */
export async function readZipEntries(buf: ArrayBuffer, keep: (path: string) => boolean = () => true): Promise<{ files: Record<string, Uint8Array>; folders: string[] }> {
    const v = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let p = buf.byteLength - 22; p >= Math.max(0, buf.byteLength - 22 - 65535); p--)
        if (v.getUint32(p, true) === 0x06054b50) {
            eocd = p;
            break;
        }
    if (eocd < 0) throw new Error("not a zip file");
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const utf8 = new TextDecoder();
    const out: Record<string, Uint8Array> = {};
    const folders: string[] = [];
    let total = 0;
    for (let k = 0; k < count; k++) {
        if (v.getUint32(p, true) !== 0x02014b50) throw new Error("the zip file is damaged");
        const method = v.getUint16(p + 10, true);
        const compSize = v.getUint32(p + 20, true);
        const size = v.getUint32(p + 24, true);
        const nameLen = v.getUint16(p + 28, true);
        const local = v.getUint32(p + 42, true);
        const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
        if (!keep(name)) continue;
        if (name.endsWith("/")) {
            folders.push(name.slice(0, -1));
            continue;
        }
        total += size;
        if (total > MAX_TOTAL) throw new Error("the zip file holds more than 20 MB");
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = u8.subarray(start, start + compSize);
        if (method === 0) out[name] = data.slice();
        else if (method === 8) out[name] = await inflate(data);
        else throw new Error(`"${name}" is compressed in a way this can't read (method ${method})`);
    }
    return { files: out, folders };
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** a .zip of these files (path → text or bytes; a path ending in "/" is a folder), stored uncompressed — scripts are small */
export function writeZip(files: Record<string, string | Uint8Array>, date = new Date()): Uint8Array {
    const enc = new TextEncoder();
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const [path, content] of Object.entries(files)) {
        const name = enc.encode(path);
        const data = typeof content === "string" ? enc.encode(content) : content;
        const crc = crc32(data);
        // the fields local and central headers share, from "version needed" on
        const common = (v: DataView, at: number): void => {
            v.setUint16(at, 20, true);
            v.setUint16(at + 2, 0x0800, true); // names are UTF-8
            v.setUint16(at + 4, 0, true); // stored
            v.setUint16(at + 6, time, true);
            v.setUint16(at + 8, day, true);
            v.setUint32(at + 10, crc, true);
            v.setUint32(at + 14, data.length, true);
            v.setUint32(at + 18, data.length, true);
            v.setUint16(at + 22, name.length, true);
        };
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        common(lv, 4);
        local.set(name, 30);
        const entry = new Uint8Array(46 + name.length);
        const cv = new DataView(entry.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        common(cv, 6);
        if (path.endsWith("/")) cv.setUint32(38, 0x10, true); // MS-DOS directory attribute
        cv.setUint32(42, offset, true);
        entry.set(name, 46);
        parts.push(local, data);
        central.push(entry);
        offset += local.length + data.length;
    }
    const size = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, size, true);
    ev.setUint32(16, offset, true);
    const out = new Uint8Array(offset + size + 22);
    let at = 0;
    for (const b of [...parts, ...central, end]) {
        out.set(b, at);
        at += b.length;
    }
    return out;
}
