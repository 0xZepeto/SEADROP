// tele-fcfs.js — Telegram minter bot (ENV-only, FCFS/Public – SeaDrop-ready)
// deps: ethers@5, node-telegram-bot-api, dotenv
require("dotenv").config();
const fs = require('fs');
const { ethers } = require("ethers");
const TelegramBot = require("node-telegram-bot-api");

/* ========= Fungsi untuk membaca file eksternal ========= */
function getRpcUrls() {
  try {
    const data = fs.readFileSync('rpc.json', 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error("Gagal membaca rpc.json:", e.message);
    return {};
  }
}

function getNftContract() {
  try {
    const data = fs.readFileSync('contract.txt', 'utf8');
    return data.trim();
  } catch (e) {
    console.error("Gagal membaca contract.txt:", e.message);
    return "";
  }
}

/* ========= ENV ========= */
const BOT_TOKEN = must("TELEGRAM_BOT_TOKEN");
const RPC_URLS = getRpcUrls();
let RUNTIME_RPC_URL = RPC_URLS.base || must("RPC_URL");    // default ke base, atau fallback ke env
let RUNTIME_CONTRACT = must("CONTRACT_ADDRESS");           // bisa diubah via /setcontract

// fungsi & signature (opsional)
let MINT_FUNC = envStr("MINT_FUNC", "mint");
let MINT_SIG  = envStr("MINT_SIG", "");

// ABI (json string) — default sediakan dua kemungkinan (overload)
let ABI_OVERRIDE = envJSON("ABI_OVERRIDE", [
  `function ${MINT_FUNC}(uint256 _count) payable`,
  `function ${MINT_FUNC}() payable`
]);

// Argumen dinamis untuk MINT_SIG (opsional)
// contoh: ["NFT_CONTRACT","FEE_RECIPIENT","WALLET","AMOUNT","PROOF_JSON"]
let FUNCTION_ARGS = envJSON("FUNCTION_ARGS_JSON", []);

// opsi khusus (mis. SeaDrop)
let NFT_CONTRACT  = getNftContract() || envStr("NFT_CONTRACT", "");
let FEE_RECIPIENT = envStr("FEE_RECIPIENT", "");

// data WL
let PROOF_JSON    = envJSONMaybe("PROOF_JSON");  // ["0x...","0x..."]
let SIGNATURE     = envStr("SIGNATURE", "");

// mode & keys
const MODE = envStr("MODE", "multi").toLowerCase();  // single|multi

// Baca private keys dari file pk.txt
const PRIVATE_KEYS = fs.readFileSync('pk.txt', 'utf8')
  .split('\n')
  .map(line => line.trim())
  .filter(line => line.length > 0);

if (PRIVATE_KEYS.length === 0) die("PRIVATE_KEYS kosong di pk.txt (satu private key per baris)");

// FCFS knobs
let WAIT_FOR = envStr("WAIT_FOR", "mined").toLowerCase();   // "sent" | "mined"
const CONCURRENCY = envNum("CONCURRENCY", 1);               // paralel wallet per batch
const TX_DELAY_MS = envNum("TX_DELAY_MS", 0);               // jeda antar batch

// mint params
let MINT_AMOUNT = toBN(envStr("MINT_AMOUNT", "5")); // Default 5 (max)
let MINT_PRICE  = ethers.utils.parseEther(envStr("MINT_PRICE", "0"));
let GAS_LIMIT   = envBNMaybe("GAS_LIMIT"); // optional BigNumber

// gas strategy
let GAS_PRICE_GWEI     = envStr("GAS_PRICE_GWEI", "");     // legacy (opsional)
let MAX_FEE_GWEI       = envStr("MAX_FEE_GWEI", "");       // 1559 manual (opsional)
let MAX_PRIORITY_GWEI  = envStr("MAX_PRIORITY_GWEI", "");

// retry/backoff
const RETRY_ATTEMPTS           = envNum("RETRY_ATTEMPTS", 5);
const RETRY_BACKOFF_MS         = envNum("RETRY_BACKOFF_MS", 700);
const RETRY_BACKOFF_MULTIPLIER = envNum("RETRY_BACKOFF_MULTIPLIER", 1.5);
const GAS_BUMP_PERCENT         = envNum("GAS_BUMP_PERCENT", 25);

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
  console.log(`${bold}${cyan}🚀 Telegram FCFS/Public Minter — SeaDrop mintPublic${reset}`);
  console.log(`${mag}by admin ${BRAND_ADMIN_HANDLE} • ${BRAND_CHANNEL_NAME}${reset}`);
  console.log(`${yel}${BRAND_CHANNEL_URL}${reset}`);
  console.log(line + "\n");
}
function brandCaption() {
  return [
    `👤 <b>Admin:</b> ${BRAND_ADMIN_HANDLE}`,
    `🛰️ <b>Brand:</b> ${BRAND_CHANNEL_NAME}`,
    `🔗 <b>Channel:</b> <a href="${BRAND_CHANNEL_URL}">${BRAND_CHANNEL_URL}</a>`
  ].join("\n");
}
function brandFooterLine() {
  return `\n— <b>${BRAND_CHANNEL_NAME}</b> • Admin <b>${BRAND_ADMIN_HANDLE}</b> — <a href="${BRAND_CHANNEL_URL}">join</a>`;
}

