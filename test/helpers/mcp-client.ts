import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../dist/index.js", import.meta.url)
);

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** A minimal JSON-RPC-over-stdio client: enough to drive the real server
 *  binary without pulling in the SDK's client, so the test exercises the wire
 *  format the host actually speaks. */
export class ServerProcess {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  public stderr = "";

  private constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr += chunk));
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC frame; ignore
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    }
  }

  private send(payload: object) {
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        10_000
      );
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Spawn the built server and complete the MCP handshake. */
  static async start(
    env: Record<string, string> = {}
  ): Promise<{ server: ServerProcess; initialize: JsonRpcResponse }> {
    const server = new ServerProcess({
      INTERVALS_API_KEY: "test-key",
      INTERVALS_ATHLETE_ID: "i1",
      ...env,
    });
    const initialize = await server.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    });
    server.notify("notifications/initialized");
    return { server, initialize };
  }

  async stop(): Promise<void> {
    this.child.kill();
    await new Promise<void>((resolve) => this.child.on("exit", () => resolve()));
  }
}

/** Run the server binary to completion and report how it exited. Used for the
 *  missing-credentials path, where the process is expected to die at once. */
export function runUntilExit(
  env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    // Start from an environment with no credentials, whatever the shell has.
    const base = { ...process.env };
    delete base.INTERVALS_API_KEY;
    delete base.INTERVALS_ATHLETE_ID;
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...base, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}
