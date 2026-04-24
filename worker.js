import { parentPort, workerData } from "worker_threads";
import { createHash } from "crypto";
import { loadBloomFromShared } from "./bloom.js";
import { deriveEnabled, isValidPrivKey, wifEncode, toHex } from "./keys.js";

const { workerId, seedHex, bloom: bloomMeta, vanityPatterns, addressTypes } =
  workerData;

const seedBuf = Buffer.from(seedHex, "hex");

const bloom = bloomMeta
  ? loadBloomFromShared(bloomMeta.sab, bloomMeta.m, bloomMeta.k)
  : null;

const ctrBuf = Buffer.alloc(8);

function deriveKey(counter) {
  ctrBuf.writeBigUInt64BE(BigInt(counter));
  return createHash("sha256").update(seedBuf).update(ctrBuf).digest();
}

function checkVanity(addr) {
  for (let i = 0; i < vanityPatterns.length; i++) {
    if (addr.startsWith(vanityPatterns[i])) return vanityPatterns[i];
  }
  return null;
}

const TYPE_LABELS = {
  p2pkhComp: { label: "p2pkh-comp", compressed: true },
  p2pkhUncomp: { label: "p2pkh-uncomp", compressed: false },
  p2sh: { label: "p2sh-segwit", compressed: true },
  p2wpkh: { label: "p2wpkh", compressed: true },
  p2tr: { label: "p2tr", compressed: true },
};

const ENABLED_TYPES = Object.keys(TYPE_LABELS).filter(
  (k) => addressTypes[k],
);

function processBatch(startCounter, count) {
  const hits = [];
  let scanned = 0;
  let invalid = 0;
  let vanityHits = 0;
  let bloomMatches = 0;

  for (let i = 0; i < count; i++) {
    const counter = startCounter + i;
    const privKey = deriveKey(counter);
    scanned++;

    if (!isValidPrivKey(privKey)) {
      invalid++;
      continue;
    }

    let addrs;
    try {
      addrs = deriveEnabled(privKey, addressTypes);
    } catch (e) {
      invalid++;
      continue;
    }

    for (const k of ENABLED_TYPES) {
      const addr = addrs[k];
      if (!addr) continue;
      const vanity = checkVanity(addr);
      const bloomMatch = bloom ? bloom.has(addr) : false;
      if (vanity || bloomMatch) {
        const meta = TYPE_LABELS[k];
        hits.push({
          counter,
          type: meta.label,
          addr,
          vanity,
          bloomMatch,
          wif: wifEncode(privKey, meta.compressed),
          privHex: toHex(privKey),
        });
        if (vanity) vanityHits++;
        if (bloomMatch) bloomMatches++;
      }
    }
  }

  return { scanned, invalid, vanityHits, bloomMatches, hits };
}

parentPort.on("message", (msg) => {
  if (msg.type === "scan") {
    const result = processBatch(msg.startCounter, msg.count);
    parentPort.postMessage({
      type: "done",
      workerId,
      startCounter: msg.startCounter,
      count: msg.count,
      ...result,
    });
  } else if (msg.type === "stop") {
    process.exit(0);
  }
});

parentPort.postMessage({ type: "ready", workerId });
