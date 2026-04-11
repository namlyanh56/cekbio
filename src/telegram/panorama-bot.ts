import { Context, Markup, Telegraf, session } from "telegraf";
import { message } from "telegraf/filters";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { WhatsAppBulkCheckerEngine } from "../engine/whatsapp-bulk-checker";

/* ===================== TYPES ===================== */
interface PanoramaBot {
  id: string;
  phoneNumber: string;
  isActive: boolean; // true only when connected
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

interface SessionData {
  waitingForBotNumber?: boolean;
  pendingCheck?: PendingCheck;
  adminWaitingGlobal?: boolean;
}

type BotContext = Context & { session: SessionData };

/* ===================== CONFIG ===================== */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 0];

const engine = new WhatsAppBulkCheckerEngine();
const GLOBAL_SESSION_ID = "panorama_global_sender";
let globalSessionReady = false;

/* ===================== STORAGE ===================== */
const DATA_DIR = path.join(process.cwd(), "panorama_data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

function loadUsers(): Map<number, PanoramaUser> {
  if (!fs.existsSync(USERS_FILE)) return new Map();
  const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")) as Record<string, PanoramaUser>;
  const map = new Map<number, PanoramaUser>();
  for (const [k, v] of Object.entries(raw)) map.set(Number(k), v);
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

function upsertBot(userId: number, bot: PanoramaBot) {
  const user = getUser(userId);
  if (!user) throw new Error("User not found");
  const idx = user.bots.findIndex((b) => b.id === bot.id || b.phoneNumber === bot.phoneNumber);
  if (idx >= 0) user.bots[idx] = { ...user.bots[idx], ...bot };
  else user.bots.push(bot);
  saveUser(user);
}

function removeBotFromUser(userId: number, botId: string) {
  const user = getUser(userId);
  if (!user) return;
  user.bots = user.bots.filter((b) => b.id !== botId);
  saveUser(user);
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

/* ===================== UTILS ===================== */
function sanitizePhone(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

function parseNumbersFromText(text: string): string[] {
  return text
    .split(/[\n, ]+/)
    .map((x) => sanitizePhone(x))
    .filter((x) => /^\d{8,15}$/.test(x));
}

async function createExcelBuffer(numbers: string[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Hasil");
  sheet.columns = [
    { header: "No", key: "no", width: 6 },
    { header: "Phone Number", key: "phone", width: 24 },
  ];
  numbers.forEach((n, i) => sheet.addRow({ no: i + 1, phone: n }));
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function summaryText(result: any, mode: "user" | "global", botPhone?: string): string {
  return [
    "📊 *RINGKASAN HASIL CEK*",
    `Mode: ${mode === "user" ? "User" : "Global"}`,
    botPhone ? `Bot: \`${botPhone}\`` : "",
    `Total: *${result.total_checked}*`,
    `Terdaftar: *${result.registered_count}*`,
    `Tidak terdaftar: *${result.unregistered_count}*`,
    `Business: *${result.business_account_count}*`,
    `Regular: *${result.regular_account_count}*`,
    `Meta Verified: *${result.meta_verified_count}*`,
    `OBA: *${result.oba_count}*`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* ===================== BOT ===================== */
const bot = new Telegraf<BotContext>(BOT_TOKEN);
bot.use(session({ defaultSession: (): SessionData => ({}) }));

const mainMenu = Markup.inlineKeyboard([
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

  await ctx.reply("🔰 Panorama Cek Bio Bot", mainMenu);
});

bot.action("back_main", async (ctx) => {
  await ctx.editMessageText("Menu utama:", mainMenu);
});

/* ===== Add Bot ===== */
bot.action("menu_tambah_bot", async (ctx) => {
  ctx.session.waitingForBotNumber = true;
  await ctx.editMessageText("Kirim nomor WhatsApp (contoh: 6281234567890)", {
    ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]),
  });
});

bot.action(/pair_try_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];
  const user = getUser(ctx.from.id);
  const b = user?.bots.find((x) => x.id === sessionId);
  if (!b) return ctx.answerCbQuery("Bot tidak ditemukan");

  try {
    const code = await engine.retryPairingCode(sessionId, b.phoneNumber);
    upsertBot(ctx.from.id, {
      ...b,
      isActive: false,
      pairingStatus: "code_sent",
      lastPairingCode: code,
      lastPairingAt: new Date().toISOString(),
      lastError: null,
    });

    await ctx.editMessageText(`🔐 Kode pairing baru ${b.phoneNumber}:\n\`${code}\``, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
        [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
        [Markup.button.callback("🔙 Kembali", "menu_daftar_bot")],
      ]),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Retry gagal";
    await ctx.answerCbQuery(msg, { show_alert: true });
  }
});

bot.action(/pair_cancel_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];

  await engine.cancelPairing(sessionId);
  const user = getUser(ctx.from.id);
  const b = user?.bots.find((x) => x.id === sessionId);
  if (b) {
    upsertBot(ctx.from.id, {
      ...b,
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

/* ===== Bot List (fixed) ===== */
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

  let text = "📱 *DAFTAR BOT*\n\n";
  const buttons = [];
  for (const b of user.bots) {
    const online = b.isActive && engine.isSessionConnected(b.id);
    text += `• ${b.phoneNumber} ${online ? "✅" : "❌"} (${b.pairingStatus ?? "idle"})\n`;
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

  await ctx.editMessageText(
    `🔍 *Detail Bot*\n` +
      `Nomor: ${b.phoneNumber}\n` +
      `Aktif DB: ${b.isActive ? "Ya" : "Tidak"}\n` +
      `Status Pairing: ${b.pairingStatus ?? "idle"}\n` +
      `Runtime Connected: ${engine.isSessionConnected(b.id) ? "Ya" : "Tidak"}\n` +
      `Last Error: ${b.lastError ?? "-"}`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
        [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
        [Markup.button.callback("🗑 Hapus Bot", `delete_bot_${sessionId}`)],
        [Markup.button.callback("🔙 Kembali", "menu_daftar_bot")],
      ]),
    }
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

/* ===== Check Mode ===== */
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
  const actives = user.bots.filter((b) => b.isActive && engine.isSessionConnected(b.id));

  if (actives.length === 0) {
    await ctx.editMessageText("❌ Tidak ada bot aktif.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🤖 Daftar Bot", "menu_daftar_bot")]]),
    });
    return;
  }

  if (actives.length === 1) {
    const b = actives[0];
    ctx.session.pendingCheck = { mode: "user", botId: b.id, botPhone: b.phoneNumber };
    await ctx.editMessageText("Kirim daftar nomor (maks 100).");
    return;
  }

  const buttons = actives.map((b) => Markup.button.callback(b.phoneNumber, `select_bot_${b.id}`));
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));
  await ctx.editMessageText("Pilih bot aktif:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/select_bot_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const sessionId = match[1];
  const user = getUser(ctx.from.id);
  const b = user?.bots.find((x) => x.id === sessionId);
  if (!b) return;
  if (!(b.isActive && engine.isSessionConnected(b.id))) return ctx.answerCbQuery("Bot belum aktif");

  ctx.session.pendingCheck = { mode: "user", botId: b.id, botPhone: b.phoneNumber };
  await ctx.editMessageText("Kirim daftar nomor (maks 100).");
});

