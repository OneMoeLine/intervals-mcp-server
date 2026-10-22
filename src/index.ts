#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  createServer,
  DELETE_MODES,
  isValidTimeZone,
  parseDeleteMode,
} from "./server.js";

const API_KEY = process.env.INTERVALS_API_KEY;
const ATHLETE_ID = process.env.INTERVALS_ATHLETE_ID;

if (!API_KEY || !ATHLETE_ID) {
  console.error(
    "Missing required environment variables: INTERVALS_API_KEY, INTERVALS_ATHLETE_ID"
  );
  process.exit(1);
}

const deleteMode = parseDeleteMode(process.env.INTERVALS_DELETE_MODE);

if (!deleteMode) {
  console.error(
    `Invalid INTERVALS_DELETE_MODE: ${process.env.INTERVALS_DELETE_MODE?.toLowerCase()}. ` +
      `Valid values are: ${DELETE_MODES.join(", ")}`
  );
  process.exit(1);
}

const timeZone = process.env.INTERVALS_TIMEZONE || undefined;

if (timeZone && !isValidTimeZone(timeZone)) {
  console.error(
    `Invalid INTERVALS_TIMEZONE: ${timeZone}. ` +
      `Use an IANA zone name, e.g. America/Chicago`
  );
  process.exit(1);
}

const server = createServer({
  apiKey: API_KEY,
  athleteId: ATHLETE_ID,
  deleteMode,
  timeZone,
});

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => {
    console.error("Intervals.icu MCP server running on stdio");
  })
  .catch((err) => {
    console.error("Failed to start Intervals.icu MCP server:", err);
    process.exit(1);
  });
