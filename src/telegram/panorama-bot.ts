import { Telegraf, session, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WhatsAppBulkCheckerEngine } from "../engine/whatsapp-bulk-checker"; // FIXED

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 0];

const engine = new WhatsAppBulkCheckerEngine();
const GLOBAL_SESSION_ID = "panorama_global_sender";
let globalSessionReady = false;

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
  registeredNumbers: string[];
  fullResult?: unknown;
}

interface PendingCheckState {
  mode: "user" | "global";
  botId: string;
  botPhone?: string;
}

interface SessionData {
  waitingForBotNumber?: boolean;
  pendingCheck?: PendingCheckState;
  adminWaitingGlobal?: boolean;
}

type BotContext = Context & { session: SessionData };

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
function addBotToUser(userId: number, bot: PanoramaBot) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  if (user.bots.find((b) => b.phoneNumber === bot.phoneNumber)) throw new Error("Bot already exists");
  user.bots.push(bot);
  saveUser(user);
}
function removeBotFromUser(userId: number, botId: string) {
  const user = getUser(userId);
  if (user) {
    user.bots = user.bots.filter((b) => b.id !== botId);
    saveUser(user);
  }
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
    if (clean.length >= 8 && /^\d+$/.test(clean)) numbers.push(clean);
  }
  return numbers;
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

async function initGlobalSession() {
  try {
    const existing = engine.getSessionPairingInfo(GLOBAL_SESSION_ID);
    if (existing && existing.isConnected) {
      globalSessionReady = true;
      return;
    }

    const sessionPath = path.join(process.cwd(), "sessions", GLOBAL_SESSION_ID);
    const hasCreds = fs.existsSync(path.join(sessionPath, "creds.json"));
    if (hasCreds) {
      await engine.createSession({
        sessionId: GLOBAL_SESSION_ID,
        senderType: "global_sender",
        label: "Panorama Global",
      });
      globalSessionReady = true;
    }
  } catch (err) {
    console.error("Global session init failed", err);
  }
}

const bot = new Telegraf<BotContext>(BOT_TOKEN);
bot.use(session({ defaultSession: (): SessionData => ({}) }));

const mainMenuKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📱 Cek Bio", "menu_cek_bio")],
  [Markup.button.callback("🤖 Daftar Bot", "menu_daftar_bot")],
  [Markup.button.callback("📜 Riwayat", "menu_riwayat")],
  [Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot")],
]);

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
    `🔰 *PANORAMA CEK BIO* 🔰\n${formatNumber(2674)} monthly users\n\nTotal user: ${totalUsers}`,
    { parse_mode: "Markdown", ...mainMenuKeyboard }
  );
});

bot.action("menu_cek_bio", async (ctx) => {
  await ctx.editMessageText("Pilih mode:", {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("👤 SENDER USER", "mode_user")],
      [Markup.button.callback("🌍 SENDER GLOBAL", "mode_global")],
      [Markup.button.callback("🔙 Kembali", "back_main")],
    ]),
  });
});

bot.action("mode_user", async (ctx) => {
  const userId = ctx.from.id;
  const user = getUser(userId);
  if (!user || user.bots.length === 0) {
    await ctx.editMessageText("❌ Tidak ada bot terdaftar.", Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]));
    return;
  }

  if (user.bots.length === 1) {
    await startUserMode(ctx, userId, user.bots[0]);
    return;
  }

  const buttons = user.bots.map((b) => Markup.button.callback(b.phoneNumber, `select_bot_${b.id}`));
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText("Pilih bot:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/select_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
  const botId = match[1];
  const userId = ctx.from.id;
  const user = getUser(userId);
  const selected = user?.bots.find((b) => b.id === botId);
  if (!selected) return ctx.answerCbQuery("Bot tidak ditemukan");
  await startUserMode(ctx, userId, selected);
});

async function startUserMode(ctx: BotContext, _userId: number, botData: PanoramaBot) {
  const sessionInfo = engine.getSessionPairingInfo(botData.id);
  if (!sessionInfo || !sessionInfo.isConnected) {
    await ctx.editMessageText(`❌ Bot ${botData.phoneNumber} tidak terhubung.`, Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]));
    return;
  }

  ctx.session.pendingCheck = {
    mode: "user",
    botId: botData.id,
    botPhone: botData.phoneNumber,
  };

  await ctx.editMessageText("Kirim daftar nomor untuk dicek (maks 100).");
}

bot.action("mode_global", async (ctx) => {
  if (!globalSessionReady) {
    await ctx.editMessageText("❌ Sender global offline.", Markup.inlineKeyboard([Markup.button.callback("🔙 Kembali", "back_main")]));
    return;
  }
  ctx.session.pendingCheck = { mode: "global", botId: GLOBAL_SESSION_ID };
  await ctx.editMessageText("Kirim daftar nomor (maks 10) untuk mode global.");
});

bot.action("menu_tambah_bot", async (ctx) => {
  ctx.session.waitingForBotNumber = true;
  await ctx.editMessageText("Kirim nomor WhatsApp (contoh: 6281234567890).");
});

bot.action(/delete_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
  const botId = match[1];
  const userId = ctx.from.id;
  await engine.deleteSession(botId).catch(console.error);
  removeBotFromUser(userId, botId);
  await ctx.editMessageText("✅ Bot dihapus.");
});

