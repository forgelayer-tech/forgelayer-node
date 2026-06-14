'use strict';

/**
 * ForgeLayer Checkout — Node.js middleware
 *
 * Mounts on an Express sub-path and provides:
 *   GET  <base>/checkout.js  → browser script (auto-configured with endpoint URLs)
 *   POST <base>/create       → generate ForgeLayer deposit address
 *   GET  <base>/status       → poll payment status
 *   POST <base>/webhook      → receive ForgeLayer deposit_confirmed events
 *
 * USAGE (Express):
 *   const { createCheckout } = require('forgelayer-checkout');
 *   const checkout = createCheckout({ apiKey: 'flk_live_...' });
 *   app.use('/fl', checkout.middleware());
 *
 *   // One-time setup (run once from a setup script, not on every request):
 *   await checkout.setupWebhook('https://mysite.com/fl/webhook');
 *
 * Then in HTML:
 *   <script src="/fl/checkout.js"></script>
 *   <button class="fl-checkout-btn"
 *           data-fl-amount="49.99" data-fl-currency="USD"
 *           data-fl-chain="ethereum" data-fl-token="USDT"
 *           data-fl-order-id="order_123">Pay with Crypto</button>
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Use built-in fetch (Node 18+) or fall back to node-fetch v2
let fetchFn;
try {
  fetchFn = global.fetch || require('node-fetch');
} catch (_) {
  fetchFn = global.fetch;
}

const FL_API_BASE   = 'https://api.forgelayer.io/v1';
const CG_API_BASE   = 'https://api.coingecko.com/api/v3';
const SDK_VERSION   = '1.0.0';

// Stablecoins pegged 1:1 to USD — skip CoinGecko for these
const USD_STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'GUSD', 'FRAX', 'LUSD', 'USDD',
]);

// Token symbol → CoinGecko coin ID (mirrors forgelayer-shopify/lib/coingecko.js)
const CG_MAP = {
  // Native coins
  ETH:   'ethereum',       BNB:   'binancecoin',      BTC:   'bitcoin',
  TRX:   'tron',
  // Stablecoins
  USDT:  'tether',         USDC:  'usd-coin',         BUSD:  'binance-usd',
  DAI:   'dai',            TUSD:  'true-usd',         USDP:  'pax-dollar',
  FRAX:  'frax',           LUSD:  'liquity-usd',      GUSD:  'gemini-dollar',
  USDD:  'usdd',
  // Wrapped
  WBTC:  'wrapped-bitcoin', WETH: 'weth',             WBNB:  'wbnb',
  // DeFi
  LINK:  'chainlink',      UNI:   'uniswap',          AAVE:  'aave',
  COMP:  'compound-governance-token', MKR: 'maker',   SNX:   'havven',
  YFI:   'yearn-finance',  SUSHI: 'sushi',            CRV:   'curve-dao-token',
  BAL:   'balancer',       LDO:   'lido-dao',
  // L2 / Infra
  MATIC: 'matic-network',  ARB:   'arbitrum',         OP:    'optimism',
  GRT:   'the-graph',
  // Meme
  SHIB:  'shiba-inu',      PEPE:  'pepe',             FLOKI: 'floki',
  DOGE:  'dogecoin',
  // Gaming
  SAND:  'the-sandbox',    MANA:  'decentraland',     AXS:   'axie-infinity',
  APE:   'apecoin',        IMX:   'immutable-x',      GALA:  'gala',
  // BSC
  CAKE:  'pancakeswap-token', XVS: 'venus',
  // Tron
  BTT:   'bittorrent',     WIN:   'wink',             JST:   'just',
  SUN:   'sun-token',
  // Other
  CRO:   'crypto-com-chain', BAT: 'basic-attention-token', ZRX: '0x',
  ENS:   'ethereum-name-service', CHZ: 'chiliz',      FTM:   'fantom',
  GMT:   'stepn',
};

const CHAIN_NAMES = {
  ethereum: 'Ethereum',
  bsc:      'BNB Smart Chain',
  tron:     'Tron',
  bitcoin:  'Bitcoin',
};

// In-memory order store — replace with a real DB for production
const orderStore = new Map();

// In-memory rate cache: "batch_{currency}" → { rates: { coinId: price }, at: ms }
//
// Because Node.js is single-process, this Map is shared across ALL concurrent
// requests — so the first request in any 60-second window fetches from CoinGecko
// and every subsequent request reads from memory. No file or Redis needed.
//
// Layout example:
//   "batch_usd" → {
//     at: 1718300000000,           // Date.now() when fetched
//     rates: {
//       "ethereum": 1678.39,
//       "bitcoin":  64000,
//       "tether":   0.9995,
//       ...all ~60 coins...
//     }
//   }
const rateCache  = new Map();

// ── ForgeLayer API calls ────────────────────────────────────────────────────

async function flRequest(method, path, apiKey, body, query) {
  let url = FL_API_BASE + path;
  if (query && Object.keys(query).length) {
    url += '?' + new URLSearchParams(query).toString();
  }
  const init = {
    method,
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'User-Agent':    'ForgeLayer-JS-Plugin/' + SDK_VERSION + ' Node/' + process.version,
    },
  };
  if (body && method !== 'GET') init.body = JSON.stringify(body);
  const res = await fetchFn(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) {
    throw new Error('Invalid JSON from ForgeLayer (HTTP ' + res.status + ')');
  }
  if (json && json.success === false) {
    throw new Error(json.error?.message || json.message || 'ForgeLayer API error');
  }
  return json.data ?? json;
}

async function generateAddress(apiKey, chain, label) {
  const data = await flRequest('POST', '/addresses', apiKey, { chain, label });
  if (!data.address) throw new Error('No address in ForgeLayer response.');
  return data.address;
}

async function getBalance(apiKey, address, chain) {
  const data = await flRequest('GET', '/addresses/' + encodeURIComponent(address) + '/balance', apiKey, null, { chain });
  return parseFloat(data.balance ?? 0);
}

// ── CoinGecko rate ───────────────────────────────────────────────────────────

// Fetch all ~60 coin prices for a given currency in one CoinGecko request and
// write the result into rateCache. Called by the background timer and, as a
// one-shot fallback, by getCoinGeckoRate if the cache is completely empty.
async function fetchAllRates(currency) {
  const cur    = currency.toLowerCase();
  const allIds = [...new Set(Object.values(CG_MAP))].join(',');
  const url    = `${CG_API_BASE}/simple/price?ids=${allIds}&vs_currencies=${cur}`;

  const res = await fetchFn(url, { headers: { 'Accept': 'application/json' } });

  if (res.status === 429) {
    console.warn('[ForgeLayer] CoinGecko rate limit (429) — keeping existing cache.');
    return; // keep whatever is already cached
  }
  if (!res.ok) {
    console.warn('[ForgeLayer] CoinGecko error ' + res.status + ' — keeping existing cache.');
    return;
  }

  const json = await res.json();
  // CoinGecko sometimes returns {"status": {"error_code": ...}} on errors
  if (json.status && json.status.error_code) {
    console.warn('[ForgeLayer] CoinGecko API error:', json.status.error_message);
    return;
  }

  const rates = {};
  for (const [id, prices] of Object.entries(json)) {
    if (prices[cur] != null) rates[id] = parseFloat(prices[cur]);
  }

  if (Object.keys(rates).length > 0) {
    rateCache.set('batch_' + cur, { rates, at: Date.now() });
  }
}

// Read the cached rate for a token/currency pair.
// Falls back to a one-shot fetch ONLY on the very first call before the
// background timer has had a chance to populate the cache.
async function getCoinGeckoRate(token, currency) {
  const sym = token.toUpperCase();
  const cur = currency.toLowerCase();

  // Stablecoins are always ≈ 1 USD — never hit CoinGecko
  if (cur === 'usd' && USD_STABLECOINS.has(sym)) return 1.0;

  const coinId = CG_MAP[sym];
  if (!coinId) {
    throw new Error(
      'No CoinGecko mapping for token: ' + token +
      '. Supported: ' + Object.keys(CG_MAP).join(', ')
    );
  }

  const cached = rateCache.get('batch_' + cur);

  // Cache is populated and fresh — use it (normal path after background timer runs)
  if (cached && Object.keys(cached.rates).length > 0) {
    const rate = parseFloat(cached.rates[coinId] ?? 0);
    if (rate > 0) return rate;
  }

  // Cache is empty (process just started, timer hasn't fired yet) — fetch once now
  await fetchAllRates(cur);

  const refreshed = rateCache.get('batch_' + cur);
  const rate = parseFloat(refreshed?.rates[coinId] ?? 0);
  if (rate <= 0) {
    throw new Error('No rate available for ' + sym + '/' + currency.toUpperCase() + ' — CoinGecko may be unavailable.');
  }
  return rate;
}

// ── Middleware factory ────────────────────────────────────────────────────────

function createCheckout(config) {
  if (!config || !config.apiKey) {
    throw new Error('ForgeLayer: apiKey is required.');
  }

  const apiKey               = String(config.apiKey).trim();
  // Webhook secret: from config, or env var, or the saved secret file
  let   webhookSecret        = String(
    config.webhookSecret || process.env.FORGELAYER_WEBHOOK_SECRET || loadSavedWebhookSecret() || ''
  ).trim();
  const defaultCurrency      = (config.currency             || 'USD').toUpperCase();
  const defaultChain         = config.defaultChain          || 'ethereum';
  const defaultToken         = (config.defaultToken         || 'USDT').toUpperCase();
  const defaultPaymentWindow = Math.max(1, +(config.paymentWindowMinutes || 30));
  const defaultReuseAddress  = !!config.reuseAddress;
  const onConfirmed          = config.onConfirmed           || null; // async (orderId, data) => {}
  const onWebhookEvent       = config.onWebhookEvent        || null; // async (event, data) => {}

  // ── Background rate refresh ─────────────────────────────────────────────────
  // Fetch CoinGecko prices immediately on startup, then every 60 seconds.
  // This keeps the cache warm so checkout button clicks never wait on a network call.
  const _refreshCurrency = defaultCurrency.toLowerCase();
  fetchAllRates(_refreshCurrency).catch(e =>
    console.warn('[ForgeLayer] Initial rate fetch failed:', e.message)
  );
  const _rateTimer = setInterval(
    () => fetchAllRates(_refreshCurrency).catch(e =>
      console.warn('[ForgeLayer] Rate refresh failed:', e.message)
    ),
    60_000
  );
  // Don't block process exit — the interval is fire-and-forget
  if (_rateTimer.unref) _rateTimer.unref();

  // Read browser.js once at startup
  const browserJsPath = path.join(__dirname, 'browser.js');
  const browserJsRaw  = fs.readFileSync(browserJsPath, 'utf8');

  // ── Route handlers ──────────────────────────────────────────────────────────

  async function handleCreate(req, res, basePath) {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'POST required.' });
    }

    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw || '{}');
      } catch (_) {
        body = {};
      }
    }

    const amount     = parseFloat(body.amount || 0);
    const currency   = ((body.currency   || defaultCurrency)).toUpperCase();
    const chain      = (body.chain       || defaultChain).toLowerCase();
    const token      = ((body.token      || defaultToken)).toUpperCase();
    const orderId    = body.orderId      || ('fl_' + Date.now() + '_' + Math.random().toString(36).slice(2));
    const reuse      = body.reuseAddress !== undefined ? !!body.reuseAddress : defaultReuseAddress;
    const window_    = Math.max(1, +(body.paymentWindow || defaultPaymentWindow));

    if (amount <= 0)                        return res.status(400).json({ ok: false, error: 'Amount must be > 0.' });
    if (!CHAIN_NAMES[chain])                return res.status(400).json({ ok: false, error: 'Unsupported chain: ' + chain });

    let address;
    try { address = await generateAddress(apiKey, chain, orderId); }
    catch (e) { return res.status(500).json({ ok: false, error: 'Address generation failed: ' + e.message }); }

    let cryptoAmount = null;
    try {
      const rate = await getCoinGeckoRate(token, currency);
      if (rate > 0) cryptoAmount = (amount / rate).toFixed(8).replace(/\.?0+$/, '');
    } catch (_) { /* show fiat only */ }

    const expiresAt  = Math.floor(Date.now() / 1000) + window_ * 60;
    const sessionKey = 'fl_' + orderId.replace(/[^a-z0-9]/gi, '');
    const qrUrl      = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=2&data=' + encodeURIComponent(address);

    // Save order
    orderStore.set(sessionKey, {
      orderId, address, chain, token, amount, currency,
      cryptoAmount, expiresAt, status: 'pending',
    });

    return res.json({
      ok: true,
      address, chain,
      chainName:    CHAIN_NAMES[chain] || chain,
      token, amount, currency, cryptoAmount,
      expiresAt, orderId, qrUrl, sessionKey,
    });
  }

  async function handleStatus(req, res) {
    const orderId    = req.query?.orderId    || (new URLSearchParams(req.url.split('?')[1] || '')).get('orderId')    || '';
    const sessionKey = req.query?.session    || (new URLSearchParams(req.url.split('?')[1] || '')).get('session')    || '';

    const key = sessionKey || ('fl_' + orderId.replace(/[^a-z0-9]/gi, ''));
    const order = orderStore.get(key);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

    if (order.status === 'confirmed') return res.json({ ok: true, status: 'confirmed' });

    // Server-authoritative expiry
    if (Math.floor(Date.now() / 1000) >= order.expiresAt) {
      order.status = 'expired';
      return res.json({ ok: true, status: 'expired' });
    }

    // Check balance
    try {
      const balance  = await getBalance(apiKey, order.address, order.chain);
      const expected = parseFloat(order.cryptoAmount || 0);
      if (expected > 0 && balance >= expected * 0.99) {
        order.status = 'confirmed';
        if (onConfirmed) {
          onConfirmed(order.orderId, order).catch(e => console.error('[ForgeLayer] onConfirmed error:', e));
        }
        return res.json({ ok: true, status: 'confirmed' });
      }
    } catch (_) { /* best-effort */ }

    return res.json({ ok: true, status: 'pending' });
  }

  function serveBrowserScript(req, res, basePath) {
    const createUrl = basePath + '/create';
    const statusUrl  = basePath + '/status';
    const config_js  = 'var FL_CONFIG={"createUrl":"' + createUrl + '","statusUrl":"' + statusUrl + '"};';
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(config_js + '\n' + browserJsRaw);
  }

  // ── Webhook setup ───────────────────────────────────────────────────────────

  async function setupWebhook(webhookUrl, confirmations) {
    if (!webhookUrl || typeof webhookUrl !== 'string') {
      throw new Error('setupWebhook: webhookUrl is required.');
    }
    confirmations = Math.max(1, +(confirmations || 1));

    // Generate a fresh secret
    const newSecret = crypto.randomBytes(32).toString('hex');

    // Delete the old webhook if we have its ID on file
    const oldId = loadSavedWebhookId();
    if (oldId) {
      try {
        await flRequest('DELETE', '/webhooks/' + encodeURIComponent(oldId), apiKey);
      } catch (_) { /* best-effort — old webhook may already be gone */ }
    }

    // Register with ForgeLayer
    const data = await flRequest('POST', '/webhooks', apiKey, {
      url:           webhookUrl,
      secret:        newSecret,
      events:        ['deposit_confirmed'],
      confirmations,
    });

    const webhookId = data.id || data.webhookId || '';

    // Persist for next restart
    saveWebhookSecret(newSecret);
    if (webhookId) saveWebhookId(webhookId);

    // Update the live secret so the running process verifies correctly immediately
    webhookSecret = newSecret;

    return { webhookId, webhookUrl, confirmations };
  }

  // ── Webhook handler ─────────────────────────────────────────────────────────

  async function handleWebhook(req, res) {
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'POST required.' });
    }

    const rawBody = await readBody(req);
    const sig     = req.headers['x-fl-signature'] || '';

    if (!webhookSecret) {
      console.error('[ForgeLayer] Webhook received but no webhookSecret is configured. Call setupWebhook() first.');
      return res.status(500).json({ ok: false, error: 'Webhook secret not configured.' });
    }

    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return res.status(401).json({ ok: false, error: 'Invalid signature.' });
    }

    let event;
    try { event = JSON.parse(rawBody); } catch (_) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
    }

    if (event.event === 'deposit_confirmed') {
      const orderId    = event.data?.orderId || event.data?.label || '';
      const sessionKey = 'fl_' + orderId.replace(/[^a-z0-9]/gi, '');
      const order      = orderStore.get(sessionKey);
      if (order) {
        order.status = 'confirmed';
        if (onConfirmed) {
          onConfirmed(orderId, order).catch(e => console.error('[ForgeLayer] onConfirmed error:', e));
        }
      }
    }

    if (onWebhookEvent) {
      onWebhookEvent(event.event, event.data).catch(e => console.error('[ForgeLayer] onWebhookEvent error:', e));
    }

    return res.status(200).json({ ok: true });
  }

  // ── Express middleware ──────────────────────────────────────────────────────

  function middleware() {
    return function forgeLayerMiddleware(req, res, next) {
      // Determine the path relative to where this middleware is mounted
      const mountPath = req.baseUrl || '';
      const urlPath   = (req.path || '/').replace(/\/$/, '') || '/';

      if (urlPath === '/checkout.js' && req.method === 'GET') {
        return serveBrowserScript(req, res, mountPath);
      }
      if (urlPath === '/create' && req.method === 'POST') {
        return handleCreate(req, res, mountPath).catch(next);
      }
      if (urlPath === '/status' && req.method === 'GET') {
        return handleStatus(req, res).catch(next);
      }
      if (urlPath === '/webhook' && req.method === 'POST') {
        return handleWebhook(req, res).catch(next);
      }
      return next();
    };
  }

  return { middleware, setupWebhook, handleCreate, handleStatus, handleWebhook, serveBrowserScript };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(function (resolve, reject) {
    // If Express (or body-parser) already consumed the body, return it as a raw Buffer
    if (req.body !== undefined) {
      const raw = typeof req.body === 'string'
        ? req.body
        : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
      return resolve(raw);
    }
    const chunks = [];
    req.on('data', function (chunk) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    req.on('end',  function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// ── Webhook secret/ID file persistence ───────────────────────────────────────

const SECRET_FILE = path.join(__dirname, '..', '.fl_webhook_secret');
const ID_FILE     = path.join(__dirname, '..', '.fl_webhook_id');

function loadSavedWebhookSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function saveWebhookSecret(secret) {
  fs.writeFileSync(SECRET_FILE, secret, { encoding: 'utf8', mode: 0o600 });
}

function loadSavedWebhookId() {
  try { return fs.readFileSync(ID_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function saveWebhookId(id) {
  fs.writeFileSync(ID_FILE, id, 'utf8');
}

module.exports = { createCheckout };
