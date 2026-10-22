import type { DeleteMode } from "../src/server.js";

/** What a grant carries for its user. The OAuth provider stores this
 *  encrypted with a key only the user's token unwraps, and hands it back on
 *  every request to `/mcp`. */
export interface Props {
  apiKey: string;
  athleteId: string;
  deleteMode: DeleteMode;
  timeZone?: string;
}
