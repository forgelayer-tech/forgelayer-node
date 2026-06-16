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
 *   const { createCheckout } = require('forgelayer-node');
 *   const checkout = createCheckout({ apiKey: 'flk_live_...' });
 *   app.use('/fl', checkout.middleware());
 *
 * STORAGE HOOKS (recommended for production):
 *   createCheckout({
 *     apiKey: '...',
 *     async getOrder(sessionKey)           { return await db.orders.findOne({ sessionKey }); },
 *     async saveOrder(sessionKey, order)   { await db.orders.insertOne({ sessionKey, ...order }); },
 *     async updateOrder(sessionKey, patch) { await db.orders.updateOne({ sessionKey }, patch); },
 *   });
 *
 *   Without these hooks the plugin uses an in-memory store (fine for dev/testing,
 *   orders are lost on restart).
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

const FL_API_BASE = 'https://api.forgelayer.io/v1';
const CG_API_BASE = 'https://api.coingecko.com/api/v3';
const SDK_VERSION = '1.1.1';

// Stablecoins pegged 1:1 to USD — skip CoinGecko for these
const USD_STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'GUSD', 'FRAX', 'LUSD', 'USDD',
]);

// Token symbol → CoinGecko coin ID
const CG_MAP = {
  ETH:   'ethereum',       BNB:   'binancecoin',      BTC:   'bitcoin',
  TRX:   'tron',
  USDT:  'tether',         USDC:  'usd-coin',         BUSD:  'binance-usd',
  DAI:   'dai',            TUSD:  'true-usd',         USDP:  'pax-dollar',
  FRAX:  'frax',           LUSD:  'liquity-usd',      GUSD:  'gemini-dollar',
  USDD:  'usdd',
  WBTC:  'wrapped-bitcoin', WETH: 'weth',             WBNB:  'wbnb',
  LINK:  'chainlink',      UNI:   'uniswap',          AAVE:  'aave',
  COMP:  'compound-governance-token', MKR: 'maker',   SNX:   'havven',
  YFI:   'yearn-finance',  SUSHI: 'sushi',            CRV:   'curve-dao-token',
  BAL:   'balancer',       LDO:   'lido-dao',
  MATIC: 'matic-network',  ARB:   'arbitrum',         OP:    'optimism',
  GRT:   'the-graph',
  SHIB:  'shiba-inu',      PEPE:  'pepe',             FLOKI: 'floki',
  DOGE:  'dogecoin',
  SAND:  'the-sandbox',    MANA:  'decentraland',     AXS:   'axie-infinity',
  APE:   'apecoin',        IMX:   'immutable-x',      GALA:  'gala',
  CAKE:  'pancakeswap-token', XVS: 'venus',
  BTT:   'bittorrent',     WIN:   'wink',             JST:   'just',
  SUN:   'sun-token',
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

// ── In-memory rate cache (process-wide, shared across all requests) ───────────
const rateCache = new Map();

// ── Default in-memory order store ─────────────────────────────────────────────
// Used when the developer does not supply getOrder/saveOrder/updateOrder hooks.
// Auto-cleans orders older than 24 hours to prevent memory leaks.
function createMemoryAdapter() {
  const store = new Map();

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, order] of store) {
      if ((order._savedAt || 0) < cutoff) store.delete(key);
    }
  }, 60 * 60 * 1000); // run every hour
  if (cleanupTimer.unref) cleanupTimer.unref();

  return {
    async getOrder(key)           { return store.get(key) || null; },
    async saveOrder(key, order)   { store.set(key, { ...order, _savedAt: Date.now() }); },
    async updateOrder(key, patch) {
      const existing = store.get(key);
      if (existing) store.set(key, { ...existing, ...patch, _savedAt: existing._savedAt });
    },
  };
}

// ── ForgeLayer API ────────────────────────────────────────────────────────────

