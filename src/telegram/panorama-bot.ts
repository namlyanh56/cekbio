import { Telegraf, session, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { WhatsAppBulkCheckerEngine } from "../engine/whatsapp-bulk-checker";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/* =========================================================
 * Types
 * ======================================================= */

interface PanoramaBot {
  id: string;
  phoneNumber: string;
  isActive: boolean; // true hanya jika benar2 connected
  addedAt: string;
  pairingStatus?: "pending_pairing" | "code_sent" | "connected" | "failed" | "logged_out" | "cancelled";
  lastPairingCode?: string | null;
  lastPairingAt?: string | null;
  lastError?: string | null;
}

interface PanoramaUser {
  userId: number;
  username?: string;
  firstName?: string;
  tier: "free" | "vip";
  createdAt: string;
  bots: PanoramaBot[];
  lastMode: "user" | "global" | null;
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
  registeredNumbers: string[];
  fullResult?: unknown;
}

interface PendingCheck {
  mode: "user" | "global";
  botId: string;
  botPhone?: string;
}

interface MySession {
  waitingForBotNumber?: boolean;
  pendingCheck?: PendingCheck;
  adminWaitingGlobal?: boolean;
}

type BotContext = Context & { session: MySession };

/* =========================================================
 * Config
 * ======================================================= */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 0];

const engine = new WhatsAppBulkCheckerEngine();
const GLOBAL_SESSION_ID = "panorama_global_sender";
let globalSessionReady = false;

/* =========================================================
 * Storage
 * ======================================================= */

const DATA_DIR = path.join(process.cwd(), "panorama_data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

function loadUsers(): Map<number, PanoramaUser> {
  if (!fs.existsSync(USERS_FILE)) return new Map();
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")) as Record<string, PanoramaUser>;
  const map = new Map<number, PanoramaUser>();
  for (const [k, v] of Object.entries(data)) map.set(Number(k), v);
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

function upsertBotToUser(userId: number, bot: PanoramaBot): PanoramaBot {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");

  const idx = user.bots.findIndex((b) => b.id === bot.id || b.phoneNumber === bot.phoneNumber);
  if (idx >= 0) {
    user.bots[idx] = { ...user.bots[idx], ...bot };
  } else {
    user.bots.push(bot);
  }
  saveUser(user);
  return idx >= 0 ? user.bots[idx] : bot;
}

function removeBotFromUser(userId: number, botId: string) {
  const user = getUser(userId);
  if (!user) return;
  user.bots = user.bots.filter((b) => b.id !== botId);
  saveUser(user);
}

function findBotByPhone(userId: number, phone: string): PanoramaBot | undefined {
  const user = getUser(userId);
  return user?.bots.find((b) => b.phoneNumber === phone);
}

function loadHistory(): CheckHistoryItem[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")) as CheckHistoryItem[];
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
  return loadHistory().filter((h) => h.userId === userId).slice(0, limit);
}

/* =========================================================
 * Utils
 * ======================================================= */

function sanitizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function parseNumbersFromText(text: string): string[] {
  const parts = text.split(/[\n, ]+/);
  const numbers: string[] = [];
  for (const p of parts) {
    const clean = sanitizePhone(p);
    if (clean.length >= 8 && /^\d+$/.test(clean)) numbers.push(clean);
  }
  return numbers;
}

function formatNumber(num: number): string {
  return num.toLocaleString("id-ID");
}

function generateSummaryText(result: any, mode: string, botPhone?: string): string {
  const durationSec = (result.meta.duration_ms / 1000).toFixed(1);
  let text = `📊 *RINGKASAN HASIL CEK BIO* 📊\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `▫️ Mode: ${mode === "user" ? "User (Pribadi)" : "Global (Owner)"}\n`;
  if (botPhone) text += `▫️ Bot: \`${botPhone}\`\n`;
  text += `▫️ Durasi: *${durationSec} detik*\n\n`;
  text += `▫️ Total dicek: *${result.total_checked}*\n`;
  text += `▫️ Terdaftar WA: *${result.registered_count}*\n`;
  text += `▫️ Tidak terdaftar: *${result.unregistered_count}*\n`;
  text += `▫️ Messenger: *${result.regular_account_count}*\n`;
  text += `▫️ Business: *${result.business_account_count}*\n`;
  text += `▫️ Meta Verified: *${result.meta_verified_count}*\n`;
  text += `▫️ Official (OBA): *${result.oba_count}*\n`;
  return text;
}

async function createExcelBuffer(registeredNumbers: string[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Hasil Cek Bio");
  sheet.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "Phone Number", key: "phone", width: 20 },
  ];
  registeredNumbers.forEach((num, idx) => sheet.addRow({ no: idx + 1, phone: num }));
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/* =========================================================
 * Bot
 * ======================================================= */

const bot = new Telegraf<BotContext>(BOT_TOKEN);
bot.use(session({ defaultSession: (): MySession => ({}) }));

const mainMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📱 Cek Bio", "menu_cek_bio")],
  [Markup.button.callback("🤖 Daftar Bot", "menu_daftar_bot")],
  [Markup.button.callback("📜 Riwayat", "menu_riwayat")],
  [Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot")],
]);

async function initGlobalSession() {
  try {
    const existing = engine.getSessionPairingInfo(GLOBAL_SESSION_ID);
    globalSessionReady = Boolean(existing?.isConnected);
  } catch (err) {
    console.error("Global session init failed", err);
  }
}

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

  await ctx.reply(
    `🔰 *PANORAMA CEK BIO* 🔰\n${formatNumber(2674)} monthly users`,
    { parse_mode: "Markdown", ...mainMenuKeyboard }
  );
});

