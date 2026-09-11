// Cloudflare Pages Function — POST /api/llm
// Place at: functions/api/llm.js  in the yashnaarora-com repo.
//
// SECURITY CONTRACT (do not weaken):
//   - The OpenAI key is read ONLY from env.OPENAI_API_KEY (an encrypted Cloudflare secret).
//   - The key is never returned to the browser, never logged, never placed in client code.
//   - Per-IP rate limiting bounds abuse on a public, no-login site.
//   - Same-origin only; no wildcard CORS.
//
// EXTENDED for the DOWA prototype (reviewed extensions, security contract unchanged):
//   - Optional `json: true` in the body → asks the model for a guaranteed-JSON response
//     (response_format json_object), because DOWA renders structured output blocks.
//   - Optional `max_tokens` in the body, HARD-CLAMPED server-side to MAX_TOKENS_CAP.
//   - Prompt/system size caps raised (DOWA sends stage inputs + design-memory context),
//     still bounded server-side to keep worst-case cost fixed.

// ---- Tunables ----
const RATE_LIMIT = 10; // max requests ...
const RATE_WINDOW_MS = 60_000; // ...per this window, per IP
const MODEL = "gpt-4o-mini"; // cheap, capable model for a demo
const DEFAULT_MAX_TOKENS = 800;
const MAX_TOKENS_CAP = 4000; // server-side ceiling regardless of what the client asks for
const PROMPT_CAP = 24000; // chars — DOWA sends raw stage inputs + memory context
const SYSTEM_CAP = 8000; // chars

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
  // 1. Key must be present as a server-side secret.
  const key = env.OPENAI_API_KEY;
  if (!key) {
    return json({ error: "OPENAI_API_KEY not set on the server" }, 500);
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
    return json({ error: "Body must be JSON: { prompt, system?, json?, max_tokens? }" }, 400);
  }
  const prompt = (payload.prompt || "").toString().slice(0, PROMPT_CAP);
  const system = (payload.system || "You are a helpful assistant for a product prototype.")
    .toString()
    .slice(0, SYSTEM_CAP);
  if (!prompt.trim()) {
    return json({ error: "Missing 'prompt'." }, 400);
  }
  const wantJson = payload.json === true;
  const maxTokens = Math.min(
    Number.isFinite(payload.max_tokens) ? Math.max(1, payload.max_tokens) : DEFAULT_MAX_TOKENS,
    MAX_TOKENS_CAP
  );

  // 4. Call OpenAI from the server. Key stays here.
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        ...(wantJson ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
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
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  // 5. Return ONLY the model text to the browser.
  return json({ text });
}

// Reject non-POST methods cleanly.
export async function onRequest({ request }) {
  if (request.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }
}
