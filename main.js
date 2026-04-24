const bitcore = require("bitcore-lib");
const fs = require("fs");

const state = { pause: 0 };

function generateKeys() {
  const privateKey = new bitcore.PrivateKey();
  const publicKey = privateKey.toPublicKey();
  const address = publicKey.toAddress().toString();
  const wif = privateKey.toWIF();
  const privHex = privateKey.toString();
  const pubHexUncompressed =
    "04" +
    publicKey.point.getX().toString(16, 64) +
    publicKey.point.getY().toString(16, 64);
  return { privHex, wif, pubHexUncompressed, address };
}

async function getBalance(address) {
  try {
    const res = await fetch(
      `https://blockstream.info/api/address/${address}`,
      { headers: { Accept: "application/json" } },
    );

    if (res.status === 429) {
      state.pause += 1;
      if (state.pause >= 10) {
        console.log("\nRate limited by API. Sleeping 30 seconds...\n");
        await sleep(30000);
        state.pause = 0;
      }
      return -1;
    }

    if (!res.ok) {
      console.log(
        `\nHTTP Error Code: ${res.status}\nRetrying in 10 seconds\n`,
      );
      await sleep(10000);
      return -1;
    }

    const data = await res.json();
    state.pause = 0;
    const funded = data.chain_stats?.funded_txo_sum ?? 0;
    const spent = data.chain_stats?.spent_txo_sum ?? 0;
    return funded - spent;
  } catch (err) {
    console.log(`\nNetwork error: ${err.message}\nRetrying in 10 seconds\n`);
    await sleep(10000);
    return -1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("\n-----------------Warning Wallet Balance---------------!");
  while (true) {
    const { privHex, wif, pubHexUncompressed, address } = generateKeys();
    const balance = await getBalance(address);

    if (balance === -1) continue;

    if (balance === 0) {
      console.log(`${address.padEnd(34)} = ${balance}`);
    } else if (balance > 0) {
      const record =
        `\nAddress: ${address}\n` +
        `Private Key: ${privHex}\n` +
        `Wallet Import Format Private Key: ${wif}\n` +
        `Public Key: ${pubHexUncompressed.toUpperCase()}\n` +
        `Balance: ${balance}\n`;
      console.log(record);
      fs.appendFileSync("bitforce-found.txt", record);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