bot.action("menu_tambah_bot", async (ctx) => {
  ctx.session.waitingForBotNumber = true;
  await ctx.editMessageText(
    "➕ *TAMBAH BOT USER*\nKirim nomor WhatsApp (contoh: 6281234567890)",
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]) }
  );
});

/**
 * Tombol Try Again Pairing
 */
bot.action(/pair_try_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];
  const user = getUser(ctx.from.id);
  const botData = user?.bots.find((b) => b.id === sessionId);
  if (!botData) return ctx.answerCbQuery("Bot tidak ditemukan");

  try {
    const code = await engine.retryPairingCode(sessionId, botData.phoneNumber);

    upsertBotToUser(ctx.from.id, {
      ...botData,
      isActive: false,
      pairingStatus: "code_sent",
      lastPairingCode: code,
      lastPairingAt: new Date().toISOString(),
      lastError: null,
    });

    await ctx.editMessageText(
      `🔐 *KODE PAIRING BARU*\nSender: ${botData.phoneNumber}\nKode: \`${code}\``,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
          [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
          [Markup.button.callback("🔙 Kembali", "menu_daftar_bot")],
        ]),
      }
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Retry gagal";
    await ctx.answerCbQuery(msg, { show_alert: true });
  }
});

/**
 * Tombol Cancel Pairing
 */
bot.action(/pair_cancel_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];

  await engine.cancelPairing(sessionId);

  const user = getUser(ctx.from.id);
  const botData = user?.bots.find((b) => b.id === sessionId);
  if (botData) {
    upsertBotToUser(ctx.from.id, {
      ...botData,
      isActive: false,
      pairingStatus: "cancelled",
      lastPairingCode: null,
      lastError: "Cancelled by user",
    });
  }

  await ctx.editMessageText("✅ Pairing dibatalkan.", {
    ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_daftar_bot")]]),
  });
});

