/** chrome.runtime messaging helpers shared by the extension pages. */

export function send<T = any>(msg: any): Promise<T> {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (resp: T) => {
            const err = (chrome.runtime as any).lastError;
            if (err) reject(new Error(err.message));
            else resolve(resp);
        });
    });
}

/** MV3: the SW idles out after ~30s — a page's first messages race its
 * wake-up ("Receiving end does not exist"). Retry until it answers. */
export async function sendWake<T = any>(msg: any, attempts = 6, delayMs = 350): Promise<T> {
    let last: any;
    for (let i = 0; i < attempts; i++) {
        try {
            return await send<T>(msg);
        } catch (e: any) {
            if (!/receiving end|context invalidated|message port/i.test(e?.message || "")) throw e;
            last = e;
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw last;
}
