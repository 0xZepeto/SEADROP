// tele-fcfs.js — Telegram minter bot (ENV-only, FCFS/Public – SeaDrop-ready)
// deps: ethers@5, node-telegram-bot-api, dotenv
require("dotenv").config();
const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");
const fs = require('fs');
const path = require('path');

/* ========= ENV ========= */
const BOT_TOKEN = must("TELEGRAM_BOT_TOKEN");
let RUNTIME_RPC_URL = must("RPC_URL");                     // bisa diubah via /setrpc
let RUNTIME_CONTRACT = must("CONTRACT_ADDRESS");           // bisa diubah via /setcontract

// fungsi & signature (opsional)
let MINT_FUNC = envStr("MINT_FUNC", "mintPublic");
let MINT_SIG  = envStr("MINT_SIG", "mintPublic(address,address,address,uint256)");

// ABI (json string) — default sediakan dua kemungkinan (overload)
let ABI_OVERRIDE = envJSON("ABI_OVERRIDE", [
  "function mintPublic(address,address,address,uint256) payable"
]);

// Argumen dinamis untuk MINT_SIG (opsional)
// contoh: ["NFT_CONTRACT","FEE_RECIPIENT","WALLET","AMOUNT","PROOF_JSON"]
let FUNCTION_ARGS = envJSON("FUNCTION_ARGS_JSON", ["NFT_CONTRACT","FEE_RECIPIENT","WALLET","AMOUNT"]);

// opsi khusus (mis. SeaDrop)
let NFT_CONTRACT  = envStr("NFT_CONTRACT", "0x120f79BfAFEb647bde171630B06b926ac4C35ceD");
let FEE_RECIPIENT = envStr("FEE_RECIPIENT", "0x0000a26b00c1F0DF003000390027140000fAa719");

// data WL
let PROOF_JSON    = envJSONMaybe("PROOF_JSON");  // ["0x...","0x..."]
let SIGNATURE     = envStr("SIGNATURE", "");

// mode & keys
const MODE = envStr("MODE", "multi").toLowerCase();  // single|multi
const PRIVATE_KEYS = readPrivateKeys(); // Baca dari pk.txt

// FCFS knobs
let WAIT_FOR = envStr("WAIT_FOR", "mined").toLowerCase();   // "sent" | "mined"
const CONCURRENCY = envNum("CONCURRENCY", 3);               // paralel wallet per batch
const TX_DELAY_MS = envNum("TX_DELAY_MS", 0);               // jeda antar batch

// mint params
let MINT_AMOUNT = toBN(envStr("MINT_AMOUNT", "1"));
let MINT_PRICE  = ethers.utils.parseEther(envStr("MINT_PRICE", "0"));
let GAS_LIMIT   = envBNMaybe("GAS_LIMIT"); // optional BigNumber

// gas strategy
let GAS_PRICE_GWEI     = envStr("GAS_PRICE_GWEI", "");     // legacy (opsional)
let MAX_FEE_GWEI       = envStr("MAX_FEE_GWEI", "");       // 1559 manual (opsional)
let MAX_PRIORITY_GWEI  = envStr("MAX_PRIORITY_GWEI", "");

// retry/backoff
const RETRY_ATTEMPTS           = envNum("RETRY_ATTEMPTS", 3);
const RETRY_BACKOFF_MS         = envNum("RETRY_BACKOFF_MS", 500);
const RETRY_BACKOFF_MULTIPLIER = envNum("RETRY_BACKOFF_MULTIPLIER", 1.5);
const GAS_BUMP_PERCENT         = envNum("GAS_BUMP_PERCENT", 20);

