'use strict';

require('dotenv').config();

const express  = require('express');
const path     = require('path');
const { createCheckout } = require('../index');

const app = express();

// ── Configure the ForgeLayer plugin ─────────────────────────────────────────
const checkout = createCheckout({
  // Required: your ForgeLayer API key from https://forgelayer.io/dashboard
  apiKey:               process.env.FORGELAYER_API_KEY || 'flk_live_YOUR_KEY',

  // Optional: a webhookSecret from config overrides env var / saved file.
  // Usually you leave this blank and let the plugin manage it after
  // you call checkout.setupWebhook() once.
  // webhookSecret: process.env.FORGELAYER_WEBHOOK_SECRET,

  currency:             'USD',
  defaultChain:         'ethereum',
  defaultToken:         'USDT',
  paymentWindowMinutes: 30,
  reuseAddress:         false,

  // Called by BOTH the balance-polling path (/status) and the webhook path
  onConfirmed: async (orderId, orderData) => {
    console.log('[ForgeLayer] Payment confirmed for order:', orderId, orderData);
    // e.g. await db.markOrderPaid(orderId);
  },

  // Called for every verified webhook event (optional — use for custom logging, etc.)
  onWebhookEvent: async (event, data) => {
    console.log('[ForgeLayer] Webhook event:', event, data);
  },
});

// ── Mount the checkout middleware at /fl ─────────────────────────────────────
// Provides:
//   GET  /fl/checkout.js  → browser script (auto-configured)
//   POST /fl/create       → generate deposit address
//   GET  /fl/status       → poll payment status
//   POST /fl/webhook      → receive ForgeLayer deposit_confirmed events
app.use('/fl', checkout.middleware());

// ── Serve the demo HTML ──────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'demo.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
  console.log(`[ForgeLayer Demo] http://localhost:${PORT}`);

  // ── ONE-TIME WEBHOOK SETUP ────────────────────────────────────────────────
  // Run this ONCE the first time you deploy, or whenever your URL changes.
  // The generated secret is saved to .fl_webhook_secret and auto-loaded on
  // every subsequent restart — you don't need to call this again.
  //
  // Replace the URL below with your real public URL (ngrok, production domain, etc.)
  //
  // const result = await checkout.setupWebhook(
  //   `https://YOUR_DOMAIN.com/fl/webhook`,
  //   1  // confirmations required
  // );
  // console.log('[ForgeLayer] Webhook registered:', result);
});
