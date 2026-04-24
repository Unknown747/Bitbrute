import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import bs58check from "bs58check";
import { bech32 } from "bech32";

const N_MINUS_1 = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140",
);

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

function p2pkh(pubKey) {
  const h = hash160(pubKey);
  const payload = new Uint8Array(21);
  payload[0] = 0x00;
  payload.set(h, 1);
  return bs58check.encode(payload);
}

function p2sh(scriptHash) {
  const payload = new Uint8Array(21);
  payload[0] = 0x05;
  payload.set(scriptHash, 1);
  return bs58check.encode(payload);
}

function p2wpkh(pubKeyHash) {
  const words = bech32.toWords(pubKeyHash);
  return bech32.encode("bc", [0, ...words]);
}

export function deriveAll(privKey32) {
  const pubComp = secp.getPublicKey(privKey32, true);
  const pubUncomp = secp.getPublicKey(privKey32, false);
  const h160Comp = hash160(pubComp);

  const redeem = new Uint8Array(22);
  redeem[0] = 0x00;
  redeem[1] = 0x14;
  redeem.set(h160Comp, 2);
  const redeemHash = hash160(redeem);

  return {
    p2pkhComp: p2pkh(pubComp),
    p2pkhUncomp: p2pkh(pubUncomp),
    p2sh: p2sh(redeemHash),
    p2wpkh: p2wpkh(h160Comp),
    pubComp,
    pubUncomp,
  };
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
