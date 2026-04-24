import { parentPort, workerData } from "worker_threads";
import { createHash } from "crypto";
import { loadBloomFromCacheSync } from "./bloom.js";
import { deriveAll, isValidPrivKey, wifEncode, toHex } from "./keys.js";

const { workerId, seedHex, bloomCachePath, vanityPatterns } = workerData;
const seedBuf = Buffer.from(seedHex, "hex");

let bloom = null;
if (bloomCachePath) {
  bloom = loadBloomFromCacheSync();
}

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

const ADDRESS_TYPES = [
  { key: "p2pkhComp", label: "p2pkh-comp", compressed: true },
  { key: "p2pkhUncomp", label: "p2pkh-uncomp", compressed: false },
  { key: "p2sh", label: "p2sh-segwit", compressed: true },
  { key: "p2wpkh", label: "p2wpkh", compressed: true },
];

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
      addrs = deriveAll(privKey);
    } catch (e) {
      invalid++;
      continue;
    }

    for (const t of ADDRESS_TYPES) {
      const addr = addrs[t.key];
      const vanity = checkVanity(addr);
      const bloomMatch = bloom ? bloom.has(addr) : false;
      if (vanity || bloomMatch) {
        hits.push({
          counter,
          type: t.label,
          addr,
          vanity,
          bloomMatch,
          wif: wifEncode(privKey, t.compressed),
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
