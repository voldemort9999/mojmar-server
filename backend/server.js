// Mojmar backend proxy (dev: local, prod: DigitalOcean).
// - Verifies the user's Supabase JWT on every request.
// - Holds the OpenRouter key server-side (never in the client).
// - Gates AI calls on credit balance; meters usage via /heartbeat.
// Thin proxy: the app sends the full OpenRouter payload (minus the key), we
// inject the key + gate + stream the response straight back.

import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_KEY, PORT = 8787,
  RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET,
} = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_KEY) {
  console.error("[proxy] Missing env — set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_KEY in backend/.env");
  process.exit(1);
}
const paymentsReady = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET);
if (!paymentsReady) console.warn("[proxy] Razorpay env not set — /create-payment + webhook disabled until configured");

// Server-authoritative packs. Client only sends a pack id + quantity; price and
// seconds are decided HERE (never trust client amounts). ₹599=60min, ₹159=10min.
// Pack ids must match the payments_pack_check DB constraint ('p599','p159').
const PACKS = {
  p599: { price_inr: 599, seconds: 3600, label: "60 minutes" },
  p159: { price_inr: 159, seconds: 600, label: "10 minutes" },
};
const MAX_QTY = 10;

// service_role client — bypasses RLS, can call the credit RPCs + verify JWTs
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(cors());
// Capture the raw body so the Razorpay webhook can verify its HMAC signature.
app.use(express.json({ limit: "30mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

// ── Payments (Razorpay) ──────────────────────────────────────────────────────

// Create a hosted Razorpay Payment Link for a pack; the app opens it in the
// system browser (robust for a desktop app — no in-webview checkout pitfalls).
// The link carries notes {user_id, pack, quantity, seconds} that the webhook trusts.
app.post("/create-payment", auth, async (req, res) => {
  if (!paymentsReady) return res.status(503).json({ error: "payments_unconfigured" });
  const packId = String(req.body?.pack || "");
  const qty = Math.min(MAX_QTY, Math.max(1, Math.floor(Number(req.body?.quantity) || 1)));
  const pack = PACKS[packId];
  if (!pack) return res.status(400).json({ error: "bad_pack" });

  const amountPaise = pack.price_inr * qty * 100;
  const seconds = pack.seconds * qty;

  let email;
  try { const { data } = await admin.auth.admin.getUserById(req.userId); email = data?.user?.email; } catch {}

  const auth64 = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  let r, link;
  try {
    r = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { Authorization: `Basic ${auth64}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        accept_partial: false,
        description: `Mojmar ${pack.label}${qty > 1 ? ` ×${qty}` : ""}`,
        customer: email ? { email } : undefined,
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { user_id: req.userId, pack: packId, quantity: String(qty), seconds: String(seconds) },
      }),
    });
    link = await r.json();
  } catch {
    return res.status(502).json({ error: "razorpay_unreachable" });
  }
  if (!r.ok || !link?.short_url) {
    console.error("[pay] link create failed", r?.status, link);
    return res.status(502).json({ error: "razorpay_error" });
  }
  res.json({ url: link.short_url });
});

// Razorpay webhook — the ONLY thing that grants paid credits. Authenticated by
// HMAC signature (not JWT). Idempotent via record_payment (unique payment_id).
app.post("/razorpay-webhook", async (req, res) => {
  if (!paymentsReady) return res.status(503).end();
  const sig = req.headers["x-razorpay-signature"] || "";
  const expected = crypto.createHmac("sha256", RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest("hex");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(400).json({ error: "bad_signature" });
  }

  if (req.body?.event !== "payment_link.paid") return res.json({ ok: true, ignored: req.body?.event });

  try {
    const plink = req.body.payload?.payment_link?.entity || {};
    const payment = req.body.payload?.payment?.entity || {};
    const notes = plink.notes || {};
    const pack = PACKS[notes.pack];
    const qty = Math.min(MAX_QTY, Math.max(1, parseInt(notes.quantity) || 1));
    if (!pack || !notes.user_id || !payment.id) return res.json({ ok: true, skipped: "missing_fields" });

    const seconds = pack.seconds * qty;
    if (Number(payment.amount) !== pack.price_inr * qty * 100) {
      console.warn("[webhook] amount mismatch", payment.amount, "vs", pack.price_inr * qty * 100);
      return res.json({ ok: true, skipped: "amount_mismatch" });
    }

    const { data: granted, error } = await admin.rpc("record_payment", {
      p_user: notes.user_id, p_pack: notes.pack, p_qty: qty,
      p_amount_inr: pack.price_inr * qty, p_seconds: seconds,
      p_order: plink.id || null, p_payment: payment.id,
    });
    if (error) { console.error("[webhook] record_payment", error); return res.status(500).json({ error: "grant_failed" }); }
    console.log(`[webhook] ${granted ? "granted" : "duplicate"} ${seconds}s → ${notes.user_id} (${payment.id})`);
    res.json({ ok: true, granted });
  } catch (e) {
    console.error("[webhook]", e);
    res.status(500).json({ error: "webhook_error" });
  }
});

app.listen(PORT, () => console.log(`[proxy] listening on http://localhost:${PORT}`));
