import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleAuthorize } from "./authorize.js";
import { serveMcp } from "./mcp.js";
import type { Props } from "./props.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** The shared code people enter to sign in, set with `wrangler secret put`. */
  INVITE_CODE?: string;
  /** API root override, for local end-to-end tests against a fake server. */
  INTERVALS_BASE_URL?: string;
}

const DAY = 24 * 60 * 60;

/** The provider needs its public URL at construction (it is the tokens'
 *  audience), and a Worker only learns it from the requests it is routed:
 *  `*.workers.dev`, a custom domain, or localhost under `wrangler dev`.
 *  Cloudflare routes only this Worker's own hostnames here, so the request's
 *  origin is trustworthy. One provider per origin, built on first use. */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: {
        fetch(request, env, ctx) {
          return serveMcp(request, ctx.props as Props, env.INTERVALS_BASE_URL);
        },
      },
      defaultHandler: {
        fetch(request, env) {
          const url = new URL(request.url);
          if (url.pathname === "/authorize") {
            return handleAuthorize(request, env.OAUTH_PROVIDER, {
              inviteCode: env.INVITE_CODE,
              baseUrl: env.INTERVALS_BASE_URL,
            });
          }
          if (url.pathname === "/") {
            return new Response(
              "Intervals.icu MCP server. Add this URL with /mcp as a custom " +
                "connector in your MCP client.",
              { headers: { "Content-Type": "text/plain; charset=utf-8" } }
            );
          }
          return new Response("Not found", { status: 404 });
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "Intervals.icu",
      },
      accessTokenTTL: 60 * 60,
      // A grant lives while it is used and lapses after two idle months, so
      // nobody has to sign in again just because a month went by.
      refreshTokenTTL: 60 * DAY,
      refreshTokenIdleTTL: 60 * DAY,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