bot.action("menu_daftar_bot", async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user || user.bots.length === 0) {
    await ctx.editMessageText("📭 Belum ada bot.", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot")],
        [Markup.button.callback("🔙 Kembali", "back_main")],
      ]),
    });
    return;
  }

  let text = `📱 *DAFTAR BOT USER*\n\n`;
  const buttons = [];
  for (const b of user.bots) {
    const connected = b.isActive && engine.isSessionConnected(b.id);
    text += `• ${b.phoneNumber} ${connected ? "✅" : "❌"} (${b.pairingStatus ?? "idle"})\n`;
    buttons.push(Markup.button.callback(b.phoneNumber, `detail_bot_${b.id}`));
  }
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));

  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons, { columns: 1 }),
  });
});

bot.action(/detail_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];

  const user = getUser(ctx.from.id);
  const b = user?.bots.find((x) => x.id === sessionId);
  if (!b) return ctx.answerCbQuery("Bot tidak ditemukan");

  const pairInfo = engine.getSessionPairingInfo(sessionId);

  const rows = [
    [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`), Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
    [Markup.button.callback("🗑 Hapus Bot", `delete_bot_${sessionId}`)],
    [Markup.button.callback("🔙 Kembali", "menu_daftar_bot")],
  ];

  await ctx.editMessageText(
    `🔍 *DETAIL BOT*\n` +
      `📱 ${b.phoneNumber}\n` +
      `Status DB: ${b.isActive ? "aktif" : "belum aktif"}\n` +
      `Status Pairing: ${b.pairingStatus ?? "idle"}\n` +
      `Connected Runtime: ${pairInfo?.isConnected ? "yes" : "no"}\n` +
      `Error: ${b.lastError ?? "-"}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
  );
});

bot.action(/delete_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];

  await engine.deleteSession(sessionId).catch(console.error);
  removeBotFromUser(ctx.from.id, sessionId);

  await ctx.editMessageText("✅ Bot dihapus.", {
    ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "menu_daftar_bot")]]),
  });
});

bot.action("menu_cek_bio", async (ctx) => {
  await ctx.editMessageText("Pilih mode:", {
    ...Markup.inlineKeyboard([
      [Markup.button.callback("👤 SENDER USER", "mode_user")],
      [Markup.button.callback("🌍 SENDER GLOBAL", "mode_global")],
      [Markup.button.callback("🔙 Kembali", "back_main")],
    ]),
  });
});

bot.action("mode_user", async (ctx) => {
  const user = getUser(ctx.from.id);
  if (!user) return;

  const activeBots = user.bots.filter((b) => b.isActive && engine.isSessionConnected(b.id));
  if (activeBots.length === 0) {
    await ctx.editMessageText("❌ Tidak ada bot yang benar-benar terhubung.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🤖 Daftar Bot", "menu_daftar_bot")]]),
    });
    return;
  }

  if (activeBots.length === 1) {
    const b = activeBots[0];
    ctx.session.pendingCheck = { mode: "user", botId: b.id, botPhone: b.phoneNumber };
    await ctx.editMessageText("Kirim daftar nomor (maks 100).");
    return;
  }

  const buttons = activeBots.map((b) => Markup.button.callback(b.phoneNumber, `select_bot_${b.id}`));
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText("Pilih bot aktif:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/select_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];
  const user = getUser(ctx.from.id);
  const b = user?.bots.find((x) => x.id === sessionId);
  if (!b) return ctx.answerCbQuery("Bot tidak ditemukan");

  if (!(b.isActive && engine.isSessionConnected(b.id))) {
    await ctx.answerCbQuery("Bot belum terhubung");
    return;
  }

  ctx.session.pendingCheck = { mode: "user", botId: b.id, botPhone: b.phoneNumber };
  await ctx.editMessageText("Kirim daftar nomor (maks 100).");
});

bot.action("mode_global", async (ctx) => {
  if (!globalSessionReady || !engine.isSessionConnected(GLOBAL_SESSION_ID)) {
    await ctx.editMessageText("❌ Sender global offline.");
    return;
  }
  ctx.session.pendingCheck = { mode: "global", botId: GLOBAL_SESSION_ID };
  await ctx.editMessageText("Kirim daftar nomor (maks 10).");
});

