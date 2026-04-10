import { Telegraf, session, Markup } from "telegraf";
import { message } from "telegraf/filters";
import { WhatsAppBulkCheckerEngine } from "./whatsapp-bulk-checker"; // path ke engine Anda
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ==================== KONFIGURASI ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID) : 0];

const engine = new WhatsAppBulkCheckerEngine();
const GLOBAL_SESSION_ID = "panorama_global_sender";
let globalSessionReady = false;

// ==================== STORAGE SEDERHANA (JSON) ====================
const DATA_DIR = path.join(process.cwd(), "panorama_data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

interface PanoramaUser {
  userId: number;
  username?: string;
  firstName?: string;
  tier: "free" | "vip";
  createdAt: string;
  bots: PanoramaBot[];
  lastMode: "user" | "global" | null;
}

interface PanoramaBot {
  id: string;
  phoneNumber: string;
  isActive: boolean;
  addedAt: string;
}

interface CheckHistoryItem {
  id: string;
  userId: number;
  mode: "user" | "global";
  botPhone?: string;
  timestamp: string;
  totalNumbers: number;
  registeredCount: number;
  unregisteredCount: number;
  businessCount: number;
  regularCount: number;
  metaVerifiedCount: number;
  obaCount: number;
  durationMs: number;
  registeredNumbers: string[];   // untuk export cepat
  fullResult?: any;               // optional: simpan full JSON jika perlu
}

// Helper load/save
function loadUsers(): Map<number, PanoramaUser> {
  if (!fs.existsSync(USERS_FILE)) return new Map();
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  const map = new Map<number, PanoramaUser>();
  for (const [k, v] of Object.entries(data)) map.set(Number(k), v as PanoramaUser);
  return map;
}
function saveUsers(users: Map<number, PanoramaUser>) {
  const obj: Record<number, PanoramaUser> = {};
  for (const [k, v] of users.entries()) obj[k] = v;
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}
function getUser(userId: number): PanoramaUser | undefined {
  return loadUsers().get(userId);
}
function saveUser(user: PanoramaUser) {
  const users = loadUsers();
  users.set(user.userId, user);
  saveUsers(users);
}
function addBotToUser(userId: number, bot: PanoramaBot) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  if (user.bots.find(b => b.phoneNumber === bot.phoneNumber)) throw new Error("Bot already exists");
  user.bots.push(bot);
  saveUser(user);
}
function removeBotFromUser(userId: number, botId: string) {
  const user = getUser(userId);
  if (user) {
    user.bots = user.bots.filter(b => b.id !== botId);
    saveUser(user);
  }
}
function loadHistory(): CheckHistoryItem[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
}
function saveHistory(history: CheckHistoryItem[]) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
function addHistoryItem(item: CheckHistoryItem) {
  const history = loadHistory();
  history.unshift(item);
  saveHistory(history);
}
function getUserHistory(userId: number, limit = 10): CheckHistoryItem[] {
  return loadHistory().filter(h => h.userId === userId).slice(0, limit);
}

// ==================== UTILITY ====================
function formatNumber(num: number): string {
  return num.toLocaleString("id-ID");
}
function sanitizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}
function parseNumbersFromText(text: string): string[] {
  const parts = text.split(/[\n, ]+/);
  const numbers: string[] = [];
  for (const p of parts) {
    const clean = sanitizePhone(p);
    if (clean.length >= 8 && clean.match(/^\d+$/)) numbers.push(clean);
  }
  return numbers;
}