bot.action("mode_global", async (ctx) => {
  if (!globalSessionReady || !engine.isSessionConnected(GLOBAL_SESSION_ID)) {
    await ctx.editMessageText("❌ Global sender offline.");
    return;
  }
  ctx.session.pendingCheck = { mode: "global", botId: GLOBAL_SESSION_ID };
  await ctx.editMessageText("Kirim daftar nomor (maks 10).");
});

/* ===== History ===== */
bot.action("menu_riwayat", async (ctx) => {
  const rows = getUserHistory(ctx.from.id, 10);
  if (!rows.length) {
    await ctx.editMessageText("📭 Belum ada riwayat.", {
      ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Kembali", "back_main")]]),
    });
    return;
  }

  const buttons = rows.map((h, i) =>
    Markup.button.callback(`${i + 1}. ${new Date(h.timestamp).toLocaleString("id-ID")}`, `history_${h.id}`)
  );
  buttons.push(Markup.button.callback("🔙 Kembali", "back_main"));

  await ctx.editMessageText("📜 Riwayat:", Markup.inlineKeyboard(buttons, { columns: 1 }));
});

bot.action(/history_(.+)/, async (ctx) => {
  const match = ctx.match as RegExpExecArray;
  const id = match[1];
  const item = getUserHistory(ctx.from.id, 100).find((x) => x.id === id);
  if (!item) return ctx.answerCbQuery("Riwayat tidak ditemukan");

  await ctx.editMessageText(`📋 Detail: ${item.id} | total ${item.totalNumbers}`, {
    ...Markup.inlineKeyboard([
      [Markup.button.callback("📄 Download TXT", `dl_txt_${id}`)],
      [Markup.button.callback("📊 Download XLSX", `dl_xlsx_${id}`)],
      [Markup.button.callback("🔙 Kembali", "menu_riwayat")],
    ]),
  });
});

bot.action(/dl_txt_(.+)/, async (ctx) => {
  const id = (ctx.match as RegExpExecArray)[1];
  const item = getUserHistory(ctx.from.id, 100).find((x) => x.id === id);
  if (!item) return;

  const content = `ID: ${item.id}\n\n${item.registeredNumbers.join("\n")}`;
  await ctx.replyWithDocument({ source: Buffer.from(content, "utf-8"), filename: `hasil_${item.id}.txt` });
});

bot.action(/dl_xlsx_(.+)/, async (ctx) => {
  const id = (ctx.match as RegExpExecArray)[1];
  const item = getUserHistory(ctx.from.id, 100).find((x) => x.id === id);
  if (!item) return;

  const buffer = await createExcelBuffer(item.registeredNumbers);
  await ctx.replyWithDocument({ source: buffer, filename: `hasil_${item.id}.xlsx` });
});

