/**
 * ForgeLayer Checkout — browser script
 *
 * Served automatically by the Node.js middleware at GET /fl/checkout.js
 * (or include manually from your own CDN / static host).
 *
 * Usage (data-attribute, zero JS needed):
 *   <button class="fl-checkout-btn"
 *           data-fl-amount="49.99"
 *           data-fl-currency="USD"
 *           data-fl-chain="ethereum"
 *           data-fl-token="USDT"
 *           data-fl-order-id="order_123">
 *     Pay with Crypto
 *   </button>
 *
 * Usage (programmatic):
 *   ForgeLayerCheckout.mount('#my-btn', {
 *     amount: 49.99, currency: 'USD', chain: 'ethereum', token: 'USDT',
 *     orderId: 'order_123',
 *     onSuccess: function(data) { window.location = '/thank-you'; },
 *   });
 *
 * The server injects FL_CONFIG (createUrl, statusUrl) before this script runs.
 */

/* global FL_CONFIG */
(function (global) {
  'use strict';

  // Endpoints injected by the server middleware (e.g. /fl/create, /fl/status)
  var cfg = (typeof FL_CONFIG !== 'undefined' && FL_CONFIG) || {};
  var DEFAULT_CREATE_URL = cfg.createUrl  || '/fl/create';
  var DEFAULT_STATUS_URL = cfg.statusUrl  || '/fl/status';

  // ── Modal singleton ───────────────────────────────────────────────────────
  var backdrop = null;
  var pollTmr  = null;
  var cdTmr    = null;
  var activeOrder = null;
  var userCallbacks = {};

  var MODAL_HTML = [
    '<div class="fl-modal" id="fl-modal" role="dialog" aria-modal="true" aria-labelledby="fl-modal-title">',
    '<div class="fl-mhd">',
    '  <div class="fl-mtitle" id="fl-modal-title"><div class="fl-logo">FL</div>Pay with Crypto</div>',
    '  <button class="fl-xbtn" id="fl-xbtn" aria-label="Close">&times;</button>',
    '</div>',
    '<div class="fl-mbody">',
    /* loading */
    '  <div id="fl-loading"><div class="fl-spinner"></div><p class="fl-spin-lbl">Generating payment address…</p></div>',
    /* payment */
    '  <div id="fl-pay" style="display:none">',
    '    <div class="fl-sbar">',
    '      <span class="fl-sdot pending" id="fl-sdot"></span>',
    '      <span id="fl-stxt">Awaiting payment…</span>',
    '      <span class="fl-timer" id="fl-timer">--:--</span>',
    '    </div>',
    '    <div class="fl-warn" id="fl-warn"></div>',
    '    <div class="fl-grid">',
    '      <div class="fl-qrside">',
    '        <img class="fl-qrimg" id="fl-qr" src="" alt="QR code" loading="lazy" />',
    '        <p class="fl-qrlbl">Scan with wallet</p>',
    '      </div>',
    '      <div class="fl-infoside">',
    '        <div class="fl-iblk"><label>Amount to Send</label><div class="fl-amt" id="fl-amt"></div><div class="fl-amtsub" id="fl-amtsub"></div></div>',
    '        <div class="fl-iblk"><label>Deposit Address</label>',
    '          <div class="fl-arow"><span class="fl-aval" id="fl-addr"></span><button type="button" class="fl-cpbtn" id="fl-cpbtn">Copy</button></div>',
    '        </div>',
    '        <div class="fl-iblk"><label>Network</label><span class="fl-nbadge"><span class="fl-ndot"></span><span id="fl-net"></span></span></div>',
    '      </div>',
    '    </div>',
    '  </div>',
    /* success */
    '  <div class="fl-rstate" id="fl-ok">',
    '    <div class="fl-rico">✅</div>',
    '    <div class="fl-rtitle">Payment Confirmed!</div>',
    '    <div class="fl-rsub" id="fl-ok-sub">Your crypto payment has been received.</div>',
    '  </div>',
    /* expired */
    '  <div class="fl-rstate" id="fl-exp">',
    '    <div class="fl-rico">⏳</div>',
    '    <div class="fl-rtitle">Payment Expired</div>',
    '    <div class="fl-rsub">The payment window has closed. Please start a new payment.</div>',
    '  </div>',
    '</div>',
    '<div class="fl-foot">Secured by <a href="https://forgelayer.io" target="_blank" rel="noopener">ForgeLayer</a></div>',
    '</div>',
  ].join('');

  var MODAL_CSS = [
    '.fl-checkout-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 24px;background:#f7931a;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s,transform .1s;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.2}',
    '.fl-checkout-btn:hover{background:#e07b10}.fl-checkout-btn:active{transform:scale(.97)}.fl-checkout-btn:disabled{opacity:.6;cursor:not-allowed}',
    '.fl-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99999;padding:16px}',
    '.fl-backdrop.fl-open{display:flex;align-items:center;justify-content:center;animation:fl-fade .18s ease}',
    '.fl-modal{background:#fff;border-radius:16px;width:100%;max-width:520px;box-shadow:0 24px 64px rgba(0,0,0,.28);overflow:hidden;animation:fl-up .22s ease;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;color:#111}',
    '.fl-mhd{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #e5e7eb;background:#fafafa}',
    '.fl-mtitle{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700;color:#111}',
    '.fl-logo{width:26px;height:26px;background:#f7931a;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px;font-weight:800;flex-shrink:0;letter-spacing:-.5px}',
    '.fl-xbtn{background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#6b7280;padding:4px 6px;border-radius:5px;transition:background .12s}',
    '.fl-xbtn:hover{background:#f3f4f6;color:#111}',
    '.fl-mbody{padding:20px 18px}',
    '#fl-loading{text-align:center;padding:28px 0}',
    '.fl-spinner{width:38px;height:38px;border:3px solid #e5e7eb;border-top-color:#f7931a;border-radius:50%;animation:fl-spin .7s linear infinite;margin:0 auto 14px}',
    '.fl-spin-lbl{color:#6b7280;font-size:13px}',
    '.fl-sbar{display:flex;align-items:center;gap:9px;padding:9px 13px;border-radius:8px;background:#f9fafb;border:1px solid #e5e7eb;margin-bottom:14px;font-size:13px}',
    '.fl-sdot{width:8px;height:8px;border-radius:50%;flex-shrink:0}',
    '.fl-sdot.pending{background:#f59e0b;animation:fl-pulse 1.6s ease-in-out infinite}',
    '.fl-sdot.confirmed{background:#10b981}.fl-sdot.expired{background:#ef4444}',
    '.fl-timer{margin-left:auto;font-weight:600;font-size:13px;color:#374151;font-variant-numeric:tabular-nums}.fl-timer.urgent{color:#ef4444}',
    '.fl-warn{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 13px;font-size:12px;color:#92400e;margin-bottom:14px;line-height:1.5}',
    '.fl-grid{display:flex;gap:18px;margin-bottom:14px}',
    '.fl-qrside{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px}',
    '.fl-qrimg{width:148px;height:148px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;display:block}',
    '.fl-qrlbl{font-size:11px;color:#9ca3af}',
    '.fl-infoside{flex:1;min-width:0;display:flex;flex-direction:column;gap:13px}',
    '.fl-iblk label{display:block;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}',
    '.fl-amt{font-size:22px;font-weight:700;color:#111;line-height:1.2}.fl-amtsub{font-size:12px;color:#6b7280;margin-top:2px}',
    '.fl-arow{display:flex;align-items:flex-start;gap:7px}',
    '.fl-aval{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:#374151;word-break:break-all;flex:1;line-height:1.5}',
    '.fl-cpbtn{flex-shrink:0;background:#fff;border:1px solid #d1d5db;border-radius:6px;padding:5px 11px;font-size:12px;cursor:pointer;color:#374151;transition:background .12s;white-space:nowrap}',
    '.fl-cpbtn:hover{background:#f3f4f6}.fl-cpbtn.copied{border-color:#10b981;color:#059669}',
    '.fl-nbadge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;background:#f3f4f6;border-radius:100px;font-size:12px;font-weight:500;color:#374151}',
    '.fl-ndot{width:7px;height:7px;border-radius:50%;background:#10b981}',
    '.fl-rstate{display:none;text-align:center;padding:30px 16px}',
    '.fl-rstate.fl-show{display:block}',
    '.fl-rico{font-size:52px;margin-bottom:14px}.fl-rtitle{font-size:19px;font-weight:700;color:#111;margin-bottom:7px}.fl-rsub{font-size:13px;color:#6b7280}',
    '.fl-foot{padding:10px 18px 14px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #f3f4f6}',
    '.fl-foot a{color:#f7931a;text-decoration:none}',
    '@keyframes fl-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes fl-up{from{transform:translateY(18px);opacity:0}to{transform:translateY(0);opacity:1}}',
    '@keyframes fl-spin{to{transform:rotate(360deg)}}',
    '@keyframes fl-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    '@media(max-width:460px){.fl-grid{flex-direction:column;align-items:center}.fl-qrside{flex-direction:row;gap:12px}}',
  ].join('');

  // ── DOM helpers ─────────────────────────────────────────────────────────────
  function qs(id) { return document.getElementById(id); }

  function injectStyles() {
    if (document.getElementById('fl-styles')) return;
    var s = document.createElement('style');
    s.id = 'fl-styles';
    s.textContent = MODAL_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildBackdrop() {
    if (qs('fl-bd')) { backdrop = qs('fl-bd'); return; }
    injectStyles();
    backdrop = document.createElement('div');
    backdrop.id        = 'fl-bd';
    backdrop.className = 'fl-backdrop';
    backdrop.innerHTML = MODAL_HTML;
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    qs('fl-xbtn').addEventListener('click', closeModal);
    qs('fl-cpbtn').addEventListener('click', copyAddr);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
  }

  function copyAddr() {
    var addr = qs('fl-addr').textContent;
    var btn  = qs('fl-cpbtn');
    var done = function () {
      btn.textContent = 'Copied!'; btn.classList.add('copied');
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    };
    if (navigator.clipboard) { navigator.clipboard.writeText(addr).then(done).catch(done); }
    else {
      var ta = document.createElement('textarea');
      ta.value = addr; ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta); done();
    }
  }

  // ── State machine ────────────────────────────────────────────────────────────
  function showPane(id) {
    ['fl-loading', 'fl-pay', 'fl-ok', 'fl-exp'].forEach(function (k) {
      var el = qs(k); if (el) el.style.display = (k === id) ? 'block' : 'none';
    });
    ['fl-ok', 'fl-exp'].forEach(function (k) {
      var el = qs(k); if (el) el.classList.toggle('fl-show', k === id);
    });
  }

  function openModal() {
    buildBackdrop();
    backdrop.classList.add('fl-open');
    document.body.style.overflow = 'hidden';
    showPane('fl-loading');
  }

  function closeModal() {
    if (backdrop) backdrop.classList.remove('fl-open');
    document.body.style.overflow = '';
    stopPoll(); stopCd();
    if (userCallbacks.onCancel) userCallbacks.onCancel();
    activeOrder = null;
    userCallbacks = {};
  }

  function fillPayment(o) {
    activeOrder = o;
    qs('fl-qr').src  = o.qrUrl;
    qs('fl-qr').alt  = 'Send to ' + o.address;
    qs('fl-addr').textContent = o.address;
    qs('fl-net').textContent  = o.chainName + ' · ' + o.token;

    if (o.cryptoAmount) {
      qs('fl-amt').textContent    = (+o.cryptoAmount).toFixed(8).replace(/\.?0+$/, '') + ' ' + o.token;
      qs('fl-amtsub').textContent = '≈ ' + o.currency + ' ' + (+o.amount).toFixed(2);
    } else {
      qs('fl-amt').textContent    = o.currency + ' ' + (+o.amount).toFixed(2);
      qs('fl-amtsub').textContent = '';
    }

    qs('fl-warn').innerHTML =
      '<strong>⚠ Important:</strong> Send only <strong>' + o.token +
      '</strong> on the <strong>' + o.chainName + '</strong> network. Wrong network = permanent loss.';

    showPane('fl-pay');
    startCd(o.expiresAt);
    startPoll(o);
  }

  function triggerSuccess(o) {
    showPane('fl-ok');
    qs('fl-sdot').className = 'fl-sdot confirmed';
    stopPoll(); stopCd();
    if (userCallbacks.onSuccess) userCallbacks.onSuccess(o);
    if (o.successUrl) setTimeout(function () { window.location.href = o.successUrl; }, 2200);
  }

  function triggerExpired() {
    showPane('fl-exp');
    stopPoll(); stopCd();
    if (userCallbacks.onExpired) userCallbacks.onExpired();
  }

  // ── Countdown ────────────────────────────────────────────────────────────────
  function startCd(expiresAt) {
    stopCd();
    function tick() {
      var rem = expiresAt - Math.floor(Date.now() / 1000);
      var el  = qs('fl-timer');
      if (!el) return;
      if (rem <= 0) { el.textContent = '00:00'; el.classList.add('urgent'); stopCd(); return; }
      var m = Math.floor(rem / 60), s = rem % 60;
      el.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
      if (rem <= 120) el.classList.add('urgent');
    }
    tick();
    cdTmr = setInterval(tick, 1000);
  }
  function stopCd() { if (cdTmr) { clearInterval(cdTmr); cdTmr = null; } }

  // ── Status polling ────────────────────────────────────────────────────────────
  function startPoll(o) {
    stopPoll();
    pollTmr = setInterval(function () {
      var url = (o.statusUrl || DEFAULT_STATUS_URL) + '?orderId=' + encodeURIComponent(o.orderId) + '&session=' + encodeURIComponent(o.sessionKey || '');
      fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d.ok) return;
          if (d.status === 'confirmed') triggerSuccess(o);
          else if (d.status === 'expired') triggerExpired();
        })
        .catch(function () { /* keep polling */ });
    }, 15000);
  }
  function stopPoll() { if (pollTmr) { clearInterval(pollTmr); pollTmr = null; } }

  // ── Trigger a payment from a button or config object ─────────────────────────
  function triggerPayment(params, callbacks) {
    userCallbacks = callbacks || {};
    openModal();

    var createUrl = params.createUrl || params.serverUrl || DEFAULT_CREATE_URL;
    var statusUrl = params.statusUrl  || DEFAULT_STATUS_URL;

    fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        amount:        +params.amount || 0,
        currency:      params.currency   || 'USD',
        chain:         params.chain      || 'ethereum',
        token:         params.token      || 'USDT',
        orderId:       params.orderId    || '',
        reuseAddress:  !!params.reuseAddress,
        paymentWindow: +params.paymentWindow || 30,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          closeModal();
          if (userCallbacks.onError) userCallbacks.onError(new Error(d.error || 'Address generation failed.'));
          else alert('ForgeLayer: ' + (d.error || 'Failed to generate payment address.'));
          return;
        }
        fillPayment(Object.assign({}, d, {
          statusUrl:  statusUrl,
          successUrl: params.successUrl || '',
        }));
      })
      .catch(function (e) {
        closeModal();
        if (userCallbacks.onError) userCallbacks.onError(e);
        else alert('Network error: ' + e.message);
      });
  }

  // ── Wire data-attribute buttons ───────────────────────────────────────────────
  function handleDataBtn(btn) {
    var ds = btn.dataset;
    triggerPayment(
      {
        createUrl:     ds.flCreateUrl || ds.flEndpoint || DEFAULT_CREATE_URL,
        statusUrl:     ds.flStatusUrl  || DEFAULT_STATUS_URL,
        amount:        ds.flAmount,
        currency:      ds.flCurrency,
        chain:         ds.flChain,
        token:         ds.flToken,
        orderId:       ds.flOrderId,
        reuseAddress:  ds.flReuse === '1',
        paymentWindow: ds.flWindow,
        successUrl:    ds.flSuccess,
      },
      {}
    );
  }

  function wireBtns() {
    document.querySelectorAll('.fl-checkout-btn').forEach(function (btn) {
      if (btn.dataset.flWired) return;
      btn.dataset.flWired = '1';
      btn.addEventListener('click', function () { handleDataBtn(btn); });
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  var ForgeLayerCheckout = {
    /**
     * Programmatically mount a button and handle its click.
     *
     * @param {string|Element} selector - CSS selector or DOM element.
     * @param {object} params           - Payment params (amount, currency, chain, token, orderId, …).
     * @param {object} [callbacks]      - { onSuccess, onExpired, onCancel, onError }
     */
    mount: function (selector, params, callbacks) {
      var el = typeof selector === 'string' ? document.querySelector(selector) : selector;
      if (!el) return console.warn('ForgeLayerCheckout.mount: element not found:', selector);

      // If the element is already a button, wire it; otherwise inject one
      if (el.tagName === 'BUTTON') {
        el.classList.add('fl-checkout-btn');
        el.removeEventListener('click', el._flHandler);
        el._flHandler = function () { triggerPayment(params, callbacks || {}); };
        el.addEventListener('click', el._flHandler);
        el.dataset.flWired = '1';
      } else {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'fl-checkout-btn';
        btn.textContent = params.label || 'Pay with Crypto';
        btn.addEventListener('click', function () { triggerPayment(params, callbacks || {}); });
        btn.dataset.flWired = '1';
        el.innerHTML = '';
        el.appendChild(btn);
      }
    },

    /** Open the modal immediately (e.g. from your own button). */
    open: function (params, callbacks) {
      triggerPayment(params, callbacks || {});
    },

    /** Close the modal. */
    close: closeModal,
  };

  // ── Boot ───────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireBtns);
  } else {
    wireBtns();
  }
  new MutationObserver(wireBtns).observe(
    document.body || document.documentElement,
    { childList: true, subtree: true }
  );

  // Expose globally
  global.ForgeLayerCheckout = ForgeLayerCheckout;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
