import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import type { Props } from "./props.js";

/** Serve one MCP request for the signed-in user. The provider has already
 *  checked the bearer token before this runs; `props` are that user's
 *  credentials, so each request gets a server bound to their own account. */
export function serveMcp(
  request: Request,
  props: Props,
  baseUrl?: string
): Promise<Response> {
  const handler = createMcpHandler(() =>
    createServer({
      apiKey: props.apiKey,
      athleteId: props.athleteId,
      deleteMode: props.deleteMode,
      timeZone: props.timeZone,
      baseUrl,
    })
  );
  return handler.fetch(request);
}
