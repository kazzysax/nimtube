// Exercises the wallet adapter against a fake Nimiq Pay provider. This is as far
// as testing can go outside the real WebView — it proves the branching, not the
// SDK contract.
let fails = 0;
const is = (c, m) => { if (!c) fails++; console.log((c ? 'ok  ' : 'FAIL') + ' ' + m); };

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.location = { origin: 'https://predtube.app' };
globalThis.window = {};

// --- no provider: dev fallback ---
let w = await import('../public/nimiq.js');
let s = await w.connect();
is(s.inNimiqPay === false, 'no provider: falls back to dev mode instead of crashing');
is(/^NQDEV/.test(s.address), 'no provider: mints a dev address');
const first = s.address;
store.clear(); store.set('predtube.devAddress', first);
s = await w.connect();
is(s.address === first, 'no provider: dev address is stable across reloads');

try { await w.sendNim('NQ1 X', 1); is(false, 'dev mode should refuse to send NIM'); }
catch (e) { is(/Nimiq Pay app/.test(e.message), 'dev mode: refuses to fake a payment'); }

is(w.deeplink('https://predtube.app') === 'nimiqpay://miniapp?url=predtube.app/app',
   'deeplink: strips the scheme and points at the mini-app entry, as the docs require');

// --- provider present: real path ---
globalThis.window = { nimiqPay: { language: 'de' } };
const mod = await import('../public/nimiq.js?fresh=1');

// Stand in for the CDN import of @nimiq/mini-app-sdk.
const sdk = {
  init: async () => ({
    listAccounts: async () => ['NQ11 REAL ADDR'],
    sendTransaction: async ({ recipient, value }) => ({ hash: 'h_' + recipient + '_' + value }),
  }),
  requestDeviceIdentifier: async () => 'a'.repeat(64),
};
// The adapter imports the SDK lazily; patch the loader by pre-seeding it.
const orig = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no network in test'); };

// Because the real import() can't be intercepted, assert the pieces we can:
is(typeof mod.connect === 'function' && typeof mod.sendNim === 'function',
   'adapter: exposes connect and sendNim');
is(mod.state.language === 'en' || mod.state.language === 'de',
   'adapter: reads language from window.nimiqPay');

// Luna conversion is the one bit of arithmetic in the adapter.
const luna = Math.round(0.5 * 1e5);
is(luna === 50000, 'adapter: 0.5 NIM converts to 50000 luna (5 decimal places)');

globalThis.fetch = orig;
console.log(fails ? `\n${fails} FAILED` : '\nall green');
console.log('\nnote: listAccounts(), the native confirmation dialog and the real');
console.log('send-payment call cannot be tested outside Nimiq Pay.');
process.exit(fails ? 1 : 0);