/* ===== Admin global login ===== */
bot.command("globallogin", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("Admin only");
  ctx.session.adminWaitingGlobal = true;
  await ctx.reply("Kirim nomor global (contoh: 6281234567890)");
});

/* ===== Text handler ===== */
bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // admin global
  if (ctx.session.adminWaitingGlobal && ADMIN_IDS.includes(userId)) {
    ctx.session.adminWaitingGlobal = false;
    const phone = sanitizePhone(text);
    if (!phone) return ctx.reply("Nomor salah");

    await engine.createSession(
      { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Panorama Global" },
      {
        phoneNumber: phone,
        onPairingCode: async (_sid, code) => {
          await ctx.reply(`🔐 GLOBAL PAIRING CODE: \`${code}\``, { parse_mode: "Markdown" });
        },
        onConnected: async () => {
          globalSessionReady = true;
          await ctx.reply("✅ Global connected.");
        },
        onFailed: async (_sid, reason) => {
          globalSessionReady = false;
          await ctx.reply(`❌ Global gagal: ${reason}`);
        },
      }
    );
    return;
  }

  // add bot
  if (ctx.session.waitingForBotNumber) {
    ctx.session.waitingForBotNumber = false;
    const phone = sanitizePhone(text);
    if (!/^\d{8,15}$/.test(phone)) return ctx.reply("❌ Format nomor salah.");

    const user = getUser(userId);
    const existing = user?.bots.find((b) => b.phoneNumber === phone);

    if (existing && existing.isActive && engine.isSessionConnected(existing.id)) {
      return ctx.reply("❌ Nomor sudah terdaftar & aktif.");
    }

    if (existing && !existing.isActive) {
      return ctx.reply(
        `⚠️ Nomor sudah ada tapi belum connected (${existing.pairingStatus ?? "unknown"}).`,
        Markup.inlineKeyboard([
          [Markup.button.callback("🔁 Try Again", `pair_try_${existing.id}`)],
          [Markup.button.callback("🛑 Cancel", `pair_cancel_${existing.id}`)],
        ])
      );
    }

    const sessionId = `user_${userId}_${phone}`;
    upsertBot(userId, {
      id: sessionId,
      phoneNumber: phone,
      isActive: false,
      addedAt: new Date().toISOString(),
      pairingStatus: "pending_pairing",
      lastPairingCode: null,
      lastPairingAt: null,
      lastError: null,
    });

    await engine.createSession(
      { sessionId, senderType: "user_sender", label: `User ${userId}` },
      {
        phoneNumber: phone,
        onPairingCode: async (_sid, code) => {
          upsertBot(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: false,
            addedAt: new Date().toISOString(),
            pairingStatus: "code_sent",
            lastPairingCode: code,
            lastPairingAt: new Date().toISOString(),
            lastError: null,
          });

          await ctx.reply(`🔐 Pairing (${phone}): \`${code}\``, {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`)],
              [Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)],
            ]),
          });
        },
        onConnected: async () => {
          upsertBot(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: true,
            addedAt: new Date().toISOString(),
            pairingStatus: "connected",
            lastError: null,
          });
          await ctx.reply(`✅ ${phone} berhasil terhubung.`);
        },
        onFailed: async (_sid, reason) => {
          upsertBot(userId, {
            id: sessionId,
            phoneNumber: phone,
            isActive: false,
            addedAt: new Date().toISOString(),
            pairingStatus: "failed",
            lastError: reason,
          });
          await ctx.reply(
            `❌ Pairing gagal: ${reason}`,
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

  // check flow
  if (ctx.session.pendingCheck) {
    const pending = ctx.session.pendingCheck;
    ctx.session.pendingCheck = undefined;

    const numbers = parseNumbersFromText(text);
    if (!numbers.length) return ctx.reply("❌ Tidak ada nomor valid.");

    const max = pending.mode === "global" ? 10 : 100;
    if (numbers.length > max) return ctx.reply(`❌ Maks ${max} nomor.`);

    const progress = await ctx.reply("⏳ Sedang proses...");
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

      const registered = result.details.filter((d) => d.isRegistered).map((d) => d.phone);
      const item: CheckHistoryItem = {
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
        registeredNumbers: registered,
        fullResult: result,
      };
      addHistoryItem(item);

      await ctx.replyWithMarkdown(summaryText(result, pending.mode, pending.botPhone), Markup.inlineKeyboard([
        [Markup.button.callback("📄 Download TXT", `dl_txt_${item.id}`)],
        [Markup.button.callback("📊 Download XLSX", `dl_xlsx_${item.id}`)],
      ]));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      await ctx.reply(`❌ ${msg}`);
    } finally {
      await ctx.reply("Menu utama:", mainMenu);
    }
  }
});

/* ===================== START ===================== */
async function main() {
  await initGlobalSession();
  await bot.launch();
  console.log("🤖 Panorama Bot running...");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
main().catch(console.error);