// access control (opsional)
const ALLOWED = (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

/* ========= Branding ========= */
const BRAND_ADMIN_HANDLE = envStr("BRAND_ADMIN_HANDLE", "@nolxnode");
const BRAND_CHANNEL_NAME  = envStr("BRAND_CHANNEL_NAME", "Airdrop Node");
const BRAND_CHANNEL_URL   = envStr("BRAND_CHANNEL_URL", "https://t.me/airdrop_node");

/* ========= Console Banner ========= */
function showBanner() {
  const reset = "\x1b[0m";
  const bold  = "\x1b[1m";
  const cyan  = "\x1b[36m";
  const mag   = "\x1b[35m";
  const yel   = "\x1b[33m";
  const dim   = "\x1b[2m";
  const line = `${dim}${"─".repeat(64)}${reset}`;
  console.log("\n" + line);
  console.log(`${bold}${cyan}🚀 Telegram FCFS/Public Minter — Project Merlin${reset}`);
  console.log(`${mag}by admin ${BRAND_ADMIN_HANDLE} • ${BRAND_CHANNEL_NAME}${reset}`);
  console.log(`${yel}${BRAND_CHANNEL_URL}${reset}`);
  console.log(line + "\n");
}
function brandCaption() {
  return [
    `👤 Admin: <b>${BRAND_ADMIN_HANDLE}</b>`,
    `🛰️ Brand: <b>${BRAND_CHANNEL_NAME}</b>`,
    `🔗 Channel: <a href="${BRAND_CHANNEL_URL}">${BRAND_CHANNEL_URL}</a>`
  ].join("\n");
}
function brandFooterLine() {
  return `\n— <b>${BRAND_CHANNEL_NAME}</b> • Admin <b>${BRAND_ADMIN_HANDLE}</b> — <a href="${BRAND_CHANNEL_URL}">join</a>`;
}

/* ========= Telegram ========= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
showBanner();

bot.onText(/^\/start$/, (msg) => {
  if (!auth(msg)) return;
  const text = [
    `<b>Bot siap untuk Project Merlin.</b> Private keys dari pk.txt.`,
    ``,
    `<b>Perintah:</b>`,
    `• /status — lihat config aktif`,
    `• /setrpc &lt;url&gt; — ganti RPC runtime`,
    `• /setcontract &lt;0x...&gt; — ganti contract runtime`,
    `• /mint [override opsional] — jalankan mint`,
    ``,
    `<b>Override cepat /mint:</b>`,
    `rpc=https://... contract=0x... amount=1 price=0 gasLimit=300000`,
    `func=mintPublic sig="mintPublic(address,address,address,uint256)"`,
    `abi='["function mintPublic(address,address,address,uint256) payable"]'`,
    `functionArgs='["NFT_CONTRACT","FEE_RECIPIENT","WALLET","AMOUNT"]'`,
    `nft=0x.. fee=0x.. proof='["0xabc"]' signature=0x...`,
    ``,
    `<b>FCFS tips:</b>`,
    `WAIT_FOR=sent • CONCURRENCY=3 • Gas EIP-1559 +15% otomatis`,
    ``,
    `<b>Identitas:</b>`,
    brandCaption()
  ].join("\n");

  bot.sendMessage(msg.chat.id, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔗 ${BRAND_CHANNEL_NAME}`, url: BRAND_CHANNEL_URL }],
        [{ text: `👤 Admin ${BRAND_ADMIN_HANDLE}`, url: `https://t.me/${BRAND_ADMIN_HANDLE.replace('@','')}` }]
      ]
    }
  });
});

bot.onText(/^\/about$/, (msg) => {
  if (!auth(msg)) return;
  bot.sendMessage(msg.chat.id, brandCaption(), {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: `🔗 ${BRAND_CHANNEL_NAME}`, url: BRAND_CHANNEL_URL }],
        [{ text: `👤 Admin ${BRAND_ADMIN_HANDLE}`, url: `https://t.me/${BRAND_ADMIN_HANDLE.replace('@','')}` }]
      ]
    }
  });
});

bot.onText(/^\/status$/, async (msg) => {
  if (!auth(msg)) return;
  const prov = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
  let net;
  try { net = await prov.getNetwork(); } catch (e) { net = { chainId: "?", name: "?" }; }
  bot.sendMessage(msg.chat.id,
`RPC: ${RUNTIME_RPC_URL}
Chain: ${net.name} (${net.chainId})
Contract: ${RUNTIME_CONTRACT}
Func: ${MINT_FUNC} | Sig: ${MINT_SIG || "-"}
Mode: ${MODE} | Keys: ${PRIVATE_KEYS.length} (pk.txt)
WAIT_FOR: ${WAIT_FOR} | CONCURRENCY: ${CONCURRENCY} | Delay: ${TX_DELAY_MS}ms
Amount: ${MINT_AMOUNT.toString()} | Price(ETH): ${ethers.utils.formatEther(MINT_PRICE)}
GasLimit: ${GAS_LIMIT ? GAS_LIMIT.toString() : "-"}
gasPrice=${GAS_PRICE_GWEI || "-"} | maxFee=${MAX_FEE_GWEI || "-"} | maxPrio=${MAX_PRIORITY_GWEI || "-"}
Args: ${JSON.stringify(FUNCTION_ARGS || [])}
NFT: ${NFT_CONTRACT} | Fee: ${FEE_RECIPIENT}
ABI entries: ${Array.isArray(ABI_OVERRIDE) ? ABI_OVERRIDE.length : 0}`);
});

bot.onText(/^\/setrpc\s+(\S+)$/, async (msg, m) => {
  if (!auth(msg)) return;
  RUNTIME_RPC_URL = m[1].trim();
  // test
  try {
    const tmp = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    const net = await tmp.getNetwork();
    bot.sendMessage(msg.chat.id, `OK RPC diubah.\nDetected chain: ${net.name} (${net.chainId})`);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `OK RPC diubah, tapi detect gagal: ${e.message || e}`);
  }
});

bot.onText(/^\/setcontract\s+(0x[a-fA-F0-9]{40})$/, (msg, m) => {
  if (!auth(msg)) return;
  RUNTIME_CONTRACT = m[1];
  bot.sendMessage(msg.chat.id, `OK. Contract runtime: ${RUNTIME_CONTRACT}`);
});

bot.onText(/^\/mint(?:\s+(.+))?$/, async (msg, m) => {
  if (!auth(msg)) return;
  try {
    const inline = parseKvArgs(m[1] || "");

    // override cepat (hanya sesi ini)
    const rpcForRun = inline.rpc || RUNTIME_RPC_URL;
    const contractForRun = inline.contract || RUNTIME_CONTRACT;
    if (inline.func) MINT_FUNC = inline.func;
    if (inline.sig)  MINT_SIG  = inline.sig;
    if (inline.amount) MINT_AMOUNT = toBN(inline.amount);
    if (inline.price)  MINT_PRICE  = ethers.utils.parseEther(String(inline.price));
    if (inline.gasLimit) GAS_LIMIT = toBN(inline.gasLimit);
    if (inline.gasPrice) GAS_PRICE_GWEI = String(inline.gasPrice);
    if (inline.maxFee)   MAX_FEE_GWEI   = String(inline.maxFee);
    if (inline.maxPrio)  MAX_PRIORITY_GWEI = String(inline.maxPrio);
    if (inline.nft) NFT_CONTRACT = inline.nft;
    if (inline.fee) FEE_RECIPIENT = inline.fee;
    if (inline.abi) { try { ABI_OVERRIDE = JSON.parse(inline.abi); } catch { throw new Error("abi harus JSON"); } }
    if (inline.functionArgs) { try { FUNCTION_ARGS = JSON.parse(inline.functionArgs); } catch { throw new Error("functionArgs harus JSON"); } }
    if (inline.waitfor) WAIT_FOR = inline.waitfor.toLowerCase(); // sent|mined

    const provider = new ethers.providers.JsonRpcProvider(rpcForRun);
    const abi = ABI_OVERRIDE;

    bot.sendMessage(msg.chat.id, `⛏️ Minting Project Merlin...\nRPC: ${rpcForRun}\nContract: ${contractForRun}\nWAIT_FOR=${WAIT_FOR} CONCURRENCY=${CONCURRENCY}`);

    const results = [];
    if (MODE === "single") {
      const w = new ethers.Wallet(PRIVATE_KEYS[0], provider);
      const c = new ethers.Contract(contractForRun, abi, w);
      const log = (s) => console.log(`[${w.address}] ${s}`);
      try {
        const rc = await mintOnce(w, c, provider, log, inline);
        results.push({ wallet: w.address, tx: rc.transactionHash });
      } catch (e) {
        results.push({ wallet: w.address, error: e.message || String(e) });
      }
    } else {
      // MULTI + CONCURRENCY
      const keys = PRIVATE_KEYS.slice();
      for (let i = 0; i < keys.length; i += CONCURRENCY) {
        const slice = keys.slice(i, i + CONCURRENCY);
        await Promise.all(slice.map(async (pk, j) => {
          const idx = i + j + 1;
          const w = new ethers.Wallet(pk, provider);
          const c = new ethers.Contract(contractForRun, abi, w);
          const log = (s) => console.log(`[${idx}/${keys.length}] ${w.address} ${s}`);
          try {
            const rc = await mintOnce(w, c, provider, log, inline);
            results.push({ wallet: w.address, tx: rc.transactionHash });
          } catch (e) {
            results.push({ wallet: w.address, error: e.message || String(e) });
          }
        }));
        if (TX_DELAY_MS && i + CONCURRENCY < keys.length) {
          await sleep(TX_DELAY_MS);
        }
      }
    }

    const lines = results.map(r => r.tx
      ? `✅ ${r.wallet}\n   tx: ${r.tx}`
      : `❌ ${r.wallet}\n   err: ${r.error}`);

    const out = (lines.join("\n")) + brandFooterLine();
    bot.sendMessage(msg.chat.id, out, { parse_mode: "HTML", disable_web_page_preview: true });

  } catch (e) {
    bot.sendMessage(msg.chat.id, `Gagal: ${e.message || String(e)}`);
  }
});

/* ========= Mint core ========= */
async function mintOnce(wallet, contract, provider, log, inline) {
  return sendWithRetry(async (fees) => {
    const feeFields = (fees.type === "legacy")
      ? { gasPrice: fees.gasPrice }
      : { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };

    // default value = price * amount
    const overrides = baseOverrides(MINT_AMOUNT, feeFields);

    // 1) MINT_SIG + FUNCTION_ARGS → fleksibel (SeaDrop / non-standar)
    if (MINT_SIG && FUNCTION_ARGS && FUNCTION_ARGS.length > 0) {
      if (typeof contract[MINT_SIG] !== "function") {
        throw new Error(`Signature ${MINT_SIG} tidak ada di ABI (cek ABI_OVERRIDE/MINT_SIG)`);
      }
      const args = materializeArgs(FUNCTION_ARGS, wallet.address, inline) || [];
      return await sendTx(contract[MINT_SIG](...args, overrides), log);
    }

    // 2) Fallback standar: coba (amount) → lalu tanpa argumen (pakai signature lengkap)
    const sigWithAmount = `${MINT_FUNC}(uint256)`;
    const sigNoArg      = `${MINT_FUNC}()`;

    if (typeof contract[sigWithAmount] === "function") {
      return await sendTx(contract[sigWithAmount](MINT_AMOUNT, overrides), log);
    }
    if (typeof contract[sigNoArg] === "function") {
      const singleOverrides = baseOverrides(toBN(1), feeFields);
      return await sendTx(contract[sigNoArg](singleOverrides), log);
    }
    throw new Error(`Fungsi ${MINT_FUNC} tidak ditemukan. Set MINT_SIG+FUNCTION_ARGS_JSON+ABI_OVERRIDE.`);
  }, provider, log);
}

async function sendTx(txPromise, log) {
  const tx = await txPromise;
  log(`Tx sent: ${tx.hash}`);
  if (WAIT_FOR === "sent") {
    return { transactionHash: tx.hash, blockNumber: null };
  }
  const rc = await tx.wait();
  log(`✅ Mined: ${rc.transactionHash} | Block: ${rc.blockNumber}`);
  return rc;
}

async function sendWithRetry(makeTx, provider, log) {
  let attempt = 0;
  let waitMs = RETRY_BACKOFF_MS;
  let fees = await startingFees(provider);

  while (true) {
    try {
      return await makeTx(fees);
    } catch (err) {
      attempt++;
      const msg = err?.message || String(err);
      log(`❌ Attempt ${attempt} failed: ${msg}`);
      if (attempt >= RETRY_ATTEMPTS) throw err;

      // bump fees
      if (fees.type === "legacy") {
        fees = { type: "legacy", gasPrice: bumpLegacy(fees.gasPrice) };
      } else {
        fees = bump1559(fees); fees.type = "eip1559";
      }
      log(`⏳ Retrying in ${waitMs}ms (gas bump)...`);
      await sleep(waitMs);
      waitMs = Math.ceil(waitMs * RETRY_BACKOFF_MULTIPLIER);
    }
  }
}

/* ========= Fees / helpers ========= */
async function startingFees(provider) {
  if (GAS_PRICE_GWEI) {
    return { type: "legacy", gasPrice: addFeeBuffer(ethers.utils.parseUnits(GAS_PRICE_GWEI, "gwei")) };
  }
  if (MAX_FEE_GWEI && MAX_PRIORITY_GWEI) {
    return {
      type: "eip1559",
      maxFeePerGas: addFeeBuffer(ethers.utils.parseUnits(MAX_FEE_GWEI, "gwei")),
      maxPriorityFeePerGas: addFeeBuffer(ethers.utils.parseUnits(MAX_PRIORITY_GWEI, "gwei")),
    };
  }
  
  // Gunakan fungsi optimal gas baru
  return await getOptimalGas(provider);
}

async function getOptimalGas(provider) {
  try {
    // Dapatkan data fee terkini
    const feeData = await provider.getFeeData();
    
    // Jika ada data fee, gunakan dengan buffer 15%
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      return {
        type: "eip1559",
        maxFeePerGas: feeData.maxFeePerGas.mul(115).div(100), // +15%
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(115).div(100) // +15%
      };
    }
    
    // Fallback ke gas price dengan buffer 15%
    if (feeData.gasPrice) {
      return { 
        type: "legacy", 
        gasPrice: feeData.gasPrice.mul(115).div(100) // +15%
      };
    }
    
    // Default jika tidak ada data fee
    return { 
      type: "legacy", 
      gasPrice: ethers.utils.parseUnits("25", "gwei") 
    };
  } catch (error) {
    console.error("Error getting optimal gas:", error);
    // Default jika error
    return { 
      type: "legacy", 
      gasPrice: ethers.utils.parseUnits("30", "gwei") 
    };
  }
}

