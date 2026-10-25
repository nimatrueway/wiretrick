/**
 * Bytes across chrome.runtime messaging, which JSON-serializes (a
 * Uint8Array would arrive as a plain object of indices). packBytes turns
 * every Uint8Array in a value into { __wtBytes: "<base64>" }; unpackBytes
 * reverses it. postMessage (structured clone) carries Uint8Array natively,
 * so only runtime-messaging hops need this.
 */

export function bytesToBase64(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as any);
    return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

// tag checks, not instanceof: values may come from another realm (page → content script)
const isPlain = (v: any): boolean => v !== null && typeof v === "object" && Object.prototype.toString.call(v) === "[object Object]";
const isBytes = (v: any): v is Uint8Array => Object.prototype.toString.call(v) === "[object Uint8Array]";

export function packBytes<T>(v: T): T {
    if (isBytes(v)) return { __wtBytes: bytesToBase64(v) } as any;
    if (Array.isArray(v)) return v.map(packBytes) as any;
    if (isPlain(v)) {
        const out: Record<string, any> = {};
        for (const [k, x] of Object.entries(v as any)) out[k] = packBytes(x);
        return out as T;
    }
    return v;
}

export function unpackBytes<T>(v: T): T {
    if (Array.isArray(v)) return v.map(unpackBytes) as any;
    if (isPlain(v)) {
        const o = v as any;
        if (typeof o.__wtBytes === "string" && Object.keys(o).length === 1) return base64ToBytes(o.__wtBytes) as any;
        const out: Record<string, any> = {};
        for (const [k, x] of Object.entries(o)) out[k] = unpackBytes(x);
        return out as T;
    }
    return v;
}