bot.action("menu_riwayat", async (ctx) => {
  const history = getUserHistory(ctx.from.id, 10);
  if (!history.length) {
    await ctx.editMessageText("📭 Belum ada riwayat.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]),
    });
    return;
  }

  const buttons = history.map((h, i) =>
    Markup.button.callback(`${i + 1}. ${new Date(h.timestamp).toLocaleString("id-ID")}`, `detail_history_${h.id}`)
  );
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));

  await ctx.editMessageText("📜 Riwayat:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/detail_history_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const historyId = match[1];

  const item = getUserHistory(ctx.from.id, 100).find((h) => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Riwayat tidak ditemukan");

  await ctx.editMessageText(
    `📋 *Detail Cek Bio*\nID: ${item.id}\nTotal: ${item.totalNumbers}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📄 Download TXT", `dl_txt_${item.id}`)],
        [Markup.button.callback("📊 Download Excel", `dl_xlsx_${item.id}`)],
        [Markup.button.callback("🔙 Kembali", "menu_riwayat")],
      ]),
    }
  );
});

bot.action(/dl_txt_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const historyId = match[1];
  const item = getUserHistory(ctx.from.id, 100).find((h) => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Data tidak ada");

  const content = `Laporan Cek Bio\nID: ${item.id}\nWaktu: ${item.timestamp}\n\nDAFTAR NOMOR TERDAFTAR:\n${item.registeredNumbers.join("\n")}`;
  await ctx.replyWithDocument({ source: Buffer.from(content, "utf-8"), filename: `cek_bio_${item.id}.txt` });
});

bot.action(/dl_xlsx_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const historyId = match[1];
  const item = getUserHistory(ctx.from.id, 100).find((h) => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Data tidak ada");

  const buffer = await createExcelBuffer(item.registeredNumbers);
  await ctx.replyWithDocument({ source: buffer, filename: `hasil_${item.id}.xlsx` });
});

bot.action("back_main", async (ctx) => {
  await ctx.editMessageText("Menu utama:", mainMenuKeyboard);
});

bot.command("globallogin", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only");
  ctx.session.adminWaitingGlobal = true;
  await ctx.reply("Kirim nomor global (contoh: 6281234567890)");
});

/* =========================================================
 * Text handler
 * ======================================================= */

bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // Admin global login
  if (ctx.session.adminWaitingGlobal && ADMIN_IDS.includes(userId)) {
    ctx.session.adminWaitingGlobal = false;
    const phone = sanitizePhone(text);
    if (!phone) return ctx.reply("Nomor salah");

    await ctx.reply(`Memproses login global untuk ${phone}...`);

    await engine.createSession(
      { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Panorama Global" },
      {
        phoneNumber: phone,
        onPairingCode: async (_sid, code) => {
          await ctx.reply(`🔐 GLOBAL PAIRING CODE: \`${code}\``, { parse_mode: "Markdown" });
        },
        onConnected: async () => {
          globalSessionReady = true;
          await ctx.reply("✅ Global session terhubung.");
        },
        onFailed: async (_sid, reason) => {
          globalSessionReady = false;
          await ctx.reply(`❌ Global session gagal: ${reason}`);
        },
      }
    );
    return;
  }

  // Tambah bot user
  if (ctx.session.waitingForBotNumber) {
    ctx.session.waitingForBotNumber = false;
    const phone = sanitizePhone(text);
    if (!/^\d{8,15}$/.test(phone)) {
      await ctx.reply("❌ Format nomor salah. Contoh: 6281234567890");
      return;
    }

    const existing = findBotByPhone(userId, phone);

    // Kalau sudah connected benar -> block
    if (existing && existing.isActive && engine.isSessionConnected(existing.id)) {
      await ctx.reply("❌ Nomor ini sudah terdaftar dan aktif.");
      return;
    }

    // Kalau ada tapi belum connected -> tawarkan retry/cancel, jangan block mentah
    if (existing && !existing.isActive) {
      await ctx.reply(
        `⚠️ Nomor sudah ada tapi belum terhubung.\nStatus: ${existing.pairingStatus ?? "unknown"}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔁 Try Again", `pair_try_${existing.id}`)],
          [Markup.button.callback("🛑 Cancel", `pair_cancel_${existing.id}`)],
        ])
      );
      return;
    }

    const sessionId = `user_${userId}_${phone}`;

    // simpan dulu sebagai pending
    upsertBotToUser(userId, {
      id: sessionId,
      phoneNumber: phone,
      isActive: false,
      addedAt: new Date().toISOString(),
      pairingStatus: "pending_pairing",
      lastPairingCode: null,
      lastPairingAt: null,
      lastError: null,
    });

    await ctx.reply(`⏳ Menyiapkan pairing untuk ${phone}...`);

    await engine.createSession(
      { sessionId, senderType: "user_sender", label: `User ${userId}` },
      {
        phoneNumber: phone,
        onPairingCode: async (_sid, code) => {
          upsertBotToUser(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: false,
            addedAt: new Date().toISOString(),
            pairingStatus: "code_sent",
            lastPairingCode: code,
            lastPairingAt: new Date().toISOString(),
            lastError: null,
          });

          await ctx.reply(
            `🔐 *KODE PAIRING*\nSender: ${phone}\nKode: \`${code}\``,
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
                [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
              ]),
            }
          );
        },
        onConnected: async () => {
          upsertBotToUser(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: true, // hanya saat benar2 connected
            addedAt: new Date().toISOString(),
            pairingStatus: "connected",
            lastError: null,
          });
          await ctx.reply(`✅ Bot ${phone} berhasil terhubung dan aktif.`);
        },
        onFailed: async (_sid, reason) => {
          upsertBotToUser(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: false,
            addedAt: new Date().toISOString(),
            pairingStatus: "failed",
            lastError: reason,
          });

          await ctx.reply(
            `❌ Pairing gagal untuk ${phone}\nAlasan: ${reason}`,
            Markup.inlineKeyboard([
              [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
              [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
            ])
          );
        },
      }
    );

    return;
  }

  // Check numbers
  if (ctx.session.pendingCheck) {
    const pending = ctx.session.pendingCheck;
    ctx.session.pendingCheck = undefined;

    const numbers = parseNumbersFromText(text);
    if (numbers.length === 0) {
      await ctx.reply("❌ Tidak ada nomor valid.");
      return;
    }

    const maxLimit = pending.mode === "global" ? 10 : 100;
    if (numbers.length > maxLimit) {
      await ctx.reply(`❌ Maksimal ${maxLimit} nomor per cek.`);
      return;
    }

    const progressMsg = await ctx.reply("⏳ Sedang memproses...");

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

      await ctx.telegram.editMessageText(ctx.chat!.id, progressMsg.message_id, undefined, "✅ Proses selesai!");

      const registeredNumbers = result.details.filter((d) => d.isRegistered).map((d) => d.phone);
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
        fullResult: result,
      };
      addHistoryItem(historyItem);

      await ctx.replyWithMarkdown(
        generateSummaryText(result, pending.mode, pending.botPhone),
        Markup.inlineKeyboard([
          [Markup.button.callback("📄 Download TXT", `dl_txt_${historyItem.id}`)],
          [Markup.button.callback("📊 Download Excel", `dl_xlsx_${historyItem.id}`)],
        ])
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await ctx.reply(`❌ Error: ${msg}`);
    } finally {
      await ctx.reply("Menu utama:", mainMenuKeyboard);
    }
  }
});

/* =========================================================
 * Start
 * ======================================================= */

async function main() {
  await initGlobalSession();
  await bot.launch();
  console.log("🤖 Panorama Bot running...");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
main().catch(console.error);
