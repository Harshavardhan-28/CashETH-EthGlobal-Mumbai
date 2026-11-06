/** Entry point of `pnpm -F @casheth/agents buy`: loads `.env` / `.env.accounts`, then runs the CLI. */
import { loadEnv } from "@casheth/shared";
import { main } from "./buyCli.js";

try {
  loadEnv();
} catch {
  // loadEnv reads the .env files into process.env before it validates; the CLI checks the variables it needs itself.
}
process.exitCode = await main(process.argv.slice(2), process.env);
