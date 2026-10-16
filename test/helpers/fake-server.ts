import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Reply {
  status?: number;
  /** Serialized as-is when a string, else JSON.stringify'd. */
  body?: string | object;
  headers?: Record<string, string>;
  /** Never respond, so the client's own timeout has to fire. */
  hang?: boolean;
}

export type Handler = (req: RecordedRequest, n: number) => Reply;

export interface FakeServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Queue one reply per request; the last entry repeats once exhausted. */
  replyWith(...replies: Reply[]): void;
  replyUsing(handler: Handler): void;
  close(): Promise<void>;
}

/** A throwaway HTTP server on an ephemeral loopback port. Nothing here touches
 *  the network beyond 127.0.0.1. */
export async function startFakeServer(): Promise<FakeServer> {
  let queue: Reply[] = [{ status: 200, body: {} }];
  let handler: Handler | undefined;
  const requests: RecordedRequest[] = [];
  const open = new Set<IncomingMessage>();

  const server: Server = createServer((req, res) => {
    open.add(req);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const record: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);

      const n = requests.length - 1;
      const reply = handler
        ? handler(record, n)
        : (queue[Math.min(n, queue.length - 1)] ?? { status: 200, body: {} });

      if (reply.hang) return; // leave the socket open; the client must time out

      const body =
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body ?? {});
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...reply.headers,
      };
      res.writeHead(reply.status ?? 200, headers);
      res.end(body);
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    replyWith(...replies: Reply[]) {
      queue = replies;
      handler = undefined;
    },
    replyUsing(h: Handler) {
      handler = h;
      queue = [];
    },
    async close() {
      // Destroy any socket parked by a `hang` reply, else close() never fires.
      for (const req of open) req.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
