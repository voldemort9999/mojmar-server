// Mojmar backend proxy (dev: local, prod: DigitalOcean).
// - Verifies the user's Supabase JWT on every request.
// - Holds the OpenRouter key server-side (never in the client).
// - Gates AI calls on credit balance; meters usage via /heartbeat.
// Thin proxy: the app sends the full OpenRouter payload (minus the key), we
// inject the key + gate + stream the response straight back.

import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_KEY, PORT = 8787 } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_KEY) {
  console.error("[proxy] Missing env — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_KEY in backend/.env");
  process.exit(1);
}

// service_role client — bypasses RLS, can call the credit RPCs + verify JWTs
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" })); // audio payloads

// Verify Supabase access token → req.userId
async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "no token" });
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: "invalid token" });
  req.userId = data.user.id;
  next();
}

async function balanceSeconds(userId) {
  const { data } = await admin.rpc("available_seconds", { p_user: userId });
  return data ?? 0;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// Current balance (seconds)
app.get("/balance", auth, async (req, res) => {
  res.json({ seconds: await balanceSeconds(req.userId) });
});

// Metering heartbeat — app calls every ~20s while a session is recording.
// Deducts `seconds` from the user's credits (expiring-first).
app.post("/heartbeat", auth, async (req, res) => {
  const seconds = Math.max(0, Math.floor(Number(req.body?.seconds) || 0));
  const sessionId = req.body?.sessionId || null;
  try {
    const { data, error } = await admin.rpc("consume_credits", {
      p_user: req.userId, p_seconds: seconds, p_session: sessionId,
    });
    if (error) {
      // INSUFFICIENT_CREDITS or other → treat as depleted
      const bal = await balanceSeconds(req.userId);
      return res.json({ seconds: bal, depleted: true });
    }
    res.json({ seconds: data ?? 0, depleted: (data ?? 0) <= 0 });
  } catch {
    res.json({ seconds: 0, depleted: true });
  }
});

// AI proxy — gate on balance, inject OpenRouter key, stream the response back.
app.post("/generate", auth, async (req, res) => {
  if ((await balanceSeconds(req.userId)) <= 0) {
    return res.status(402).json({ error: "out_of_credits" });
  }

  let upstream;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://mojmar.app",
        "X-Title": "Mojmar",
      },
      body: JSON.stringify(req.body),
    });
  } catch (e) {
    return res.status(502).json({ error: "upstream_unreachable" });
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch { /* client disconnected */ }
  res.end();
});

app.listen(PORT, () => console.log(`[proxy] listening on http://localhost:${PORT}`));
