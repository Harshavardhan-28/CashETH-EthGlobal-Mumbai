import { loadEnv } from "@casheth/shared";
import { startMerchant } from "./server.js";

const env = loadEnv();
const port = Number(process.env.MERCHANT_PORT ?? 4021);
await startMerchant(env, port);
console.log(`merchant listening on http://localhost:${port} (payTo ${env.MERCHANT_ACCOUNT_ID}, facilitator ${env.X402_FACILITATOR_URL})`);
