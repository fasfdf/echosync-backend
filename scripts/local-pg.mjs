// Dev-only helper: user-space embedded Postgres for local testing.
import EmbeddedPostgres from "embedded-postgres";

const pg = new EmbeddedPostgres({
  databaseDir: "/tmp/echosync-pg",
  user: "echosync",
  password: "echosync",
  port: 5433,
  persistent: true,
  // Sandbox/container environments often block unix sockets — TCP only.
  postgresFlags: ["-c", "unix_socket_directories="],
});

import { existsSync } from "node:fs";

if (!existsSync("/tmp/echosync-pg/PG_VERSION")) {
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("echosync");
} catch {
  // database already exists
}
console.log("embedded postgres ready on port 5433");
process.stdin.resume();
const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
