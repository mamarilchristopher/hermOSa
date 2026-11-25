// Web Push encryption round trip: encrypt as the server, decrypt as the phone would (RFC 8291). Test keys only.
import { createECDH, createDecipheriv, hkdfSync, randomBytes, createPublicKey, verify } from "node:crypto";
import { expect, it } from "vitest";
import { b64u, encryptPayload, unb64u, vapidAuth } from "../../src/lib/webpush";

it("a phone can decrypt what the server sends", async () => {
  const ua = createECDH("prime256v1"); ua.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: "https://push.example/abc", p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) };
  const msg = JSON.stringify({ title: "DEMO", body: "Urgent: add client photos" });
  const body = await encryptPayload(sub, new TextEncoder().encode(msg));
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), cipher = body.slice(21 + idlen);
  expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
  const shared = ua.computeSecret(asPub);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(Buffer.from(cipher.slice(-16)));
  const plain = Buffer.concat([d.update(Buffer.from(cipher.slice(0, -16))), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  expect(plain.subarray(0, -1).toString()).toBe(msg);
});

it("signs a VAPID token the push service can verify", async () => {
  const k = createECDH("prime256v1"); k.generateKeys();
  const header = await vapidAuth("https://fcm.googleapis.com/fcm/send/x", b64u(k.getPublicKey()), b64u(k.getPrivateKey()), "https://hermosaos.com");
  const [, jwt, kk] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  expect(kk).toBe(b64u(k.getPublicKey()));
  const [h, p, s] = jwt.split(".");
  expect(JSON.parse(new TextDecoder().decode(unb64u(p))).aud).toBe("https://fcm.googleapis.com");
  const pub = k.getPublicKey();
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, unb64u(s))).toBe(true);
});