function baseOverrides(valueMultBN, feeFields) {
  const o = { value: MINT_PRICE.mul(valueMultBN) };
  if (GAS_LIMIT) o.gasLimit = GAS_LIMIT;
  if (feeFields && ("maxFeePerGas" in feeFields || "gasPrice" in feeFields)) Object.assign(o, feeFields);
  return o;
}

function addFeeBuffer(baseFee) {
  return baseFee.mul(110).div(100); // Tambah 10%
}

function bumpLegacy(gp) { 
  return gp.mul(100 + GAS_BUMP_PERCENT).div(100); 
}
function bump1559(f) {
  const n = { ...f };
  n.maxFeePerGas = n.maxFeePerGas.mul(100 + GAS_BUMP_PERCENT).div(100);
  n.maxPriorityFeePerGas = n.maxPriorityFeePerGas.mul(100 + GAS_BUMP_PERCENT).div(100);
  return n;
}

function materializeArgs(raw, walletAddr, inline) {
  if (!raw || !Array.isArray(raw)) return null;
  return raw.map((t) => {
    t = String(t);
    if (t === "AMOUNT") return MINT_AMOUNT;
    if (t === "WALLET") return walletAddr;
    if (t === "NFT_CONTRACT") return NFT_CONTRACT;
    if (t === "FEE_RECIPIENT") return FEE_RECIPIENT;
    if (t === "PROOF_JSON") return PROOF_JSON ?? [];
    if (t === "SIGNATURE") return SIGNATURE || "";
    if (t === "PROOF" && inline?.proof) { try { return JSON.parse(inline.proof); } catch { return []; } }
    if (t === "SIGN" && inline?.signature) return inline.signature;
    return t; // literal
  });
}