/* ========= Telegram ========= */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
showBanner();

// Perintah /start
bot.onText(/^\/start$/, (msg) => {
  if (!auth(msg)) return;
  const text = [
    `🚀 <b>Bot FCFS/Public Minter Siap!</b>`,
    ``,
    `📋 <b>Perintah Utama:</b>`,
    `• /status — Lihat status bot`,
    `• /mint — Eksekusi mint`,
    `• /quickmint — Mint cepat`,
    ``,
    `🌐 <b>Manajemen Jaringan:</b>`,
    `• /listchain — Daftar jaringan`,
    `• /chain — Info jaringan aktif`,
    `• /network — Ganti jaringan`,
    ``,
    `📄 <b>Manajemen Kontrak:</b>`,
    `• /setnftcontract — Ganti NFT contract`,
    ``,
    `⚙️ <b>Utilitas:</b>`,
    `• /estimate — Estimasi biaya`,
    `• /setgas — Atur gas`,
    `• /balance — Cek saldo`,
    `• /pending — Cek transaksi`,
    ``,
    `🤖 <b>Identitas:</b>`,
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

// Perintah /status
bot.onText(/^\/status$/, async (msg) => {
  if (!auth(msg)) return;
  const prov = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
  let net;
  try { net = await prov.getNetwork(); } catch (e) { net = { chainId: "?", name: "?" }; }
  
  const statusText = [
    `📊 <b>Status Bot</b>`,
    ``,
    `🔗 <b>RPC:</b> ${RUNTIME_RPC_URL}`,
    `🌐 <b>Chain:</b> ${net.name} (${net.chainId})`,
    `📄 <b>Contract:</b> <code>${RUNTIME_CONTRACT}</code>`,
    `🖼️ <b>NFT Contract:</b> <code>${NFT_CONTRACT}</code>`,
    `⚙️ <b>Func:</b> ${MINT_FUNC} | <b>Sig:</b> ${MINT_SIG || "-"}`,
    `👥 <b>Mode:</b> ${MODE} | <b>Keys:</b> ${PRIVATE_KEYS.length}`,
    `⏱️ <b>WAIT_FOR:</b> ${WAIT_FOR} | <b>CONCURRENCY:</b> ${CONCURRENCY}`,
    `💰 <b>Amount:</b> ${MINT_AMOUNT.toString()} | <b>Price:</b> ${ethers.utils.formatEther(MINT_PRICE)} ETH`,
    `⛽ <b>GasLimit:</b> ${GAS_LIMIT ? GAS_LIMIT.toString() : "-"}`,
    `💨 <b>gasPrice:</b> ${GAS_PRICE_GWEI || "-"} | <b>maxFee:</b> ${MAX_FEE_GWEI || "-"} | <b>maxPrio:</b> ${MAX_PRIORITY_GWEI || "-"}`
  ].join("\n");

  bot.sendMessage(msg.chat.id, statusText, { parse_mode: "HTML" });
});

// Perintah /listchain
bot.onText(/^\/listchain$/, (msg) => {
  if (!auth(msg)) return;
  const rpcUrls = getRpcUrls();
  const networks = Object.keys(rpcUrls).map(net => `🌐 <b>${net}:</b> ${rpcUrls[net]}`).join('\n');
  bot.sendMessage(msg.chat.id, `🌐 <b>Daftar Jaringan Tersedia</b>\n\n${networks}`, { parse_mode: "HTML" });
});

// Perintah /chain
bot.onText(/^\/chain$/, async (msg) => {
  if (!auth(msg)) return;
  try {
    const provider = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    const net = await provider.getNetwork();
    const chainText = [
      `🌐 <b>Informasi Jaringan Aktif</b>`,
      ``,
      `📝 <b>Nama:</b> ${net.name}`,
      `🔢 <b>Chain ID:</b> ${net.chainId}`,
      `🔗 <b>RPC:</b> <code>${RUNTIME_RPC_URL}</code>`,
      ``,
      `📄 <b>Kontrak Mint:</b> <code>${RUNTIME_CONTRACT}</code>`,
      `🖼️ <b>Kontrak NFT:</b> <code>${NFT_CONTRACT}</code>`
    ].join("\n");

    bot.sendMessage(msg.chat.id, chainText, { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal mendapatkan info jaringan: ${e.message || String(e)}`);
  }
});

// Perintah /estimate
bot.onText(/^\/estimate$/, async (msg) => {
  if (!auth(msg)) return;
  try {
    const provider = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEYS[0], provider);
    const contract = new ethers.Contract(RUNTIME_CONTRACT, ABI_OVERRIDE, wallet);
    
    const feeFields = await startingFees(provider);
    const overrides = baseOverrides(MINT_AMOUNT, feeFields);
    
    let estimate;
    if (MINT_SIG && FUNCTION_ARGS && FUNCTION_ARGS.length > 0) {
      const args = materializeArgs(FUNCTION_ARGS, wallet.address, {}) || [];
      estimate = await contract.estimateGas[MINT_SIG](...args, overrides);
    } else {
      const sigWithAmount = `${MINT_FUNC}(uint256)`;
      estimate = await contract.estimateGas[sigWithAmount](MINT_AMOUNT, overrides);
    }
    
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.utils.parseUnits("20", "gwei");
    const totalCost = estimate.mul(gasPrice);
    
    const estimateText = [
      `⛽ <b>Estimasi Biaya Transaksi</b>`,
      ``,
      `📊 <b>Gas Limit:</b> ${estimate.toString()}`,
      `💰 <b>Gas Price:</b> ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`,
      ``,
      `💸 <b>Total Biaya Gas:</b> ${ethers.utils.formatEther(totalCost)} ETH`,
      `🎨 <b>Biaya NFT:</b> ${ethers.utils.formatEther(MINT_PRICE.mul(MINT_AMOUNT))} ETH`,
      ``,
      `💎 <b>Total Estimasi:</b> ${ethers.utils.formatEther(totalCost.add(MINT_PRICE.mul(MINT_AMOUNT)))} ETH`
    ].join("\n");
    
    bot.sendMessage(msg.chat.id, estimateText, { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal estimasi: ${e.message || String(e)}`);
  }
});

// Perintah /quickmint
bot.onText(/^\/quickmint\s+(\d+)$/, async (msg, match) => {
  if (!auth(msg)) return;
  const amount = match[1];
  
  try {
    const inline = { amount };
    const provider = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    const abi = ABI_OVERRIDE;

    bot.sendMessage(msg.chat.id, `⚡ <b>Quick Minting ${amount} NFT...</b>`, { parse_mode: "HTML" });

    const results = [];
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const w = new ethers.Wallet(PRIVATE_KEYS[i], provider);
      const c = new ethers.Contract(RUNTIME_CONTRACT, abi, w);
      const log = (s) => console.log(`[${i+1}/${PRIVATE_KEYS.length}] ${w.address} ${s}`);
      
      try {
        const rc = await mintOnce(w, c, provider, log, inline);
        results.push({ wallet: w.address, tx: rc.transactionHash });
      } catch (e) {
        results.push({ wallet: w.address, error: e.message || String(e) });
      }
    }

    const successResults = results.filter(r => r.tx);
    const failedResults = results.filter(r => r.error);
    
    let message = `📊 <b>Hasil Quick Mint (${amount} NFT)</b>\n\n`;
    message += `✅ <b>Berhasil:</b> ${successResults.length}\n`;
    successResults.forEach((r, i) => {
      message += `${i+1}. ${r.wallet.substring(0, 8)}...: ${r.tx.substring(0, 10)}...\n`;
    });
    
    message += `\n❌ <b>Gagal:</b> ${failedResults.length}\n`;
    failedResults.forEach((r, i) => {
      const shortError = r.error.length > 50 ? r.error.substring(0, 50) + "..." : r.error;
      message += `${i+1}. ${r.wallet.substring(0, 8)}...: ${shortError}\n`;
    });

    bot.sendMessage(msg.chat.id, message + brandFooterLine(), { 
      parse_mode: "HTML", 
      disable_web_page_preview: true 
    });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${e.message || String(e)}`);
  }
});

// Perintah /setgas
bot.onText(/^\/setgas\s+(\S+)\s+(\S+)$/, (msg, match) => {
  if (!auth(msg)) return;
  const maxFee = match[1];
  const maxPrio = match[2];
  
  MAX_FEE_GWEI = maxFee;
  MAX_PRIORITY_GWEI = maxPrio;
  
  bot.sendMessage(msg.chat.id, `⚙️ <b>Pengaturan Gas Diperbarui</b>\n\n💨 Max Fee: ${maxFee} gwei\n🚀 Max Priority: ${maxPrio} gwei`, { parse_mode: "HTML" });
});

// Perintah /setnftcontract
bot.onText(/^\/setnftcontract\s+(0x[a-fA-F0-9]{40})$/, (msg, match) => {
  if (!auth(msg)) return;
  const newContract = match[1];
  try {
    fs.writeFileSync('contract.txt', newContract, 'utf8');
    NFT_CONTRACT = newContract;
    bot.sendMessage(msg.chat.id, `📝 <b>Kontrak NFT Diperbarui</b>\n\n🖼️ Kontrak Baru: <code>${newContract}</code>`, { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal mengubah NFT Contract: ${e.message}`);
  }
});

// Perintah /network
bot.onText(/^\/network\s+(\w+)$/, async (msg, match) => {
  if (!auth(msg)) return;
  const networkName = match[1].toLowerCase();
  const rpcUrls = getRpcUrls();
  
  if (rpcUrls[networkName]) {
    RUNTIME_RPC_URL = rpcUrls[networkName];
    // Test RPC
    try {
      const tmp = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
      const net = await tmp.getNetwork();
      bot.sendMessage(msg.chat.id, `🌐 <b>Jaringan Diubah</b>\n\n📝 Nama: ${networkName}\n🔗 RPC: ${RUNTIME_RPC_URL}\n🔢 Chain: ${net.name} (${net.chainId})`, { parse_mode: "HTML" });
    } catch (e) {
      bot.sendMessage(msg.chat.id, `⚠️ <b>Jaringan Diubah</b>\n\n📝 Nama: ${networkName}\n🔗 RPC: ${RUNTIME_RPC_URL}\n❌ Tapi detect gagal: ${e.message || e}`, { parse_mode: "HTML" });
    }
  } else {
    bot.sendMessage(msg.chat.id, `❌ Jaringan "${networkName}" tidak ditemukan.\n\n📋 Jaringan tersedia: ${Object.keys(rpcUrls).join(', ')}`);
  }
});

// Perintah /balance
bot.onText(/^\/balance$/, async (msg) => {
  if (!auth(msg)) return;
  try {
    const provider = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    let balanceText = "💰 <b>Saldo Wallet</b>\n\n";
    
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const wallet = new ethers.Wallet(PRIVATE_KEYS[i], provider);
      const balance = await wallet.getBalance();
      balanceText += `${i+1}. <code>${wallet.address.substring(0, 8)}...</code>: ${ethers.utils.formatEther(balance)} ETH\n`;
    }
    
    bot.sendMessage(msg.chat.id, balanceText, { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal mendapatkan saldo: ${e.message || String(e)}`);
  }
});

// Perintah /pending
bot.onText(/^\/pending$/, async (msg) => {
  if (!auth(msg)) return;
  try {
    const provider = new ethers.providers.JsonRpcProvider(RUNTIME_RPC_URL);
    let pendingText = "⏳ <b>Transaksi Pending</b>\n\n";
    
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const wallet = new ethers.Wallet(PRIVATE_KEYS[i], provider);
      const nonce = await wallet.getTransactionCount();
      const pendingCount = await provider.getTransactionCount(wallet.address, "pending");
      
      if (pendingCount > nonce) {
        pendingText += `${i+1}. <code>${wallet.address.substring(0, 8)}...</code>: ${pendingCount - nonce} tx pending\n`;
      }
    }
    
    if (pendingText === "⏳ <b>Transaksi Pending</b>\n\n") {
      pendingText += "✅ Tidak ada transaksi pending";
    }
    
    bot.sendMessage(msg.chat.id, pendingText, { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal cek pending: ${e.message || String(e)}`);
  }
});

// Perintah /mint
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
    if (inline.nft) {
      NFT_CONTRACT = inline.nft;
      // Simpan ke file contract.txt
      try {
        fs.writeFileSync('contract.txt', inline.nft, 'utf8');
      } catch (e) {
        console.error("Gagal menyimpan NFT contract ke file:", e.message);
      }
    }
    if (inline.fee) FEE_RECIPIENT = inline.fee;
    if (inline.abi) { try { ABI_OVERRIDE = JSON.parse(inline.abi); } catch { throw new Error("abi harus JSON"); } }
    if (inline.functionArgs) { try { FUNCTION_ARGS = JSON.parse(inline.functionArgs); } catch { throw new Error("functionArgs harus JSON"); } }
    if (inline.waitfor) WAIT_FOR = inline.waitfor.toLowerCase(); // sent|mined

    const provider = new ethers.providers.JsonRpcProvider(rpcForRun);
    const abi = ABI_OVERRIDE;

    bot.sendMessage(msg.chat.id, `⛏️ <b>Minting...</b>\n🔗 RPC: ${rpcForRun}\n📄 Contract: ${contractForRun}\n🖼️ NFT: ${NFT_CONTRACT}\n⏱️ WAIT_FOR=${WAIT_FOR} CONCURRENCY=${CONCURRENCY}`, { parse_mode: "HTML" });

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

    // Format hasil yang lebih ringkas
    const successResults = results.filter(r => r.tx);
    const failedResults = results.filter(r => r.error);
    
    let message = `📊 <b>Hasil Mint</b>\n\n`;
    message += `✅ <b>Berhasil:</b> ${successResults.length}\n`;
    successResults.forEach((r, i) => {
      message += `${i+1}. ${r.wallet.substring(0, 8)}...: ${r.tx.substring(0, 10)}...\n`;
    });
    
    message += `\n❌ <b>Gagal:</b> ${failedResults.length}\n`;
    failedResults.forEach((r, i) => {
      const shortError = r.error.length > 50 ? r.error.substring(0, 50) + "..." : r.error;
      message += `${i+1}. ${r.wallet.substring(0, 8)}...: ${shortError}\n`;
    });

    const out = message + brandFooterLine();
    bot.sendMessage(msg.chat.id, out, { 
      parse_mode: "HTML", 
      disable_web_page_preview: true 
    });

  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${e.message || String(e)}`);
  }
});

/* ========= Mint core ========= */
async function getNextNonce(wallet) {
  try {
    return await wallet.getTransactionCount();
  } catch (e) {
    console.log("Gagal mendapatkan nonce:", e.message);
    return null;
  }
}

async function mintOnce(wallet, contract, provider, log, inline) {
  // Cek saldo terlebih dahulu
  const balance = await wallet.getBalance();
  const minValue = MINT_PRICE.mul(MINT_AMOUNT);
  const minGas = ethers.utils.parseUnits("0.000001", "ether"); // Estimasi minimal gas
  const minRequired = minValue.add(minGas);
  
  if (balance.lt(minRequired)) {
    throw new Error(`Saldo tidak cukup. Minimal: ${ethers.utils.formatEther(minRequired)} ETH, Tersedia: ${ethers.utils.formatEther(balance)} ETH`);
  }

  // Dapatkan nonce saat ini
  const nonce = await getNextNonce(wallet);
  if (nonce === null) {
    throw new Error("Gagal mendapatkan nonce");
  }

  return sendWithRetry(async (fees) => {
    const feeFields = (fees.type === "legacy")
      ? { gasPrice: fees.gasPrice, nonce: nonce }
      : { 
          maxFeePerGas: fees.maxFeePerGas, 
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          nonce: nonce
        };

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
    return { type: "legacy", gasPrice: ethers.utils.parseUnits(GAS_PRICE_GWEI, "gwei") };
  }
  if (MAX_FEE_GWEI && MAX_PRIORITY_GWEI) {
    return {
      type: "eip1559",
      maxFeePerGas: ethers.utils.parseUnits(MAX_FEE_GWEI, "gwei"),
      maxPriorityFeePerGas: ethers.utils.parseUnits(MAX_PRIORITY_GWEI, "gwei"),
    };
  }
  const f = await provider.getFeeData();
  if (f.maxFeePerGas && f.maxPriorityFeePerGas) {
    return { type: "eip1559", maxFeePerGas: f.maxFeePerGas, maxPriorityFeePerGas: f.maxPriorityFeePerGas };
  }
  return { type: "legacy", gasPrice: f.gasPrice || ethers.utils.parseUnits("20", "gwei") };
}

function baseOverrides(valueMultBN, feeFields) {
  const o = { value: MINT_PRICE.mul(valueMultBN) };
  if (GAS_LIMIT) o.gasLimit = GAS_LIMIT;
  if (feeFields && ("maxFeePerGas" in feeFields || "gasPrice" in feeFields)) Object.assign(o, feeFields);
  return o;
}

function bumpLegacy(gp) { return gp.mul(100 + GAS_BUMP_PERCENT).div(100); }
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

console.log("Telegram FCFS/Public bot running. by admin", BRAND_ADMIN_HANDLE, "|", BRAND_CHANNEL_NAME);
