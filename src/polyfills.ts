// Some Solana libraries (spl-token's metadata module) read Node's global `Buffer`
// as soon as they load. Browsers have no such global, so provide it before
// anything else is imported.
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