async function flRequest(method, urlPath, apiKey, body, query) {
  let url = FL_API_BASE + urlPath;
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
  const res  = await fetchFn(url, init);
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

// ── CoinGecko rates ───────────────────────────────────────────────────────────

async function fetchAllRates(currency) {
  const cur    = currency.toLowerCase();
  const allIds = [...new Set(Object.values(CG_MAP))].join(',');
  const res    = await fetchFn(
    `${CG_API_BASE}/simple/price?ids=${allIds}&vs_currencies=${cur}`,
    { headers: { 'Accept': 'application/json' } }
  );

  if (res.status === 429) {
    console.warn('[ForgeLayer] CoinGecko rate limit (429) — keeping existing cache.');
    return;
  }
  if (!res.ok) {
    console.warn('[ForgeLayer] CoinGecko error ' + res.status + ' — keeping existing cache.');
    return;
  }

  const json = await res.json();
  if (json.status?.error_code) {
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

async function getCoinGeckoRate(token, currency) {
  const sym = token.toUpperCase();
  const cur = currency.toLowerCase();

  if (cur === 'usd' && USD_STABLECOINS.has(sym)) return 1.0;

  const coinId = CG_MAP[sym];
  if (!coinId) {
    throw new Error('No CoinGecko mapping for token: ' + token + '. Supported: ' + Object.keys(CG_MAP).join(', '));
  }

  const cached = rateCache.get('batch_' + cur);
  if (cached && Object.keys(cached.rates).length > 0) {
    const rate = parseFloat(cached.rates[coinId] ?? 0);
    if (rate > 0) return rate;
  }

  // First call before background timer has fired — fetch once now
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
  if (!config || !config.apiKey) throw new Error('ForgeLayer: apiKey is required.');

  const apiKey              = String(config.apiKey).trim();
  let   webhookSecret       = String(
    config.webhookSecret || process.env.FORGELAYER_WEBHOOK_SECRET || loadSavedWebhookSecret() || ''
  ).trim();
  const defaultCurrency     = (config.currency             || 'USD').toUpperCase();
  const defaultChain        = config.defaultChain          || 'ethereum';
  const defaultToken        = (config.defaultToken         || 'USDT').toUpperCase();
  const defaultWindow       = Math.max(1, +(config.paymentWindowMinutes || 30));
  const defaultReuse        = !!config.reuseAddress;
  const gracePeriodSeconds  = Math.max(0, +(config.gracePeriodMinutes || 0)) * 60;
  const onConfirmed         = config.onConfirmed    || null;
  const onWebhookEvent      = config.onWebhookEvent || null;

  // ── Storage adapter ─────────────────────────────────────────────────────────
  // Use developer-supplied hooks if provided, otherwise fall back to in-memory.
  const storage = (config.getOrder && config.saveOrder && config.updateOrder)
    ? {
        getOrder:    config.getOrder.bind(config),
        saveOrder:   config.saveOrder.bind(config),
        updateOrder: config.updateOrder.bind(config),
      }
    : createMemoryAdapter();

  if (!config.getOrder) {
    console.warn(
      '[ForgeLayer] No storage hooks provided — using in-memory store. ' +
      'Orders will be lost on restart. Pass getOrder/saveOrder/updateOrder for production.'
    );
  }

  // ── Background rate refresh ─────────────────────────────────────────────────
  const _cur = defaultCurrency.toLowerCase();
  fetchAllRates(_cur).catch(e => console.warn('[ForgeLayer] Initial rate fetch failed:', e.message));
  const _rateTimer = setInterval(
    () => fetchAllRates(_cur).catch(e => console.warn('[ForgeLayer] Rate refresh failed:', e.message)),
    60_000
  );
  if (_rateTimer.unref) _rateTimer.unref();

  // Read browser.js once at startup
  const browserJsRaw = fs.readFileSync(path.join(__dirname, 'browser.js'), 'utf8');

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function toSessionKey(orderId) {
    // SHA-256 so ORDER-1 and ORDER_1 don't collapse to the same key
    return 'fl_' + crypto.createHash('sha256').update(String(orderId)).digest('hex').slice(0, 32);
  }

  async function markConfirmed(sessionKey, order) {
    await storage.updateOrder(sessionKey, { status: 'confirmed' });
    if (onConfirmed) {
      onConfirmed(order.orderId, { ...order, status: 'confirmed' })
        .catch(e => console.error('[ForgeLayer] onConfirmed error:', e));
    }
  }

  // ── POST /create ─────────────────────────────────────────────────────────────

  async function handleCreate(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' });

    let body = req.body;
    if (!body || typeof body !== 'object') {
      try { body = JSON.parse(await readBody(req) || '{}'); } catch (_) { body = {}; }
    }

    const amount   = parseFloat(body.amount || 0);
    const currency = (body.currency || defaultCurrency).toUpperCase();
    const chain    = (body.chain    || defaultChain).toLowerCase();
    const token    = (body.token    || defaultToken).toUpperCase();
    const orderId  = body.orderId   || ('fl_' + Date.now() + '_' + Math.random().toString(36).slice(2));
    const reuse    = body.reuseAddress !== undefined ? !!body.reuseAddress : defaultReuse;
    const window_  = Math.max(1, +(body.paymentWindow || defaultWindow));

    if (amount <= 0)        return res.status(400).json({ ok: false, error: 'Amount must be > 0.' });
    if (!CHAIN_NAMES[chain]) return res.status(400).json({ ok: false, error: 'Unsupported chain: ' + chain });

    const sessionKey = toSessionKey(orderId);

    // ── Address reuse ─────────────────────────────────────────────────────────
    // If reuseAddress is true and an active order already exists for this orderId,
    // return the existing address instead of generating a new one.
    if (reuse) {
      const existing = await storage.getOrder(sessionKey);
      if (existing && existing.status === 'pending') {
        const now = Math.floor(Date.now() / 1000);
        if (now < existing.expiresAt) {
          return res.json({
            ok: true, reused: true,
            address:     existing.address,
            chain:       existing.chain,
            chainName:   CHAIN_NAMES[existing.chain] || existing.chain,
            token:       existing.token,
            amount:      existing.amount,
            currency:    existing.currency,
            cryptoAmount: existing.cryptoAmount,
            expiresAt:   existing.expiresAt,
            orderId:     existing.orderId,
            qrUrl:       'https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=2&data=' + encodeURIComponent(existing.address),
            sessionKey,
          });
        }
      }
    }

    // ── Generate new address ──────────────────────────────────────────────────
    let address;
    try { address = await generateAddress(apiKey, chain, orderId); }
    catch (e) { return res.status(500).json({ ok: false, error: 'Address generation failed: ' + e.message }); }

    let cryptoAmount = null;
    try {
      const rate = await getCoinGeckoRate(token, currency);
      if (rate > 0) cryptoAmount = (amount / rate).toFixed(8).replace(/\.?0+$/, '');
    } catch (_) { /* show fiat amount only */ }

    const expiresAt = Math.floor(Date.now() / 1000) + window_ * 60;
    const order = { orderId, address, chain, token, amount, currency, cryptoAmount, expiresAt, status: 'pending' };

    await storage.saveOrder(sessionKey, order);

    return res.json({
      ok: true,
      address, chain,
      chainName:    CHAIN_NAMES[chain] || chain,
      token, amount, currency, cryptoAmount,
      expiresAt, orderId, sessionKey,
      qrUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=2&data=' + encodeURIComponent(address),
    });
  }

  // ── GET /status ───────────────────────────────────────────────────────────────

  async function handleStatus(req, res) {
    const qs         = new URLSearchParams((req.url || '').split('?')[1] || '');
    const sessionKey = req.query?.session || qs.get('session') || '';
    const orderIdQ   = req.query?.orderId || qs.get('orderId') || '';
    const key        = sessionKey || toSessionKey(orderIdQ);

    const order = await storage.getOrder(key);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found.' });

    // Already confirmed
    if (order.status === 'confirmed') return res.json({ ok: true, status: 'confirmed' });

    const now          = Math.floor(Date.now() / 1000);
    const graceEndsAt  = order.expiresAt + gracePeriodSeconds;

    // Past grace period entirely — hard expired, no more checks
    if (now >= graceEndsAt) {
      await storage.updateOrder(key, { status: 'expired' });
      return res.json({ ok: true, status: 'expired' });
    }

    // Check balance — works both within and outside the payment window
    try {
      const balance  = await getBalance(apiKey, order.address, order.chain);
      const expected = parseFloat(order.cryptoAmount || 0);
      if (expected > 0 && balance >= expected * 0.99) {
        await markConfirmed(key, order);
        return res.json({ ok: true, status: 'confirmed' });
      }
    } catch (_) { /* best-effort */ }

    // Payment window closed — tell the browser "expired" so it stops showing the UI,
    // but we keep accepting via webhook until the grace period ends.
    if (now >= order.expiresAt) {
      return res.json({ ok: true, status: 'expired' });
    }

    return res.json({ ok: true, status: 'pending' });
  }

  // ── GET /checkout.js ──────────────────────────────────────────────────────────

  function serveBrowserScript(req, res, basePath) {
    const config_js = 'var FL_CONFIG={"createUrl":"' + basePath + '/create","statusUrl":"' + basePath + '/status"};';
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(config_js + '\n' + browserJsRaw);
  }

  // ── POST /webhook ─────────────────────────────────────────────────────────────

  async function handleWebhook(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required.' });

    const rawBody = await readBody(req);
    const sig     = req.headers['x-fl-signature'] || '';

    if (!webhookSecret) {
      console.error('[ForgeLayer] Webhook received but no webhookSecret configured. Call setupWebhook() first.');
      return res.status(500).json({ ok: false, error: 'Webhook secret not configured.' });
    }

    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    // timingSafeEqual throws if buffer lengths differ, so check length first
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return res.status(401).json({ ok: false, error: 'Invalid signature.' });
    }

    let event;
    try { event = JSON.parse(rawBody); }
    catch (_) { return res.status(400).json({ ok: false, error: 'Invalid JSON body.' }); }

    if (event.event === 'deposit_confirmed') {
      const orderId    = event.data?.orderId || event.data?.label || '';
      const sessionKey = toSessionKey(orderId);
      const order      = await storage.getOrder(sessionKey);

      if (order && order.status !== 'confirmed') {
        const now         = Math.floor(Date.now() / 1000);
        const graceEndsAt = order.expiresAt + gracePeriodSeconds;

        // Accept payment if within the payment window OR within the grace period
        if (now < graceEndsAt) {
          await markConfirmed(sessionKey, order);
        } else {
          console.warn('[ForgeLayer] Late payment received for order ' + orderId + ' but grace period has ended.');
        }
      }
    }

    if (onWebhookEvent) {
      onWebhookEvent(event.event, event.data)
        .catch(e => console.error('[ForgeLayer] onWebhookEvent error:', e));
    }

    return res.status(200).json({ ok: true });
  }

  // ── Webhook registration ──────────────────────────────────────────────────────

  async function setupWebhook(webhookUrl, confirmations) {
    if (!webhookUrl || typeof webhookUrl !== 'string') throw new Error('setupWebhook: webhookUrl is required.');
    confirmations = Math.max(1, +(confirmations || 1));

    const newSecret = crypto.randomBytes(32).toString('hex');

    const oldId = loadSavedWebhookId();
    if (oldId) {
      try { await flRequest('DELETE', '/webhooks/' + encodeURIComponent(oldId), apiKey); }
      catch (_) {}
    }

    const data = await flRequest('POST', '/webhooks', apiKey, {
      url: webhookUrl, secret: newSecret, events: ['deposit_confirmed'], confirmations,
    });

    const webhookId = (data.webhook && data.webhook.id) || (data.webhooks && data.webhooks[0] && data.webhooks[0].id) || data.id || '';
    saveWebhookSecret(newSecret);
    if (webhookId) saveWebhookId(webhookId);
    webhookSecret = newSecret;

    return { webhookId, webhookUrl, confirmations };
  }

  // ── Express middleware ────────────────────────────────────────────────────────

  function middleware() {
    return function forgeLayerMiddleware(req, res, next) {
      const mountPath = req.baseUrl || '';
      const urlPath   = (req.path || '/').replace(/\/$/, '') || '/';

      if (urlPath === '/checkout.js' && req.method === 'GET') return serveBrowserScript(req, res, mountPath);
      if (urlPath === '/create'      && req.method === 'POST') return handleCreate(req, res).catch(next);
      if (urlPath === '/status'      && req.method === 'GET')  return handleStatus(req, res).catch(next);
      if (urlPath === '/webhook'     && req.method === 'POST') return handleWebhook(req, res).catch(next);
      return next();
    };
  }

  return { middleware, setupWebhook, handleCreate, handleStatus, handleWebhook, serveBrowserScript };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(function (resolve, reject) {
    if (req.body !== undefined) {
      const raw = typeof req.body === 'string'
        ? req.body
        : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
      return resolve(raw);
    }
    const chunks = [];
    req.on('data',  chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ── Webhook secret/ID persistence ─────────────────────────────────────────────

// Use process.cwd() so the file lands in the developer's project root,
// not inside node_modules/forgelayer-node/ where it gets wiped on reinstall.
const SECRET_FILE = path.join(process.cwd(), '.fl_webhook_secret');
const ID_FILE     = path.join(process.cwd(), '.fl_webhook_id');

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
