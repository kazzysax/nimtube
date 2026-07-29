// Minimal JSON-RPC client for a Nimiq (Albatross) node.
//
// Point NIMIQ_RPC_URL at your own node. The public open servers are fine for
// development but the docs are explicit that they carry no uptime guarantee and
// are not suitable for production — and this is the code that decides whether
// someone's money arrived.

const URL_ = () => process.env.NIMIQ_RPC_URL;

let id = 0;

export async function rpc(method, params = []) {
  const url = URL_();
  if (!url) throw new Error('NIMIQ_RPC_URL is not set');

  const headers = { 'content-type': 'application/json' };
  if (process.env.NIMIQ_RPC_TOKEN) headers.authorization = `Bearer ${process.env.NIMIQ_RPC_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message || JSON.stringify(body.error)}`);

  // Albatross wraps successful results as { data, metadata }.
  return body.result?.data !== undefined ? body.result.data : body.result;
}

/** Returns the transaction, or null when the node has never seen that hash. */
export async function getTransactionByHash(hash) {
  try {
    return await rpc('getTransactionByHash', [hash]);
  } catch (e) {
    if (/not found|unknown|no transaction/i.test(e.message)) return null;
    throw e;
  }
}

export const getBlockNumber = () => rpc('getBlockNumber', []);

/** Addresses come back in varying spacing and case; compare them flattened. */
export const sameAddress = (a, b) =>
  String(a || '').replace(/\s+/g, '').toUpperCase() === String(b || '').replace(/\s+/g, '').toUpperCase();

/** recipientData is hex on the wire. Tips carry a plain-text marker in it. */
export function decodeData(hex) {
  if (!hex) return '';
  try {
    return Buffer.from(String(hex).replace(/^0x/, ''), 'hex').toString('utf8');
  } catch {
    return '';
  }
}
