// Web Push for Hermosapp (update-0055): VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291), WebCrypto only,
// so it runs in the Cloudflare Worker with no extra packages.
export type PushSub = { endpoint: string; p256dh: string; auth: string };

const enc = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ""; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s: string) => {
  const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(t, (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) => {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, key, bytes * 8));
};

/** Encrypt a payload for one subscription (aes128gcm, single record). */
export async function encryptPayload(sub: PushSub, payload: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPublic = unb64u(sub.p256dh), authSecret = unb64u(sub.auth);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, concat(payload, new Uint8Array([2])) as BufferSource));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPublic, cipher);
}

/** VAPID Authorization header value. privateD/publicKey are base64url (d of the P-256 key, and the 65-byte public key). */
export async function vapidAuth(endpoint: string, publicKey: string, privateD: string, subject: string) {
  const pub = unb64u(publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: privateD, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`) as BufferSource);
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicKey}`;
}

/** Send one push. Returns the push service's status (201 = accepted, 404/410 = subscription gone). */
export async function sendPush(sub: PushSub, data: object, vapid: { publicKey: string; privateD: string; subject: string }) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(data)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high",
      Authorization: await vapidAuth(sub.endpoint, vapid.publicKey, vapid.privateD, vapid.subject) },
    body: body as BodyInit,
  });
  return res.status;
}