// ==================== FUNGSI SUMMARY & EXPORT (DIPERBAIKI) ====================
function generateSummaryText(result: any, mode: string, botPhone?: string): string {
  const stats = result;
  const meta = stats.meta;
  const durationSec = (meta.duration_ms / 1000).toFixed(1);
  
  let text = `📊 *RINGKASAN HASIL CEK BIO* 📊\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `ℹ️ *INFO LAPORAN:*\n`;
  text += `▫️ Mode: ${mode === "user" ? "User (Pribadi)" : "Global (Owner)"}\n`;
  if (botPhone) text += `▫️ Bot: \`${botPhone}\`\n`;
  text += `▫️ Durasi: *${durationSec} detik*\n\n`;
  
  text += `📈 *STATISTIK NOMOR:*\n`;
  text += `▫️ Total dicek: *${stats.total_checked}*\n`;
  text += `▫️ Terdaftar WA: *${stats.registered_count}*\n`;
  text += `▫️ Tidak terdaftar: *${stats.unregistered_count}*\n\n`;
  
  text += `📱 *DETAIL JENIS AKUN:*\n`;
  text += `▫️ Messenger: *${stats.regular_account_count}*\n`;
  text += `▫️ Business: *${stats.business_account_count}*\n`;
  text += `▫️ Meta Verified: *${stats.meta_verified_count}*\n`;
  text += `▫️ Official (OBA): *${stats.oba_count}*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `_Gunakan tombol di bawah untuk detail lengkap_`;
  return text;
}

async function createExcelBuffer(registeredNumbers: string[], historyId: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Hasil Cek Bio");
  sheet.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "Phone Number", key: "phone", width: 20 },
  ];
  registeredNumbers.forEach((num, idx) => {
    sheet.addRow({ no: idx + 1, phone: num });
  });
  return (await workbook.xlsx.writeBuffer()) as Buffer;
}

// ==================== INISIALISASI GLOBAL SESSION ====================
async function initGlobalSession() {
  try {
    const existing = engine.getSessionPairingInfo(GLOBAL_SESSION_ID);
    if (existing && existing.isConnected) {
      globalSessionReady = true;
      console.log("✅ Global session ready");
      return;
    }
    const sessionPath = path.join(process.cwd(), "sessions", GLOBAL_SESSION_ID);
    const hasCreds = fs.existsSync(path.join(sessionPath, "creds.json"));
    if (hasCreds) {
      await engine.createSession(
        { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Panorama Global" },
        {}
      );
      globalSessionReady = true;
      console.log("✅ Global session restored");
    } else {
      console.warn("⚠️ Global session not found. Use /globallogin as admin");
    }
  } catch (err) {
    console.error("Global session init failed", err);
  }
}

// ==================== BOT TELEGRAM ====================
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Keyboard utama
const mainMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📱 Cek Bio", "menu_cek_bio")],
  [Markup.button.callback("🤖 Daftar Bot", "menu_daftar_bot")],
  [Markup.button.callback("📜 Riwayat", "menu_riwayat")],
  [Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot")],
]);

// Start
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = getUser(userId);
  if (!user) {
    user = {
      userId,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      tier: "free",
      createdAt: new Date().toISOString(),
      bots: [],
      lastMode: null,
    };
    saveUser(user);
  }
  const totalUsers = loadUsers().size;
  await ctx.reply(
    `🔰 *PANORAMA CEK BIO* 🔰\n${formatNumber(2674)} monthly users\n\n` +
    `*WELCOME TO PANORAMA CEK BIO BOT*\n\n` +
    `*PROFIL USER*\n- Nama: ${user.firstName || user.username || userId}\n- Userid: ${userId}\n- Username: @${ctx.from.username || "-"}\n- Status: ${user.tier === "vip" ? "VIP TIER" : "FREE TIER"}\n\n` +
    `*STATISTIK USER*\n- Total bot: ${user.bots.length}\n- Total cek bio: ${getUserHistory(userId).length}x\n- Total nomor dicek: ${getUserHistory(userId).reduce((s, h) => s + h.totalNumbers, 0)}\n\n` +
    `*STATISTIK GLOBAL*\n- Total user: ${totalUsers}\n- Total bot: ${Array.from(loadUsers().values()).reduce((s, u) => s + u.bots.length, 0)}\n- Total cek bio: 80.574x\n- Total nomor dicek: ${formatNumber(49245554)}`,
    { parse_mode: "Markdown", ...mainMenuKeyboard }
  );
});

// Menu Cek Bio -> pilih mode
bot.action("menu_cek_bio", async (ctx) => {
  await ctx.editMessageText(
    "*Pilihan Mode Cek Bio WhatsApp*\n\n1. *SENDER USER (PRIBADI)*\n   - Menggunakan bot WhatsApp milik User.\n   - Jumlah nomor lebih banyak & cepat.\n\n2. *SENDER GLOBAL (OWNER)*\n   - Langsung pakai tanpa setup.\n   - Maks 10 nomor / permintaan.\n\nPilih mode:",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("👤 SENDER USER", "mode_user")],
      [Markup.button.callback("🌍 SENDER GLOBAL", "mode_global")],
      [Markup.button.callback("🔙 Kembali", "back_main")]
    ]) }
  );
});

// Mode USER
bot.action("mode_user", async (ctx) => {
  const userId = ctx.from.id;
  const user = getUser(userId);
  if (!user || user.bots.length === 0) {
    await ctx.answerCbQuery("Belum punya bot. Tambah dulu via menu.");
    await ctx.editMessageText(
      "❌ Tidak ada bot terdaftar.",
      Markup.inlineKeyboard([Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot"), Markup.button.callback("🔙 Kembali", "back_main")])
    );
    return;
  }
  if (user.bots.length === 1) {
    const bot = user.bots[0];
    await startUserMode(ctx, userId, bot);
  } else {
    const buttons = user.bots.map(b => Markup.button.callback(`${b.phoneNumber}`, `select_bot_${b.id}`));
    buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
    await ctx.editMessageText("Pilih bot yang akan digunakan:", Markup.inlineKeyboard(buttons, { columns: 1 }));
  }
});

bot.action(/select_bot_(.+)/, async (ctx, match) => {
  const botId = match[1];
  const userId = ctx.from.id;
  const user = getUser(userId);
  const bot = user?.bots.find(b => b.id === botId);
  if (bot) await startUserMode(ctx, userId, bot);
  else await ctx.answerCbQuery("Bot tidak ditemukan");
});

async function startUserMode(ctx: any, userId: number, bot: PanoramaBot) {
  const sessionInfo = engine.getSessionPairingInfo(bot.id);
  if (!sessionInfo || !sessionInfo.isConnected) {
    await ctx.editMessageText(
      `❌ Bot ${bot.phoneNumber} tidak terhubung.\nSilakan tambah ulang.`,
      Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")])
    );
    return;
  }
  ctx.session = ctx.session || {};
  ctx.session.pendingCheck = {
    mode: "user",
    botId: bot.id,
    botPhone: bot.phoneNumber,
  };
  await ctx.editMessageText(
    `🔹 *MODE SENDER USER (PRIBADI)*\n\n- Status: FREE TIER\n- Maks Cek: 100 nomor/cek\n- Speed: Standard\n\nKirim daftar nomor (pisah koma/spasi/baris baru) atau kirim file .txt`,
    { parse_mode: "Markdown" }
  );
}

// Mode GLOBAL
bot.action("mode_global", async (ctx) => {
  if (!globalSessionReady) {
    await ctx.answerCbQuery("Global sender tidak tersedia");
    await ctx.editMessageText("❌ Sender global offline. Hubungi admin.", Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]));
    return;
  }
  ctx.session = ctx.session || {};
  ctx.session.pendingCheck = {
    mode: "global",
    botId: GLOBAL_SESSION_ID,
  };
  await ctx.editMessageText(
    "🌍 *MODE SENDER GLOBAL*\n⚠️ Maks 10 nomor / permintaan.\nKirim daftar nomor (maks 10):",
    { parse_mode: "Markdown" }
  );
});

// Daftar Bot
bot.action("menu_daftar_bot", async (ctx) => {
  const userId = ctx.from.id;
  const user = getUser(userId);
  if (!user || user.bots.length === 0) {
    await ctx.editMessageText("📭 *Daftar Bot*\nTotal: 0\n\nBelum ada bot.", { parse_mode: "Markdown", ...Markup.inlineKeyboard([Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot"), Markup.button.callback("🔙 Kembali", "back_main")]) });
    return;
  }
  let text = `📱 *DAFTAR BOT USER*\nTotal: ${user.bots.length}\nAktif: ${user.bots.filter(b => engine.getSessionPairingInfo(b.id)?.isConnected).length}\n\n`;
  const buttons = [];
  for (const bot of user.bots) {
    const isConnected = engine.getSessionPairingInfo(bot.id)?.isConnected;
    text += `• ${bot.phoneNumber} ${isConnected ? "✅" : "❌"}\n`;
    buttons.push(Markup.button.callback(bot.phoneNumber, `detail_bot_${bot.id}`));
  }
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText(text, Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/detail_bot_(.+)/, async (ctx, match) => {
  const botId = match[1];
  const userId = ctx.from.id;
  const user = getUser(userId);
  const bot = user?.bots.find(b => b.id === botId);
  if (!bot) return ctx.answerCbQuery("Bot tidak ada");
  const info = engine.getSessionPairingInfo(bot.id);
  const connected = info?.isConnected || false;
  const registered = info?.isRegistered || false;
  await ctx.editMessageText(
    `🔍 *Detail Bot*\n📱 ${bot.phoneNumber}\n✅ Koneksi: ${connected ? "Tersambung" : "Putus"}\n📝 Registrasi: ${registered ? "Terdaftar" : "Belum login"}\n📅 Ditambahkan: ${new Date(bot.addedAt).toLocaleString()}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🗑 Hapus Bot", `delete_bot_${bot.id}`)],
      [Markup.button.callback("🔄 Restart Bot", `restart_bot_${bot.id}`)],
      [Markup.button.callback("🔙 Kembali", "menu_daftar_bot")]
    ])
  );
});

