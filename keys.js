import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import bs58check from "bs58check";
import { bech32, bech32m } from "bech32";

const N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);
const N_MINUS_1 = N - 1n;

const TAP_TWEAK_TAG = sha256(new TextEncoder().encode("TapTweak"));

export function isValidPrivKey(buf) {
  let allZero = true;
  for (let i = 0; i < 32; i++) {
    if (buf[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return false;
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(buf[i]);
  return v <= N_MINUS_1;
}

function hash160(data) {
  return ripemd160(sha256(data));
}

function bytesToBigInt(bytes) {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function p2pkhFromH160(h) {
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(h, 1);
  return bs58check.encode(payload);
}

function p2pkh(pubKey) {
  return p2pkhFromH160(hash160(pubKey));
}

function p2sh(scriptHash) {
  const payload = new Uint8Array(21);
  payload[0] = 0x05;
  payload.set(scriptHash, 1);
  return bs58check.encode(payload);
}

function p2wpkh(pubKeyHash) {
  return bech32.encode("bc", [0, ...bech32.toWords(pubKeyHash)]);
}

function p2tr(pubComp) {
  const xOnly = pubComp.slice(1);
  const evenComp = new Uint8Array(33);
  evenComp[0] = 0x02;
  evenComp.set(xOnly, 1);

  const inner = new Uint8Array(64 + 32);
  inner.set(TAP_TWEAK_TAG, 0);
  inner.set(TAP_TWEAK_TAG, 32);
  inner.set(xOnly, 64);
  const tweak = bytesToBigInt(sha256(inner)) % N;

  const P = secp.ProjectivePoint.fromHex(evenComp);
  const Q = secp.ProjectivePoint.BASE.multiplyAndAddUnsafe(P, tweak, 1n);
  const Qx = Q.toRawBytes(true).slice(1);
  return bech32m.encode("bc", [1, ...bech32m.toWords(Qx)]);
}

export function deriveEnabled(privKey32, types) {
  const out = {};
  let pubComp = null;
  let h160Comp = null;

  const needComp =
    types.p2pkhComp || types.p2sh || types.p2wpkh || types.p2tr;
  if (needComp) {
    pubComp = secp.getPublicKey(privKey32, true);
    h160Comp = hash160(pubComp);
  }

  if (types.p2pkhComp) out.p2pkhComp = p2pkhFromH160(h160Comp);
  if (types.p2pkhUncomp) {
    const pubUncomp = secp.getPublicKey(privKey32, false);
    out.p2pkhUncomp = p2pkh(pubUncomp);
  }
  if (types.p2sh) {
    const redeem = new Uint8Array(22);
    redeem[0] = 0x00;
    redeem[1] = 0x14;
    redeem.set(h160Comp, 2);
    out.p2sh = p2sh(hash160(redeem));
  }
  if (types.p2wpkh) out.p2wpkh = p2wpkh(h160Comp);
  if (types.p2tr) out.p2tr = p2tr(pubComp);

  return out;
}

export function wifEncode(privKey32, compressed) {
  const len = compressed ? 34 : 33;
  const payload = new Uint8Array(len);
  payload[0] = 0x80;
  payload.set(privKey32, 1);
  if (compressed) payload[33] = 0x01;
  return bs58check.encode(payload);
}

export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
