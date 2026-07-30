// Adapter around the Nimiq Pay Mini App SDK.
//
// Inside Nimiq Pay the provider is injected into the WebView and init() waits for
// it. Outside — a normal desktop browser, which is where you'll do most of your
// building — there is no provider at all, so this falls back to a local dev
// identity. The rest of the app never needs to know which one it got.

const SDK_URL = '/vendor/nimiq-mini-app-sdk/index.js';

let sdk = null;
let nimiq = null;

export const state = {
  ready: false,
  inNimiqPay: false,
  address: null,
  deviceHash: null,
  language: 'en',
};

async function loadSdk() {
  if (sdk) return sdk;
  try {
    sdk = await import(/* @vite-ignore */ SDK_URL);
  } catch {
    sdk = null;
  }
  return sdk;
}

/** True when we're actually running inside the Nimiq Pay host app.
 *  window.ethereum is not a Nimiq signal — it's injected by any EVM wallet
 *  extension (MetaMask, Coinbase Wallet, ...) and was falsely tripping this. */
function providerPresent() {
  return typeof window !== 'undefined' && !!window.nimiqPay;
}

function devFallback() {
  // Dev fallback. Stable per browser so reloads keep the same account.
  let dev = localStorage.getItem('nimtube.devAddress');
  if (!dev) {
    dev = 'NQDEV' + Math.random().toString(36).slice(2, 10).toUpperCase();
    localStorage.setItem('nimtube.devAddress', dev);
  }
  Object.assign(state, { ready: true, inNimiqPay: false, address: dev, deviceHash: 'dev-' + dev });
  return state;
}

export async function connect() {
  state.language = window.nimiqPay?.language || 'en';

  if (!providerPresent()) return devFallback();

  try {
    const s = await loadSdk();
    if (!s?.init) throw new Error('Nimiq Pay provider found but the SDK failed to load');

    nimiq = await s.init();

    // listAccounts() returns string[] of user-friendly addresses, behind a native
    // confirmation dialog. Rejects with PermissionDeniedError if the user declines.
    const accounts = await nimiq.listAccounts();
    const address = Array.isArray(accounts) ? accounts[0] : null;
    if (!address) throw new Error('No account was approved');

    // Per-device, per-origin hash. Identifies the device, not the person — useful
    // as an anti-alt signal, useless as an identity. Never fatal if refused.
    let deviceHash = null;
    try {
      deviceHash = await s.requestDeviceIdentifier({ reason: 'Reputation and anti-spam' });
    } catch { /* user declined; carry on */ }

    Object.assign(state, { ready: true, inNimiqPay: true, address, deviceHash });
    return state;
  } catch (e) {
    // window.nimiqPay was present but the handshake failed — don't leave
    // state.address unset, which would silently break sign-in downstream.
    console.warn('Nimiq Pay connect failed, falling back to dev mode:', e);
    return devFallback();
  }
}

/** Sign a server-issued challenge, proving we hold the key for this address.
 *  Returns hex publicKey and signature. Native dialog; the user approves. */
export async function signMessage(message) {
  if (!state.inNimiqPay || !nimiq) throw new Error('Wallet not connected');
  return nimiq.sign(message);           // { publicKey, signature } as hex
}

/** Send NIM. `sendBasicTransactionWithData` returns the transaction hash as a
 *  plain string. Nimiq Pay shows its own confirmation dialog; we never see keys.
 *  The server treats the hash as unverified until it is confirmed on chain.
 *
 *  The market id is attached as transaction data so the tip is self-documenting
 *  on chain — verification doesn't have to trust anything the client said. */
export async function sendNim(toAddress, amountNim, note) {
  if (!state.inNimiqPay) throw new Error('Tipping needs the Nimiq Pay app');
  if (!nimiq) throw new Error('Wallet not connected');

  const value = Math.round(amountNim * 1e5);   // 1 NIM = 100,000 luna
  try {
    const hash = note
      ? await nimiq.sendBasicTransactionWithData({ recipient: toAddress, value, data: note })
      : await nimiq.sendBasicTransaction({ recipient: toAddress, value });
    return String(hash);
  } catch (e) {
    if (/PermissionDenied/i.test(e?.name || e?.message || '')) throw new Error('You cancelled the payment');
    if (/InvalidTransaction/i.test(e?.name || e?.message || '')) throw new Error('Nimiq rejected that transaction');
    throw e;
  }
}

export function deeplink(origin = location.origin) {
  return `nimiqpay://miniapp?url=${origin.replace(/^https?:\/\//, '')}`;
}
