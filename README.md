# forgelayer-node

> Node.js / Express middleware for accepting crypto payments via [ForgeLayer](https://forgelayer.io).

Drop `createCheckout()` into any Express app and get crypto payment endpoints in seconds — address generation, real-time rate conversion, payment polling, and webhook verification all included.

---

## Install

```bash
npm install forgelayer-node
```

---

## Quick Start

```js
const express = require('express');
const { createCheckout } = require('forgelayer-node');

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
  paymentWindowMinutes: 30,
  reuseAddress:         false,

  // Webhooks (optional — set via setupWebhook() instead)
  webhookSecret: process.env.FORGELAYER_WEBHOOK_SECRET,

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
  "paymentWindow": 30
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

## Usage with forgelayer-react

If you're using React on the frontend, pair this with [`forgelayer-react`](https://github.com/forgelayer-tech/forgelayer-react):

```js
// Backend — forgelayer-node
app.use('/fl', checkout.middleware());
```

```jsx
// Frontend — forgelayer-react
import { ForgeLayerButton } from 'forgelayer-react';

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

## License

MIT