bot.action(/delete_bot_(.+)/, async (ctx, match) => {
  const botId = match[1];
  const userId = ctx.from.id;
  await engine.deleteSession(botId).catch(console.error);
  removeBotFromUser(userId, botId);
  await ctx.answerCbQuery("Bot dihapus");
  await ctx.editMessageText("✅ Bot dihapus.", Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "menu_daftar_bot")]));
});

bot.action(/restart_bot_(.+)/, async (ctx, match) => {
  const botId = match[1];
  const userId = ctx.from.id;
  const user = getUser(userId);
  const bot = user?.bots.find(b => b.id === botId);
  if (bot) {
    await engine.restartSession(botId, { phoneNumber: bot.phoneNumber, onPairingCode: async (sid, code) => {
      await ctx.telegram.sendMessage(userId, `🔐 Kode pairing untuk ${bot.phoneNumber}:\n\`${code}\``, { parse_mode: "Markdown" });
    }});
    await ctx.answerCbQuery("Restart dimulai");
  }
  await ctx.editMessageText("Memulai ulang session...", Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "menu_daftar_bot")]));
});

// Riwayat
bot.action("menu_riwayat", async (ctx) => {
  const userId = ctx.from.id;
  const history = getUserHistory(userId, 10);
  if (history.length === 0) {
    await ctx.editMessageText("📭 *RIWAYAT*\nBelum ada riwayat.", { parse_mode: "Markdown", ...Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]) });
    return;
  }
  let text = "📜 *RIWAYAT CEK BIO*\nKlik untuk download:\n\n";
  const buttons = [];
  for (let i = 0; i < history.length; i++) {
    const h = history[i];
    const date = new Date(h.timestamp).toLocaleString("id");
    text += `${i+1}. ${date} - ${h.totalNumbers} nomor\n`;
    buttons.push(Markup.button.callback(`${i+1}. ${date.substring(0,16)}`, `detail_history_${h.id}`));
  }
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText(text, Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/detail_history_(.+)/, async (ctx, match) => {
  const historyId = match[1];
  const userId = ctx.from.id;
  const history = getUserHistory(userId, 100);
  const item = history.find(h => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Riwayat tidak ditemukan");
  await ctx.editMessageText(
    `📋 *Detail Cek Bio*\nID: ${item.id}\nWaktu: ${new Date(item.timestamp).toLocaleString()}\nMode: ${item.mode}\nTotal: ${item.totalNumbers}\nTerdaftar: ${item.registeredCount}\nBusiness: ${item.businessCount}\nMeta Verified: ${item.metaVerifiedCount}\nOBA: ${item.obaCount}\n\nNomor terdaftar:\n${item.registeredNumbers.slice(0, 20).join("\n")}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📄 Download TXT", `dl_txt_${item.id}`)],
      [Markup.button.callback("📊 Download Excel", `dl_xlsx_${item.id}`)],
      [Markup.button.callback("🔙 Kembali", "menu_riwayat")]
    ])
  );
});

// Download TXT
bot.action(/dl_txt_(.+)/, async (ctx, match) => {
  const historyId = match[1];
  const userId = ctx.from.id;
  const item = getUserHistory(userId, 100).find(h => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Data tidak ada");
  const content = `Laporan Cek Bio\nID: ${item.id}\nWaktu: ${item.timestamp}\n\nDAFTAR NOMOR TERDAFTAR:\n${item.registeredNumbers.join("\n")}`;
  const buffer = Buffer.from(content, "utf-8");
  await ctx.replyWithDocument({ source: buffer, filename: `cek_bio_${item.id}.txt` });
});

// Download Excel (XLSX) - menggunakan fungsi createExcelBuffer
bot.action(/dl_xlsx_(.+)/, async (ctx, match) => {
  const historyId = match[1];
  const userId = ctx.from.id;
  const item = getUserHistory(userId, 100).find(h => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Data tidak ada");
  const buffer = await createExcelBuffer(item.registeredNumbers, item.id);
  await ctx.replyWithDocument({ source: buffer, filename: `hasil_${item.id}.xlsx` });
});

// Tambah Bot
bot.action("menu_tambah_bot", async (ctx) => {
  ctx.session = ctx.session || {};
  ctx.session.waitingForBotNumber = true;
  await ctx.editMessageText(
    "➕ *TAMBAH BOT USER*\nKirim nomor WhatsApp (contoh: 6281234567890)\nPastikan nomor aktif.",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]) }
  );
});

// Handler pesan teks (nomor untuk cek, atau nomor bot baru)
bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // Waiting for bot number (tambah bot)
  if (ctx.session?.waitingForBotNumber) {
    delete ctx.session.waitingForBotNumber;
    const phone = sanitizePhone(text);
    if (!phone.match(/^\d{8,15}$/)) {
      await ctx.reply("❌ Format nomor salah. Contoh: 6281234567890");
      return;
    }
    const user = getUser(userId);
    if (user?.bots.find(b => b.phoneNumber === phone)) {
      await ctx.reply("❌ Bot dengan nomor itu sudah ada.");
      return;
    }
    const sessionId = `user_${userId}_${phone}`;
    await ctx.reply(`⏳ Mendaftarkan bot ${phone}... Mohon tunggu kode pairing.`);
    try {
      await engine.createSession(
        { sessionId, senderType: "user_sender", label: `User ${userId}` },
        {
          phoneNumber: phone,
          onPairingCode: async (sid, code) => {
            await ctx.reply(`🔐 *KODE PAIRING*\nSender: ${phone}\nKode: \`${code}\`\nMasukkan di WhatsApp > Perangkat Tertaut > Tautkan Perangkat`, { parse_mode: "Markdown" });
          }
        }
      );
      addBotToUser(userId, { id: sessionId, phoneNumber: phone, isActive: true, addedAt: new Date().toISOString() });
      await ctx.reply(`✅ Bot ${phone} berhasil ditambahkan. Selesaikan pairing di WhatsApp.`, Markup.inlineKeyboard([Markup.button.callback("🔙 Menu", "back_main")]));
    } catch (err) {
      console.error(err);
      await ctx.reply("❌ Gagal menambahkan bot. Coba lagi.");
    }
    return;
  }

  // Waiting for numbers to check
  if (ctx.session?.pendingCheck) {
    const pending = ctx.session.pendingCheck;
    delete ctx.session.pendingCheck;

    let numbers = parseNumbersFromText(text);
    if (numbers.length === 0) {
      await ctx.reply("❌ Tidak ada nomor valid.");
      return;
    }
    const maxLimit = pending.mode === "global" ? 10 : 100;
    if (numbers.length > maxLimit) {
      await ctx.reply(`❌ Maksimal ${maxLimit} nomor per cek.`);
      return;
    }

    // Kirim pesan "sedang memproses" untuk menghindari timeout
    const progressMsg = await ctx.reply("⏳ *Sedang memproses cek bio...*\nMohon tunggu, ini bisa memakan waktu hingga 1 menit.", { parse_mode: "Markdown" });

    try {
      const startTime = Date.now();
      const result = await engine.checkNumbers(pending.botId, numbers, {
        batchSize: 5,
        concurrencyPerBatch: 3,
        minBatchDelayMs: 500,
        maxBatchDelayMs: 1500,
        perNumberTimeoutMs: 8000,
      });
      const durationMs = Date.now() - startTime;

      // Update progress message (optional)
      await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, "✅ Proses selesai!");

      // Simpan riwayat
      const registeredNumbers = result.details.filter((d: any) => d.isRegistered).map((d: any) => d.phone);
      const historyItem: CheckHistoryItem = {
        id: `CB-${randomBytes(3).toString("hex").toUpperCase()}`,
        userId,
        mode: pending.mode,
        botPhone: pending.botPhone,
        timestamp: new Date().toISOString(),
        totalNumbers: result.total_checked,
        registeredCount: result.registered_count,
        unregisteredCount: result.unregistered_count,
        businessCount: result.business_account_count,
        regularCount: result.regular_account_count,
        metaVerifiedCount: result.meta_verified_count,
        obaCount: result.oba_count,
        durationMs,
        registeredNumbers,
        fullResult: result, // optional, bisa disimpan jika perlu
      };
      addHistoryItem(historyItem);

      // Kirim summary
      const summaryText = generateSummaryText(result, pending.mode, pending.botPhone);
      await ctx.replyWithMarkdown(summaryText, Markup.inlineKeyboard([
        [Markup.button.callback("📄 Download TXT", `dl_txt_${historyItem.id}`)],
        [Markup.button.callback("📊 Download Excel", `dl_xlsx_${historyItem.id}`)]
      ]));

      // Kirim file TXT jika ada nomor terdaftar (opsional)
      if (registeredNumbers.length > 0) {
        const txtContent = `Laporan Cek Bio\nID: ${historyItem.id}\n\nNomor terdaftar:\n${registeredNumbers.join("\n")}`;
        const txtBuffer = Buffer.from(txtContent, "utf-8");
        await ctx.replyWithDocument({ source: txtBuffer, filename: `hasil_${historyItem.id}.txt` });
      }
    } catch (err: any) {
      console.error(err);
      await ctx.reply(`❌ Error: ${err.message}`);
    } finally {
      await ctx.reply("Menu utama:", mainMenuKeyboard);
    }
  }
});

