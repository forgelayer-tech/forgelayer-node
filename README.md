# @forgelayer-tech/node

> Node.js / Express middleware for accepting crypto payments via [ForgeLayer](https://forgelayer.io).

Drop `createCheckout()` into any Express app and get crypto payment endpoints in seconds — address generation, real-time rate conversion, payment polling, webhook verification, and pluggable storage all included.

---

## Install

```bash
npm install @forgelayer-tech/node
```

---

## Quick Start

```js
const express = require('express');
const { createCheckout } = require('@forgelayer-tech/node');

const app = express();

const checkout = createCheckout({
  apiKey: process.env.FORGELAYER_API_KEY,

  onConfirmed: async (orderId, order) => {
    // Payment confirmed — update your database here
    await db.markOrderPaid(orderId);
  },
});

// Mounts /fl/create, /fl/status, /fl/webhook
app.use('/fl', checkout.middleware());

app.listen(3000);
```

Set your API key in `.env`:

```
FORGELAYER_API_KEY=flk_live_...
```

Get your API key at [forgelayer.io/dashboard](https://forgelayer.io/dashboard).

---

## How It Works

```
React / browser
   │
   ├── POST /fl/create   →  generates ForgeLayer deposit address
   ├── GET  /fl/status   →  polls for payment confirmation
   └── POST /fl/webhook  →  receives ForgeLayer webhook events (HMAC-verified)
```

Rates are fetched from CoinGecko once at startup and refreshed every 60 seconds in the background — checkout button clicks never wait on a network call.

---

## Configuration

```js
createCheckout({
  // Required
  apiKey: 'flk_live_...',

  // Defaults (all optional — React frontend can override per button)
  currency:             'USD',    // fiat currency for price display
  defaultChain:         'ethereum',
  defaultToken:         'USDT',
  paymentWindowMinutes: 30,       // browser countdown timer
  gracePeriodMinutes:   0,        // extra server-side window after expiry (see below)
  reuseAddress:         false,    // return same address for same orderId if still pending

  // Webhooks (optional — set via setupWebhook() instead)
  webhookSecret: process.env.FORGELAYER_WEBHOOK_SECRET,

  // Storage hooks — recommended for production (see Storage section below)
  async getOrder(sessionKey)           { return await db.findOne({ sessionKey }); },
  async saveOrder(sessionKey, order)   { await db.insertOne({ sessionKey, ...order }); },
  async updateOrder(sessionKey, patch) { await db.updateOne({ sessionKey }, { $set: patch }); },

  // Callbacks
  onConfirmed:    async (orderId, orderData) => {},  // payment confirmed
  onWebhookEvent: async (event, data) => {},         // any verified webhook event
});
```

### Supported chains

| Chain | Value |
|---|---|
| Ethereum | `ethereum` |
| BNB Smart Chain | `bsc` |
| Tron | `tron` |
| Bitcoin | `bitcoin` |

---

## Storage Hooks

By default, orders are kept in a process-local `Map` (fine for development). In production you should plug in your own database.

There are **3 required hooks** and **3 optional hooks**. All required hooks must be provided together or the plugin falls back to the in-memory store.

| Hook | Required | Purpose |
|---|---|---|
| `getOrder(sessionKey)` | ✅ | Load an order by session key |
| `saveOrder(sessionKey, order)` | ✅ | Persist a new order |
| `updateOrder(sessionKey, patch)` | ✅ | Apply a partial update to an existing order |
| `getOrderByAddress(address)` | optional | Address-based webhook lookup when `label`/`orderId` are absent |
| `getOrderByTxid(txid)` | optional | Replay attack prevention — detect duplicate webhooks |
| `findRecyclableAddress(chain)` | optional | Reuse expired/confirmed addresses before calling the ForgeLayer API |

```js
// MongoDB example
const checkout = createCheckout({
  apiKey: process.env.FORGELAYER_API_KEY,

  async getOrder(sessionKey) {
    return await Order.findOne({ sessionKey }).lean();
  },
  async saveOrder(sessionKey, order) {
    await Order.create({ sessionKey, ...order });
  },
  async updateOrder(sessionKey, patch) {
    await Order.updateOne({ sessionKey }, { $set: patch });
  },

  // Optional — address-based webhook lookup
  async getOrderByAddress(address) {
    return await Order.findOne({ address, status: 'pending' })
      .sort({ createdAt: -1 }).lean();
  },
  // Optional — reject duplicate webhooks
  async getOrderByTxid(txid) {
    return await Order.findOne({ confirmedTxid: txid }).lean();
  },
  // Optional — reuse addresses to conserve API quota
  async findRecyclableAddress(chain) {
    const now = Math.floor(Date.now() / 1000);
    const order = await Order.findOne({
      chain,
      $or: [
        { status: 'expired' },
        { status: 'confirmed', graceEndsAt: { $lt: now } },
      ],
    }).lean();
    return order?.address ?? null;
  },

  onConfirmed: async (orderId, order) => {
    await Order.updateOne({ orderId }, { $set: { paid: true } });
    await sendConfirmationEmail(order.email);
  },
});
```

```js
// PostgreSQL / Prisma example
const checkout = createCheckout({
  apiKey: process.env.FORGELAYER_API_KEY,

  async getOrder(sessionKey) {
    return await prisma.order.findUnique({ where: { sessionKey } });
  },
  async saveOrder(sessionKey, order) {
    await prisma.order.create({ data: { sessionKey, ...order } });
  },
  async updateOrder(sessionKey, patch) {
    await prisma.order.update({ where: { sessionKey }, data: patch });
  },

  // Optional — address-based webhook lookup
  async getOrderByAddress(address) {
    return await prisma.order.findFirst({
      where: { address, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
  },
  // Optional — reject duplicate webhooks
  async getOrderByTxid(txid) {
    return await prisma.order.findFirst({ where: { confirmedTxid: txid } });
  },
  // Optional — reuse addresses to conserve API quota
  async findRecyclableAddress(chain) {
    const now = Math.floor(Date.now() / 1000);
    return await prisma.order.findFirst({
      where: {
        chain,
        OR: [
          { status: 'expired' },
          { status: 'confirmed', graceEndsAt: { lt: now } },
        ],
      },
      select: { address: true },
    }).then(o => o?.address ?? null);
  },
});
```

### In-memory store behaviour

The default store is suitable for development and simple single-process deployments:
- Orders are lost on process restart
- Does not work with multiple server instances (clusters)
- Auto-cleans orders older than 24 hours to prevent memory leaks

---

## Grace Period

`gracePeriodMinutes` extends the server-side payment acceptance window beyond what the browser countdown shows.

**Use case:** Slow networks or Bitcoin (where a transaction can take hours to confirm after broadcast). The browser sees the timer expire and shows an "expired" UI, but your server continues checking balances and accepting webhook confirmations for the extra time.

```js
createCheckout({
  apiKey: '...',
  paymentWindowMinutes: 30,   // browser shows 30-min countdown
  gracePeriodMinutes:   60,   // server accepts payment for 90 min total
  onConfirmed: async (orderId, order) => {
    // Fires even if payment arrived after the browser countdown ended
    await sendLatePaymentConfirmationEmail(order);
  },
});
```

The `onConfirmed` callback receives the order with `status: 'confirmed'` regardless of whether the payment arrived during or after the payment window.

---

## Address Reuse

When `reuseAddress: true`, calling `/fl/create` with the same `orderId` within the payment window returns the existing deposit address instead of generating a new one:

```js
createCheckout({
  apiKey: '...',
  reuseAddress: true,  // or pass per-request: { reuseAddress: true } in the POST body
});
```

This prevents a new address being generated every time a user navigates back to the payment page.

---

## Routes

Mounted at the path you choose (`app.use('/fl', checkout.middleware())`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/fl/create` | Generate a deposit address. Returns address, QR URL, crypto amount, expiry. |
| `GET` | `/fl/status` | Poll payment status. Returns `pending`, `confirmed`, or `expired`. |
| `POST` | `/fl/webhook` | Receive ForgeLayer `deposit_confirmed` events (HMAC-SHA256 verified). |

### POST /fl/create

**Request body:**

```json
{
  "amount": 49.99,
  "currency": "USD",
  "chain": "ethereum",
  "token": "USDT",
  "orderId": "ORDER-123",
  "paymentWindow": 30,
  "reuseAddress": false
}
```

**Response:**

```json
{
  "ok": true,
  "address": "0xabc...",
  "chain": "ethereum",
  "chainName": "Ethereum",
  "token": "USDT",
  "amount": 49.99,
  "currency": "USD",
  "cryptoAmount": "49.99",
  "expiresAt": 1718300000,
  "orderId": "ORDER-123",
  "qrUrl": "https://api.qrserver.com/...",
  "sessionKey": "fl_abc123"
}
```

When the same address is reused, the response also includes `"reused": true`.

### GET /fl/status

```
GET /fl/status?session=fl_abc123
```

```json
{ "ok": true, "status": "pending" }
{ "ok": true, "status": "confirmed" }
{ "ok": true, "status": "expired" }
```

---

## Webhook Setup

Run once when you deploy (or whenever your public URL changes):

```js
const result = await checkout.setupWebhook('https://yoursite.com/fl/webhook');
console.log(result.webhookId); // saved automatically for future restarts
```

The secret is saved to `.fl_webhook_secret` alongside your project and auto-loaded on every restart — you never need to manage it manually.

---

## Usage with @forgelayer-tech/react

If you're using React on the frontend, pair this with [`@forgelayer-tech/react`](https://github.com/forgelayer-tech/forgelayer-react):

```js
// Backend — forgelayer-node
app.use('/fl', checkout.middleware());
```

```jsx
// Frontend — forgelayer-react
import { ForgeLayerButton } from '@forgelayer-tech/react';

<ForgeLayerButton amount={49.99} chain="ethereum" token="USDT" baseUrl="/fl" />
```

Configure your Vite dev server to proxy `/fl` to your backend:

```js
// vite.config.js
export default {
  server: {
    proxy: { '/fl': 'http://localhost:3000' },
  },
};
```

---

## API Reference

### `createCheckout(config)`

Returns an object with:

| Method | Description |
|---|---|
| `middleware()` | Returns an Express middleware function. Mount with `app.use('/fl', checkout.middleware())`. |
| `setupWebhook(url, confirmations?)` | One-time webhook registration with ForgeLayer. Saves secret to `.fl_webhook_secret`. |
| `handleCreate(req, res)` | Raw route handler for `POST /create`. |
| `handleStatus(req, res)` | Raw route handler for `GET /status`. |
| `handleWebhook(req, res)` | Raw route handler for `POST /webhook`. |

---

## Environment Variables

| Variable | Description |
|---|---|
| `FORGELAYER_API_KEY` | Your ForgeLayer API key. |
| `FORGELAYER_WEBHOOK_SECRET` | Optional — auto-managed by `setupWebhook()`. |

---

## Changelog

### 1.1.5
- **Webhook fix** — removed `userRef`/`tag` from `orderId` resolution chain; these fields may be absent or contain non-order values. Falls through to address-based lookup instead
- **Webhook fix** — `txHash` now accepted as an alias for `txid` in the webhook payload

### 1.1.4
- **Proactive address recycling** — checks `findRecyclableAddress` before calling the ForgeLayer API, conserving quota
- **txHash deduplication window** — extended from 24 h to 7 days
- **Address normalization** — EVM (`0x`-prefix) addresses lowercased for consistent storage; Tron and Bitcoin addresses preserved as-is (Base58Check is case-sensitive)
- **Asset type validation** — webhook `type` field (`native`/`token`) now validated against the order before confirming

### 1.1.3
- **Webhook event fix** — only `deposit_confirmed` is handled; other event names are acknowledged and ignored
- **Exact amount check** — removed 1 % payment tolerance; received amount must be ≥ expected

### 1.1.2
- **Grace period fix** — grace end time is now stored on the order at creation; no longer recalculated from current config (which could differ if config changed after order was placed)
- **Memory adapter fix** — `saveOrder` now stores `sessionKey` on the order so `getOrderByAddress` can return a complete object

### 1.1.1
- **Optional storage hooks** — `getOrderByAddress`, `getOrderByTxid`, `findRecyclableAddress` for address-based webhook lookup, replay prevention, and address recycling

### 1.1.0
- **Storage hooks** — plug in any database via `getOrder` / `saveOrder` / `updateOrder` config options
- **Grace period** — `gracePeriodMinutes` keeps the server accepting payments after the browser timer expires
- **Address reuse fix** — `reuseAddress: true` now correctly returns the existing address across restarts when storage hooks are provided
- **In-memory TTL cleanup** — default store auto-removes orders older than 24 hours

### 1.0.0
- Initial release

---

## License

MIT