/* ========= generic utils ========= */
function parseKvArgs(text) {
  const out = {};
  const re = /(\w+)=("([^"]+)"|'([^']+)'|(\S+))/g;
  let m; while ((m = re.exec(text || "")) !== null) out[m[1]] = m[3] || m[4] || m[5];
  return out;
}
function toBN(x) { return ethers.BigNumber.from(String(x)); }
function envStr(k, d="") { const v = process.env[k]; return (v && v.trim()) ? v.trim() : d; }
function envNum(k, d=0) { const v = process.env[k]; return v ? Number(v) : d; }
function envBNMaybe(k) { const v = process.env[k]; return v ? toBN(v) : undefined; }
function envJSON(k, defVal) { const v = process.env[k]; if (!v) return defVal; try { return JSON.parse(v); } catch { die(`${k} bukan JSON valid`); } }
function envJSONMaybe(k) { const v = process.env[k]; if (!v) return undefined; try { return JSON.parse(v); } catch { die(`${k} bukan JSON valid`); } }
function must(k){ const v = process.env[k]; if (!v) die(`${k} kosong di .env`); return v; }
function die(m){ throw new Error(m); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function auth(msg){ if (ALLOWED.length===0) return true; const ok = ALLOWED.includes(String(msg.chat.id)); if(!ok) bot.sendMessage(msg.chat.id,"Unauthorized."); return ok; }

function readPrivateKeys() {
  const filePath = path.join(__dirname, 'pk.txt');
  if (!fs.existsSync(filePath)) {
    die("pk.txt not found in the same directory as bot.js");
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.startsWith('0x'));
}

console.log("Telegram FCFS/Public bot running. by admin", BRAND_ADMIN_HANDLE, "|", BRAND_CHANNEL_NAME);
