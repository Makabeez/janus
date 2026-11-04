// Project the registry config to a static JSON the browser bundle can import
// (@rome-protocol/registry reads the filesystem, so it can't run in the browser).
// Runs before `dev` / `build`. Reads .env overrides + the deployed JANUS_ADDRESS.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { configFromEnv } from "../lib/config.js";

const cfg = configFromEnv();
const janus = process.env.JANUS_ADDRESS || null;
if (janus && !/^0x[0-9a-fA-F]{40}$/.test(janus)) throw new Error(`JANUS_ADDRESS is not an address: ${janus}`);
const out = { ...cfg, janus };
writeFileSync(new URL("../src/config.generated.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("wrote src/config.generated.json —", `chain ${out.chainId}`, janus ? `janus ${janus}` : "(run `npm run deploy`, then set JANUS_ADDRESS)");
