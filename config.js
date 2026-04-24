import * as fs from "fs";

const CONFIG_FILE = "config.json";

export const DEFAULTS = {
  telegram: {
    enabled: false,
    botToken: "",
    chatId: "",
    notifyOnFound: true,
    notifyOnVanity: false,
    notifyOnBloomMatch: false,
  },
  vanityPatterns: [
    "1Love",
    "1Lucky",
    "1Bitcoin",
    "1Satoshi",
    "1Crypto",
    "1Money",
    "1Cash",
    "1Boss",
    "1ABCD",
    "1Free",
  ],
  scanning: {
    batchSize: 2000,
    addressTypes: {
      p2pkhComp: true,
      p2pkhUncomp: true,
      p2sh: true,
      p2wpkh: true,
      p2tr: true,
    },
  },
  scaling: {
    minWorkers: 1,
    maxWorkers: null,
    lagHighMs: 120,
    lagLowMs: 30,
    freeMemMin: 0.15,
    intervalMs: 5000,
    cooldownMs: 8000,
  },
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (
      sv &&
      typeof sv === "object" &&
      !Array.isArray(sv) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], sv);
    } else {
      target[key] = sv;
    }
  }
  return target;
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2));
    console.log(
      `Created ${CONFIG_FILE} with defaults. Edit it to enable Telegram, tweak vanity patterns, scaling, or address types.`,
    );
    return deepClone(DEFAULTS);
  }
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    console.log(`Could not parse ${CONFIG_FILE}: ${e.message}. Using defaults.`);
    return deepClone(DEFAULTS);
  }
  const merged = deepClone(DEFAULTS);
  deepMerge(merged, user);
  return merged;
}
