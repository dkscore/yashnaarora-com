// Cloudflare Pages Function — POST /api/llm
// Place at: functions/api/llm.js  in the yashnaarora-com repo.
//
// SECURITY CONTRACT (do not weaken):
//   - The LLM key is read ONLY from an encrypted Cloudflare secret
//     (ANTHROPIC_API_KEY, falling back to the original OPENAI_API_KEY name).
//   - The key is never returned to the browser, never logged, never placed in client code.
//   - Per-IP rate limiting bounds abuse on a public, no-login site.
//   - Same-origin only; no wildcard CORS.
//
// PROVIDER: Anthropic Claude (switched from OpenAI 2026-09-12 — the stored key
// is now an Anthropic key). Request/response shape to the browser is unchanged:
// { prompt, system?, json?, max_tokens?, effort? } → { text }.

// ---- Tunables ----
const RATE_LIMIT = 10; // max requests ...
const RATE_WINDOW_MS = 60_000; // ...per this window, per IP
const MODEL = "claude-opus-5";
const DEFAULT_MAX_TOKENS = 800;
const MAX_TOKENS_CAP = 4000; // server-side ceiling regardless of what the client asks for
const PROMPT_CAP = 24000; // chars — DOWA sends raw stage inputs + memory context
const SYSTEM_CAP = 8000; // chars
const EFFORTS = new Set(["low", "medium", "high"]); // allowed effort levels from the client
const DEFAULT_EFFORT = "low"; // keeps demo latency snappy; raise for deeper reasoning

// In-memory per-IP counter. Note: CF may run multiple isolates, so this is a best-effort
// soft limit (plenty for an interview demo). For strict limits use CF's Rate Limiting or KV.
const hits = new Map(); // ip -> { count, resetAt }

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  // 1. Key must be present as a server-side secret (either secret name works).
  const key = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY;
  if (!key) {
    return json({ error: "LLM API key not set on the server" }, 500);
  }

  // 2. Per-IP rate limit (CF provides the real client IP).
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (rateLimited(ip)) {
    return json({ error: "Rate limited — slow down and try again in a minute." }, 429);
  }

  // 3. Parse input.
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be JSON: { prompt, system?, json?, max_tokens?, effort? }" }, 400);
  }
  const prompt = (payload.prompt || "").toString().slice(0, PROMPT_CAP);
  let system = (payload.system || "You are a helpful assistant for a product prototype.")
    .toString()
    .slice(0, SYSTEM_CAP);
  if (!prompt.trim()) {
    return json({ error: "Missing 'prompt'." }, 400);
  }
  const wantJson = payload.json === true;
  if (wantJson) {
    system += "\nRespond with a single valid JSON object only — no markdown fences, no prose outside the JSON.";
  }
  const maxTokens = Math.min(
    Number.isFinite(payload.max_tokens) ? Math.max(1, payload.max_tokens) : DEFAULT_MAX_TOKENS,
    MAX_TOKENS_CAP
  );
  const effort = EFFORTS.has(payload.effort) ? payload.effort : DEFAULT_EFFORT;

  // 4. Call Anthropic from the server. Key stays here.
  //    Thinking is adaptive by default on this model; effort controls depth/latency.
  //    Server-side refusal fallbacks enabled so a safety decline degrades gracefully.
  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        output_config: { effort },
        fallbacks: "default",
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch (e) {
    return json({ error: "Failed to reach the LLM provider." }, 502);
  }

  if (!upstream.ok) {
    // Surface a generic error — never leak provider internals or the key.
    return json({ error: `LLM provider error (${upstream.status}).` }, 502);
  }

  const data = await upstream.json();
  if (data?.stop_reason === "refusal") {
    return json({ error: "The model declined this request." }, 502);
  }
  const text = (data?.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  // 5. Return ONLY the model text to the browser.
  return json({ text });
}

// Reject non-POST methods cleanly.
export async function onRequest({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }
}
