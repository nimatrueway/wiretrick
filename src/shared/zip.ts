/** read a .zip's files (stored or deflated — what every zip tool writes) */
const MAX_TOTAL = 20 * 1024 * 1024;

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZip(buf: ArrayBuffer, keep: (path: string) => boolean = () => true): Promise<Record<string, Uint8Array>> {
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
        if (name.endsWith("/") || !keep(name)) continue;
        total += size;
        if (total > MAX_TOTAL) throw new Error("the zip file holds more than 20 MB");
        const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
        const data = u8.subarray(start, start + compSize);
        if (method === 0) out[name] = data.slice();
        else if (method === 8) out[name] = await inflate(data);
        else throw new Error(`"${name}" is compressed in a way this can't read (method ${method})`);
    }
    return out;
}
