// Entry point when deployed as a Cloudflare Worker (with static assets).
// Cloudflare Pages ignores this file and uses functions/ instead.
import { onRequestGet } from "../functions/api/scoreboard.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/scoreboard") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return onRequestGet({ request, env, waitUntil: (p) => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
