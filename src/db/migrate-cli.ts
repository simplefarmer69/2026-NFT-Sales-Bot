import { runMigrations } from "./migrate.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  await runMigrations(databaseUrl);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