bot.action(/restart_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
  const botId = match[1];
  const userId = ctx.from.id;
  const user = getUser(userId);
  const userBot = user?.bots.find((b) => b.id === botId);
  if (!userBot) return ctx.answerCbQuery("Bot tidak ditemukan");

  await engine.restartSession(botId, {
    phoneNumber: userBot.phoneNumber,
    onPairingCode: async (sid: string, code: string) => {
      await ctx.telegram.sendMessage(userId, `🔐 Kode pairing ${sid}: \`${code}\``, { parse_mode: "Markdown" });
    },
  });

  await ctx.editMessageText("🔄 Restart dimulai.");
});

bot.action("menu_riwayat", async (ctx) => {
  const userId = ctx.from.id;
  const history = getUserHistory(userId, 10);
  if (!history.length) {
    await ctx.editMessageText("📭 Belum ada riwayat.");
    return;
  }

  const buttons = history.map((h, i) =>
    Markup.button.callback(`${i + 1}. ${new Date(h.timestamp).toLocaleString("id-ID")}`, `detail_history_${h.id}`)
  );
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText("📜 Riwayat:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/detail_history_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
  const historyId = match[1];
  const item = getUserHistory(ctx.from.id, 100).find((h) => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Riwayat tidak ditemukan");

  await ctx.editMessageText(
    `ID: ${item.id}\nTotal: ${item.totalNumbers}\nTerdaftar: ${item.registeredCount}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📄 Download TXT", `dl_txt_${item.id}`)],
      [Markup.button.callback("📊 Download Excel", `dl_xlsx_${item.id}`)],
      [Markup.button.callback("🔙 Kembali", "menu_riwayat")],
    ])
  );
});

bot.action(/dl_txt_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
  const historyId = match[1];
  const item = getUserHistory(ctx.from.id, 100).find((h) => h.id === historyId);
  if (!item) return ctx.answerCbQuery("Data tidak ada");

  const content = `Laporan Cek Bio\nID: ${item.id}\n\n${item.registeredNumbers.join("\n")}`;
  await ctx.replyWithDocument({ source: Buffer.from(content, "utf-8"), filename: `cek_bio_${item.id}.txt` });
});

bot.action(/dl_xlsx_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray; // FIXED
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

bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (ctx.session.adminWaitingGlobal && ADMIN_IDS.includes(userId)) {
    ctx.session.adminWaitingGlobal = false;
    const phone = sanitizePhone(text);
    await engine.createSession(
      { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Panorama Global" },
      {
        phoneNumber: phone,
        onPairingCode: async (sid: string, code: string) => {
          await ctx.reply(`🔐 GLOBAL PAIRING CODE (${sid}): \`${code}\``, { parse_mode: "Markdown" });
        },
      }
    );
    globalSessionReady = true;
    await ctx.reply("✅ Global session dibuat.");
    return;
  }

  if (ctx.session.waitingForBotNumber) {
    ctx.session.waitingForBotNumber = false;
    const phone = sanitizePhone(text);
    if (!/^\d{8,15}$/.test(phone)) return ctx.reply("❌ Format nomor salah.");

    const user = getUser(userId);
    if (user?.bots.find((b) => b.phoneNumber === phone)) return ctx.reply("❌ Nomor sudah terdaftar.");

    const sessionId = `user_${userId}_${phone}`;
    await engine.createSession(
      { sessionId, senderType: "user_sender", label: `User ${userId}` },
      {
        phoneNumber: phone,
        onPairingCode: async (sid: string, code: string) => {
          await ctx.reply(`🔐 Pairing (${sid}): \`${code}\``, { parse_mode: "Markdown" });
        },
      }
    );

    addBotToUser(userId, { id: sessionId, phoneNumber: phone, isActive: true, addedAt: new Date().toISOString() });
    await ctx.reply(`✅ Bot ${phone} ditambahkan.`);
    return;
  }

  if (ctx.session.pendingCheck) {
    const pending = ctx.session.pendingCheck;
    ctx.session.pendingCheck = undefined;

    const numbers = parseNumbersFromText(text);
    if (!numbers.length) return ctx.reply("❌ Tidak ada nomor valid.");

    const maxLimit = pending.mode === "global" ? 10 : 100;
    if (numbers.length > maxLimit) return ctx.reply(`❌ Maksimal ${maxLimit} nomor.`);

    const progress = await ctx.reply("⏳ Memproses...");
    try {
      const start = Date.now();
      const result = await engine.checkNumbers(pending.botId, numbers, {
        batchSize: 5,
        concurrencyPerBatch: 3,
        minBatchDelayMs: 500,
        maxBatchDelayMs: 1500,
        perNumberTimeoutMs: 8000,
      });
      const durationMs = Date.now() - start;

      await ctx.telegram.editMessageText(ctx.chat!.id, progress.message_id, undefined, "✅ Selesai.");

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

      await ctx.replyWithMarkdown(generateSummaryText(result, pending.mode, pending.botPhone), Markup.inlineKeyboard([
        [Markup.button.callback("📄 Download TXT", `dl_txt_${historyItem.id}`)],
        [Markup.button.callback("📊 Download Excel", `dl_xlsx_${historyItem.id}`)],
      ]));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ Error: ${msg}`);
    } finally {
      await ctx.reply("Menu utama:", mainMenuKeyboard);
    }
  }
});

async function main() {
  await initGlobalSession();
  await bot.launch();
  console.log("🤖 Panorama Bot running...");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch(console.error);