// Back to main menu
bot.action("back_main", async (ctx) => {
  await ctx.editMessageText("Menu utama:", mainMenuKeyboard);
});

// Admin command untuk login global
bot.command("globallogin", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only");
  await ctx.reply("Memulai login global. Kirim nomor HP (contoh: 6281234567890)");
  ctx.session = ctx.session || {};
  ctx.session.adminWaitingGlobal = true;
});

bot.on(message("text"), async (ctx) => {
  if (ctx.session?.adminWaitingGlobal && ADMIN_IDS.includes(ctx.from.id)) {
    delete ctx.session.adminWaitingGlobal;
    const phone = sanitizePhone(ctx.message.text);
    if (!phone) return ctx.reply("Nomor salah");
    await ctx.reply(`Memproses login global untuk ${phone}...`);
    try {
      await engine.createSession(
        { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Panorama Global" },
        { phoneNumber: phone, onPairingCode: async (sid, code) => {
          await ctx.reply(`🔐 GLOBAL PAIRING CODE: \`${code}\``, { parse_mode: "Markdown" });
        } }
      );
      globalSessionReady = true;
      await ctx.reply("✅ Global session berhasil dibuat. Tunggu kode pairing dan selesaikan di WhatsApp.");
    } catch (err) {
      await ctx.reply(`Gagal: ${err}`);
    }
  }
});

// ==================== START BOT ====================
async function main() {
  await initGlobalSession();
  bot.launch();
  console.log("🤖 Panorama Bot running...");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
main().catch(console.error);
