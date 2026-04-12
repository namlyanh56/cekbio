import { Context, Markup, Telegraf, session } from "telegraf";
import { message } from "telegraf/filters";
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import {
  WhatsAppBulkCheckerEngine,
  SessionConfig,
  InitSessionOptions,
  CheckSummary,
  NumberCheckDetail,
  sanitizePhone
} from "../engine/whatsapp-bulk-checker";

/* ===================== ANTI CRASH SYSTEM ===================== */
process.on("uncaughtException", (err) => {
  console.error("🚨 [ANTI-CRASH] Uncaught Exception Terdeteksi:", err.message);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 [ANTI-CRASH] Unhandled Rejection Terdeteksi pada:", promise, "alasan:", reason);
});

/* ===================== CONFIG & ASSETS ===================== */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const ADMIN_IDS = [process.env.ADMIN_ID ? parseInt(process.env.ADMIN_ID, 10) : 0];

const engine = new WhatsAppBulkCheckerEngine();
const GLOBAL_SESSION_ID = "panorama_global_sender";
let globalSessionReady = false;

const pairingMessageTracker: Record<string, number> = {};

/* ===================== TYPES ===================== */

interface SystemConfig {
  bgImage: string;
  maintenanceMode: boolean;
  bannedUsers: number[];
  globalSenderPhone: string | null;
}

interface PanoramaBot {
  id: string;
  phoneNumber: string;
  isActive: boolean;
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
  durationMs: number;
  fullResult?: CheckSummary; 
}

interface PendingCheck {
  mode: "user" | "global";
  botId: string;
  botPhone?: string;
}

interface SessionData {
  waitingForBotNumber?: boolean;
  pendingCheck?: PendingCheck;
  adminAction?: "bg" | "broadcast" | "ban" | "unban" | "global_pair";
}

type BotContext = Context & { session: SessionData };

/* ===================== STORAGE ===================== */

const DATA_DIR = path.join(process.cwd(), "panorama_data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function loadConfig(): SystemConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {
      bgImage: "https://placehold.co/800x400/1a1a1a/ff3333.png?text=LANGRIS+CEK+BIO+BOT",
      maintenanceMode: false,
      bannedUsers: [],
      globalSenderPhone: null
    };
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
}

function saveConfig(cfg: SystemConfig) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

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
  if (!user.bots) user.bots = [];
  const idx = user.bots.findIndex((b) => b.id === bot.id || b.phoneNumber === bot.phoneNumber);
  if (idx >= 0) user.bots[idx] = { ...user.bots[idx], ...bot };
  else user.bots.push(bot);
  saveUser(user);
}

function removeBotFromUser(userId: number, botId: string) {
  const user = getUser(userId);
  if (!user || !user.bots) return;
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
  let history = loadHistory();
  history.unshift(item);
  if (history.length > 200) history = history.slice(0, 200);
  saveHistory(history);
}

function getUserHistory(userId: number, limit = 10): CheckHistoryItem[] {
  return loadHistory()
    .filter((h) => h.userId === userId)
    .slice(0, limit);
}

/* ===================== UTILS & EXPORT ===================== */

function parseNumbersFromText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((x) => sanitizePhone(x))
    .filter((x) => /^\d{8,16}$/.test(x));
}

function escapeHTML(text: string): string {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function createExcelBuffer(numbers: string[], title: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Hasil");
  sheet.columns = [
    { header: "No", key: "no", width: 6 },
    { header: title, key: "phone", width: 24 },
  ];
  numbers.forEach((n, i) => sheet.addRow({ no: i + 1, phone: n }));
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/* ===================== UI FORMATTER ===================== */

function getReplyKeyboard(userId: number) {
  const kbd = [
    ["📱 Cek Bio", "🤖 Daftar Bot"],
    ["📜 Riwayat", "➕ Tambah Bot"]
  ];
  if (ADMIN_IDS.includes(userId)) {
    kbd.push(["⚙️ Navigator Admin"]);
  }
  return Markup.keyboard(kbd).resize();
}

function generateMainMenuHTML(user: PanoramaUser): string {
  const users = loadUsers();
  const history = loadHistory();
  let globalBots = 0;
  for (const u of users.values()) globalBots += (u.bots || []).length;
  
  const userHistory = getUserHistory(user.userId, 1000);
  const usBots = (user.bots || []).length;
  const usCek = userHistory.length;
  const usNomor = userHistory.reduce((acc, h) => acc + h.totalNumbers, 0);

  const gsUsers = users.size;
  const gsCek = history.length;
  const gsNomor = history.reduce((acc, h) => acc + h.totalNumbers, 0);

  return `👋 <b>WELCOME TO 📁 PANORAMA CEK BIO BOT</b>

👥 <b>PROFIL USER</b>
<blockquote>L 👤 Nama: <b>${escapeHTML(user.firstName || "User")}</b> ”
L 🆔 Userid: <code>${user.userId}</code>
L 🧾 Username: ${user.username ? "@" + user.username : "-"}
L 🏷 Status : <b>${user.tier === "vip" ? "VIP TIER" : "FREE TIER"}</b></blockquote>

📊 <b>STATISTIK USER</b>
<blockquote>L 🤖 Total bot : <b>${usBots}</b> ”
L 🔍 Total cek bio : <b>${usCek}x</b>
L 📱 Total nomor dicek : <b>${usNomor}</b></blockquote>

🌍 <b>STATISTIK GLOBAL</b>
<blockquote>L 👥 Total user : <b>${gsUsers}</b> ”
L 🤖 Total bot : <b>${globalBots}</b>
L 🔍 Total cek bio : <b>${gsCek}x</b>
L 📱 Total nomor dicek : <b>${gsNomor}</b></blockquote>

⬇️ <i>Klik fitur di bawah ini:</i>`;
}

function generateTxtReport(summary: CheckSummary, reportId: string): Buffer {
  let txt = `=== 📁 PANORAMA CEK BIO ===\n`;
  txt += `Laporan ID: ${reportId}\n`;
  txt += `Total Nomor Diperiksa: ${summary.total_checked}\n`;
  txt += `===========================\n\n`;

  const grouped = {
      "TERDAFTAR (ADA BIO)": summary.details.filter(d => d.isRegistered && d.bio),
      "TERDAFTAR (TANPA BIO)": summary.details.filter(d => d.isRegistered && !d.bio),
      "TIDAK TERDAFTAR": summary.details.filter(d => !d.isRegistered),
      "AKUN BUSINESS": summary.details.filter(d => d.type === 'business'),
      "META VERIFIED": summary.details.filter(d => d.isMetaVerified),
      "OFFICIAL BUSINESS ACCOUNT (OBA)": summary.details.filter(d => d.isOfficialBusinessAccount)
  };

  for (const [k, v] of Object.entries(grouped)) {
      if (v.length > 0) {
          txt += `--- ${k} (${v.length} Nomor) ---\n`;
          v.forEach(d => {
              txt += `${d.phone} ${d.bio ? `| Bio: ${d.bio}` : ''}\n`;
          });
          txt += `\n`;
      }
  }
  return Buffer.from(txt, "utf-8");
}

function getSummaryCaption(item: CheckHistoryItem): string {
  const summary = item.fullResult;
  if (!summary) return "<i>Data laporan tidak lengkap.</i>";

  const details = summary.details;
  const adaBio = details.filter(d => d.bio).length;
  const tanpaBio = details.filter(d => d.isRegistered && !d.bio).length;
  
  const d = new Date(item.timestamp);
  const dateStr = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()}, ${d.getHours().toString().padStart(2,'0')}.${d.getMinutes().toString().padStart(2,'0')}.${d.getSeconds().toString().padStart(2,'0')}`;
  const durasiSec = (item.durationMs / 1000).toFixed(1);

  return `📊 <b>RINGKASAN HASIL CEK BIO</b> 📊

ℹ️ <b>INFO LAPORAN CEK BIO:</b>
<blockquote>L 🤖 Sender: ${item.mode === "user" ? "User (Pribadi)" : "Global"} ”
L 👤 Nama: <b>${escapeHTML(getUser(item.userId)?.firstName || "User")}</b>
L 🆔 Laporan: <code>${item.id}</code>
L 🤖 Bot Aktif: 1/1
L 🕒 Waktu: ${dateStr}
L ⚡ Speed: Standar
L ⏱ Durasi: ${durasiSec} detik</blockquote>

📊 <b>STATISTIK NOMOR CEK BIO:</b>
<blockquote>L 🔢 Total Nomor Cek Bio: <b>${summary.total_checked} nomor</b> ”</blockquote>

<blockquote>L 📝 Nomor WhatsApp Ada Bio: <b>${adaBio}</b> ”
L 🚫 Nomor WhatsApp Tanpa Bio: <b>${tanpaBio}</b>
L ✅ Nomor Terdaftar WhatsApp : <b>${summary.registered_count}</b>
L ❌ Nomor Tidak Terdaftar WA: <b>${summary.unregistered_count}</b></blockquote>

📱 <b>DETAIL AKUN WA CEK BIO:</b>
<blockquote>L 💬 Jenis Akun Messenger: <b>${summary.regular_account_count}</b> ”
L 🏢 Jenis Akun Business: <b>${summary.business_account_count}</b>
L 🔷 Status Akun Meta Verified: <b>${summary.meta_verified_count}</b>
L ⭐ Status Akun OBA: <b>${summary.oba_count}</b></blockquote>

👇 <i>Gunakan tombol di bawah untuk melihat daftar lengkap dan detail.</i>`;
}

function getSummaryKeyboard(item: CheckHistoryItem) {
  const summary = item.fullResult;
  if (!summary) return Markup.inlineKeyboard([]);

  const d = summary.details;
  const adaBio = d.filter(x => x.bio).length;
  const tanpaBio = d.filter(x => x.isRegistered && !x.bio).length;
  const id = item.id;

  return Markup.inlineKeyboard([
      [Markup.button.callback(`📝 Ada Bio (${adaBio})`, `vcat_${id}_adabio`), Markup.button.callback(`🚫 Tanpa Bio (${tanpaBio})`, `vcat_${id}_tanpabio`)],
      [Markup.button.callback(`✅ Terdaftar (${summary.registered_count})`, `vcat_${id}_terdaftar`), Markup.button.callback(`❌ Tidak Terdaftar (${summary.unregistered_count})`, `vcat_${id}_tidakterdaftar`)],
      [Markup.button.callback(`💬 Messenger (${summary.regular_account_count})`, `vcat_${id}_messenger`), Markup.button.callback(`🏢 Business (${summary.business_account_count})`, `vcat_${id}_business`)],
      [Markup.button.callback(`🔷 Meta Verified (${summary.meta_verified_count})`, `vcat_${id}_meta`), Markup.button.callback(`⭐ OBA (${summary.oba_count})`, `vcat_${id}_oba`)]
  ]);
}

function filterCategory(summary: CheckSummary, cat: string) {
  let filtered: NumberCheckDetail[] = [];
  let title = "";
  switch(cat) {
      case "adabio": filtered = summary.details.filter(x => x.bio); title = "NOMOR ADA BIO"; break;
      case "tanpabio": filtered = summary.details.filter(x => x.isRegistered && !x.bio); title = "NOMOR TANPA BIO"; break;
      case "terdaftar": filtered = summary.details.filter(x => x.isRegistered); title = "NOMOR TERDAFTAR WHATSAPP"; break;
      case "tidakterdaftar": filtered = summary.details.filter(x => !x.isRegistered); title = "NOMOR TIDAK TERDAFTAR"; break;
      case "messenger": filtered = summary.details.filter(x => x.type === "regular"); title = "AKUN MESSENGER"; break;
      case "business": filtered = summary.details.filter(x => x.type === "business"); title = "AKUN BUSINESS"; break;
      case "meta": filtered = summary.details.filter(x => x.isMetaVerified); title = "META VERIFIED"; break;
      case "oba": filtered = summary.details.filter(x => x.isOfficialBusinessAccount); title = "OFFICIAL BUSINESS ACCOUNT (OBA)"; break;
  }
  return { filtered, title };
}

/* ===================== BOT INIT & MIDDLEWARES ===================== */

const bot = new Telegraf<BotContext>(BOT_TOKEN);
bot.use(session({ defaultSession: (): SessionData => ({}) }));

// Middleware Akses Kontrol & Maintenance
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const config = loadConfig();
  const isAdmin = ADMIN_IDS.includes(ctx.from.id);

  if (config.bannedUsers.includes(ctx.from.id) && !isAdmin) {
    // User di-banned, bot diam
    return;
  }

  if (config.maintenanceMode && !isAdmin) {
    if (ctx.message && 'text' in ctx.message && ctx.message.text === '/start') {
      await ctx.reply("🛠 <b>Sistem Sedang Maintenance</b>\nBot sedang dalam tahap perbaikan atau pembaruan. Silakan coba lagi nanti.", {parse_mode: "HTML"});
    }
    return;
  }

  return next();
});

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  let user = getUser(userId);
  if (!user) {
    user = { userId, username: ctx.from.username, firstName: ctx.from.first_name, tier: "free", createdAt: new Date().toISOString(), bots: [], lastMode: null };
    saveUser(user);
  }
  
  const config = loadConfig();
  await ctx.replyWithPhoto(
    { url: config.bgImage },
    {
      caption: generateMainMenuHTML(user),
      parse_mode: "HTML",
      message_effect_id: "5104841245755180586", 
      ...getReplyKeyboard(userId)
    } as any
  );
});

bot.action("back_main", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const user = getUser(ctx.from.id);
    if(!user) return;
    const config = loadConfig();
    await ctx.editMessageCaption(generateMainMenuHTML(user), { parse_mode: "HTML" }).catch(() => {});
  } catch(e) {}
});

/* ===================== NAVIGATOR ADMIN ===================== */

bot.hears("⚙️ Navigator Admin", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = undefined; // reset state
  
  const config = loadConfig();
  const text = `⚙️ <b>NAVIGATOR ADMIN</b>\n───────────────\nSelamat datang di Panel Admin. Pilih menu kendali sistem di bawah ini:\n\n🛠 <b>Status Maintenance:</b> ${config.maintenanceMode ? "🔴 AKTIF (User Terblokir)" : "🟢 NONAKTIF (Normal)"}\n🌍 <b>Sender Global:</b> ${config.globalSenderPhone ? `<code>${config.globalSenderPhone}</code>` : "Belum Diatur"}`;
  
  const kbd = Markup.inlineKeyboard([
    [Markup.button.callback("👥 Manajemen Pengguna", "admin_users"), Markup.button.callback("🌍 Sender Global", "admin_global")],
    [Markup.button.callback("🛠 Toggle Maintenance", "admin_maintenance"), Markup.button.callback("🖼 Ganti Background", "admin_bg")],
    [Markup.button.callback("📊 Statistik Sistem", "admin_stats"), Markup.button.callback("📢 Broadcast Pesan", "admin_broadcast")]
  ]);
  
  await ctx.replyWithPhoto({url: config.bgImage}, {caption: text, parse_mode: "HTML", ...kbd});
});

bot.action("admin_back", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = undefined;
  const config = loadConfig();
  const text = `⚙️ <b>NAVIGATOR ADMIN</b>\n───────────────\nSelamat datang di Panel Admin. Pilih menu kendali sistem di bawah ini:\n\n🛠 <b>Status Maintenance:</b> ${config.maintenanceMode ? "🔴 AKTIF (User Terblokir)" : "🟢 NONAKTIF (Normal)"}\n🌍 <b>Sender Global:</b> ${config.globalSenderPhone ? `<code>${config.globalSenderPhone}</code>` : "Belum Diatur"}`;
  
  const kbd = Markup.inlineKeyboard([
    [Markup.button.callback("👥 Manajemen Pengguna", "admin_users"), Markup.button.callback("🌍 Sender Global", "admin_global")],
    [Markup.button.callback("🛠 Toggle Maintenance", "admin_maintenance"), Markup.button.callback("🖼 Ganti Background", "admin_bg")],
    [Markup.button.callback("📊 Statistik Sistem", "admin_stats"), Markup.button.callback("📢 Broadcast Pesan", "admin_broadcast")]
  ]);
  await ctx.editMessageCaption(text, {parse_mode: "HTML", ...kbd}).catch(()=>{});
});

bot.action("admin_users", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const config = loadConfig();
  const text = `👥 <b>MANAJEMEN PENGGUNA</b>\n───────────────\nTotal Banned User: <b>${config.bannedUsers.length}</b>\n\nSilakan pilih tindakan:`;
  const kbd = Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Banned User", "admin_act_ban"), Markup.button.callback("✅ Unban User", "admin_act_unban")],
    [Markup.button.callback("◁ Kembali", "admin_back")]
  ]);
  await ctx.editMessageCaption(text, {parse_mode: "HTML", ...kbd}).catch(()=>{});
});

bot.action("admin_act_ban", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = "ban";
  await ctx.editMessageCaption("🚫 <b>BANNED USER</b>\nKirimkan <b>User ID Telegram</b> yang ingin Anda blokir dari sistem:", {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Batal", "admin_users")]])}).catch(()=>{});
});

bot.action("admin_act_unban", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = "unban";
  await ctx.editMessageCaption("✅ <b>UNBAN USER</b>\nKirimkan <b>User ID Telegram</b> yang ingin Anda pulihkan aksesnya:", {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Batal", "admin_users")]])}).catch(()=>{});
});

bot.action("admin_maintenance", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const config = loadConfig();
  config.maintenanceMode = !config.maintenanceMode;
  saveConfig(config);
  await ctx.answerCbQuery(`Maintenance Mode: ${config.maintenanceMode ? "AKTIF" : "NONAKTIF"}`).catch(()=>{});
  
  // Refresh Menu
  const text = `⚙️ <b>NAVIGATOR ADMIN</b>\n───────────────\nSelamat datang di Panel Admin. Pilih menu kendali sistem di bawah ini:\n\n🛠 <b>Status Maintenance:</b> ${config.maintenanceMode ? "🔴 AKTIF (User Terblokir)" : "🟢 NONAKTIF (Normal)"}\n🌍 <b>Sender Global:</b> ${config.globalSenderPhone ? `<code>${config.globalSenderPhone}</code>` : "Belum Diatur"}`;
  const kbd = Markup.inlineKeyboard([
    [Markup.button.callback("👥 Manajemen Pengguna", "admin_users"), Markup.button.callback("🌍 Sender Global", "admin_global")],
    [Markup.button.callback("🛠 Toggle Maintenance", "admin_maintenance"), Markup.button.callback("🖼 Ganti Background", "admin_bg")],
    [Markup.button.callback("📊 Statistik Sistem", "admin_stats"), Markup.button.callback("📢 Broadcast Pesan", "admin_broadcast")]
  ]);
  await ctx.editMessageCaption(text, {parse_mode: "HTML", ...kbd}).catch(()=>{});
});

bot.action("admin_bg", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = "bg";
  await ctx.editMessageCaption("🖼 <b>GANTI BACKGROUND BOT</b>\nSilakan kirimkan <b>URL Gambar/Foto</b> (http/https format .png/.jpg) yang ingin dijadikan latar belakang utama bot:", {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Batal", "admin_back")]])}).catch(()=>{});
});

bot.action("admin_broadcast", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = "broadcast";
  await ctx.editMessageCaption("📢 <b>BROADCAST PESAN</b>\nSilakan kirimkan pesan yang ingin Anda siarkan ke <b>seluruh pengguna</b> bot:", {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Batal", "admin_back")]])}).catch(()=>{});
});

bot.action("admin_stats", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const users = loadUsers();
  const history = loadHistory();
  
  let totalBots = 0;
  for (const u of users.values()) totalBots += (u.bots || []).length;
  
  const totalCek = history.length;
  const totalNomor = history.reduce((acc, h) => acc + h.totalNumbers, 0);

  const text = `📊 <b>STATISTIK SISTEM GLOBAL</b>\n───────────────\n👥 Total Registrasi User: <b>${users.size}</b>\n🤖 Total Bot Pribadi Taut: <b>${totalBots}</b>\n🔍 Total Laporan Dibuat: <b>${totalCek}</b>\n📱 Total Nomor Dieksekusi: <b>${totalNomor}</b>\n\n🔧 Mode: ${loadConfig().maintenanceMode ? "Maintenance" : "Normal"}`;
  
  await ctx.editMessageCaption(text, {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Kembali", "admin_back")]])}).catch(()=>{});
});

// SENDER GLOBAL MANAGEMENT
bot.action("admin_global", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const config = loadConfig();
  const isOnline = engine.isSessionConnected(GLOBAL_SESSION_ID);
  const info = engine.getSessionPairingInfo(GLOBAL_SESSION_ID);

  let text = `🌍 <b>MONITORING SENDER GLOBAL</b>\n───────────────\n`;
  if (config.globalSenderPhone) {
    text += `📱 Nomor: <code>${config.globalSenderPhone}</code>\n🟢 Status Runtime: ${info?.pairingStatus ?? "Offline"}\n📡 Koneksi: ${isOnline ? "Tersambung (Siap)" : "Terputus"}\n⚠️ Last Error: ${info?.lastError ?? "-"}`;
  } else {
    text += `<i>Belum ada nomor Sender Global yang diatur.</i>`;
  }

  const kbd: any[][] = [];
  kbd.push([Markup.button.callback("➕ Pair / Ganti Nomor Global", "admin_act_global_pair")]);
  if (config.globalSenderPhone) {
    kbd.push([Markup.button.callback("▶️ Start / Retry Koneksi", "admin_act_global_start")]);
    kbd.push([Markup.button.callback("🗑 Hapus Sesi Global", "admin_act_global_del")]);
  }
  kbd.push([Markup.button.callback("◁ Kembali", "admin_back")]);

  await ctx.editMessageCaption(text, {parse_mode: "HTML", ...Markup.inlineKeyboard(kbd)}).catch(()=>{});
});

bot.action("admin_act_global_pair", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  ctx.session.adminAction = "global_pair";
  await ctx.editMessageCaption("🌍 <b>PAIRING SENDER GLOBAL</b>\nKirimkan nomor WhatsApp yang ingin diatur sebagai Sender Global (Server Pusat). Pastikan formatnya benar, misal: 628xxxx", {parse_mode:"HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Batal", "admin_global")]])}).catch(()=>{});
});

bot.action("admin_act_global_start", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  const config = loadConfig();
  if (!config.globalSenderPhone) return;
  await ctx.answerCbQuery("Starting global session...").catch(()=>{});
  const msg = await ctx.reply("⏳ Menghubungkan Global Sender...");
  pairingMessageTracker[GLOBAL_SESSION_ID] = msg.message_id;
  await startGlobalBotSession(ctx, config.globalSenderPhone);
});

bot.action("admin_act_global_del", async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id)) return;
  await ctx.answerCbQuery("Menghapus sesi global...").catch(()=>{});
  await engine.deleteSession(GLOBAL_SESSION_ID);
  const config = loadConfig();
  config.globalSenderPhone = null;
  saveConfig(config);
  await ctx.editMessageCaption("✅ <b>Sender Global Dihapus</b>", {parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◁ Kembali", "admin_global")]])}).catch(()=>{});
});

async function startGlobalBotSession(ctx: Context | null, phone: string) {
  const config: SessionConfig = { sessionId: GLOBAL_SESSION_ID, senderType: "global_sender", label: "Global Sender" };
  const options: InitSessionOptions = {
    phoneNumber: phone,
    onPairingCode: async (_sid, code) => {
      const cfg = loadConfig(); cfg.globalSenderPhone = phone; saveConfig(cfg);
      if (ctx) {
        const text = `🌍 <b>KODE PAIRING GLOBAL</b>\n───────────────\nNomor: <code>${phone}</code>\nKode: <code>${code}</code>`;
        if (pairingMessageTracker[GLOBAL_SESSION_ID]) {
           await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[GLOBAL_SESSION_ID], undefined, text, {parse_mode: "HTML"}).catch(()=>{});
        } else {
           const msg = await ctx.reply(text, {parse_mode: "HTML"});
           pairingMessageTracker[GLOBAL_SESSION_ID] = msg.message_id;
        }
      }
    },
    onConnected: async () => {
      globalSessionReady = true;
      if (ctx) {
        const text = `✅ <b>GLOBAL SENDER TERHUBUNG</b>\nNomor: <code>${phone}</code> siap melayani semua user.`;
        if (pairingMessageTracker[GLOBAL_SESSION_ID]) {
           await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[GLOBAL_SESSION_ID], undefined, text, {parse_mode: "HTML"}).catch(()=>{});
           delete pairingMessageTracker[GLOBAL_SESSION_ID];
        } else await ctx.reply(text, {parse_mode: "HTML"});
      }
    },
    onFailed: async (_sid, reason) => {
      globalSessionReady = false;
      if (ctx) {
        const text = `❌ <b>GLOBAL SENDER GAGAL</b>\nError: ${reason}`;
        if (pairingMessageTracker[GLOBAL_SESSION_ID]) {
           await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[GLOBAL_SESSION_ID], undefined, text, {parse_mode: "HTML"}).catch(()=>{});
        } else await ctx.reply(text, {parse_mode: "HTML"});
      }
    }
  };
  await engine.createSession(config, options);
}

/* ===================== REPLY KEYBOARD HANDLERS ===================== */

bot.hears("📱 Cek Bio", async (ctx) => {
  ctx.session.waitingForBotNumber = false; 
  const config = loadConfig();
  const text = `📱 <b>PILIH SENDER CEK BIO</b>\n───────────────\nPilih jalur pengiriman yang ingin Anda gunakan untuk proses pengecekan:\n\n🌍 <b>SENDER GLOBAL</b>\n<blockquote>Menggunakan sistem server pusat. Anda tidak perlu menautkan nomor pribadi. Kecepatan dan antrean bergantung pada kepadatan pengguna global.</blockquote>\n\n👤 <b>SENDER USER (PRIBADI)</b>\n<blockquote>Menggunakan nomor WhatsApp Anda sendiri yang telah ditautkan ke bot. Lebih privat, independen, dan terbebas dari antrean server global.</blockquote>\n\n👇 <i>Silakan pilih sender di bawah ini:</i>`;
  
  await ctx.replyWithPhoto(
    { url: config.bgImage },
    {
      caption: text,
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("👤 SENDER USER", "mode_user")],
        [Markup.button.callback("🌍 SENDER GLOBAL", "mode_global")]
      ])
    }
  );
});

bot.hears("🤖 Daftar Bot", async (ctx) => {
  ctx.session.waitingForBotNumber = false;
  const user = getUser(ctx.from.id);
  const config = loadConfig();
  if (!user || !user.bots || user.bots.length === 0) {
    await ctx.replyWithPhoto(
      { url: config.bgImage },
      {
        caption: "📭 <b>Belum ada bot yang ditambahkan.</b>\nSilakan tambahkan nomor terlebih dahulu.",
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([[Markup.button.callback("➕ Tambah Bot", "menu_tambah_bot")]])
      }
    );
    return;
  }
  let text = "🤖 <b>DAFTAR BOT USER</b>\n───────────────\nBerikut adalah daftar nomor bot pribadi Anda:\n\n";
  const keyboard: any[][] = []; 
  for (const b of user.bots) {
    const online = engine.isSessionConnected(b.id);
    text += `• <code>${b.phoneNumber}</code> - ${online ? "✅ Online" : "❌ Offline"} (${b.pairingStatus ?? "idle"})\n`;
    keyboard.push([Markup.button.callback(`⚙️ Kelola ${b.phoneNumber}`, `detail_bot_${b.id}`)]);
  }
  await ctx.replyWithPhoto({ url: config.bgImage }, { caption: text, parse_mode: "HTML", ...Markup.inlineKeyboard(keyboard) });
});

bot.hears("📜 Riwayat", async (ctx) => {
  ctx.session.waitingForBotNumber = false;
  const config = loadConfig();
  const rows = getUserHistory(ctx.from.id, 10);
  if (!rows.length) {
    await ctx.replyWithPhoto(
      { url: config.bgImage },
      { caption: "📭 <b>Belum ada riwayat pengecekan.</b>\nRiwayat akan muncul setelah Anda melakukan Cek Bio.", parse_mode: "HTML" }
    );
    return;
  }
  const keyboard: any[][] = [];
  rows.forEach((h, i) => {
    keyboard.push([Markup.button.callback(`${i + 1}. ${new Date(h.timestamp).toLocaleString("id-ID")} (${h.totalNumbers} No)`, `history_${h.id}`)]);
  });
  await ctx.replyWithPhoto(
    { url: config.bgImage },
    { caption: "📜 <b>RIWAYAT CEK BIO</b>\n───────────────\nPilih riwayat untuk melihat laporan detail:", parse_mode: "HTML", ...Markup.inlineKeyboard(keyboard) }
  );
});

bot.hears("➕ Tambah Bot", async (ctx) => {
  ctx.session.waitingForBotNumber = true;
  ctx.session.pendingCheck = undefined;
  const config = loadConfig();
  const text = `➕ <b>TAMBAH BOT USER</b>\n───────────────\n<blockquote>Kirim nomor WhatsApp yang akan dijadikan sender. ”\nPastikan nomor aktif dan siap menerima kode pairing.\n\n<b>Contoh Format:</b>\n6281234567890\n+6281234567890\n+748394834\n2348948394</blockquote>\n<i>Kirim nomor sekarang:</i>`;
  await ctx.replyWithPhoto({ url: config.bgImage }, { caption: text, parse_mode: "HTML" });
});

bot.action("menu_tambah_bot", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    ctx.session.waitingForBotNumber = true;
    ctx.session.pendingCheck = undefined;
    const text = `➕ <b>TAMBAH BOT USER</b>\n───────────────\n<blockquote>Kirim nomor WhatsApp yang akan dijadikan sender. ”\nPastikan nomor aktif dan siap menerima kode pairing.\n\n<b>Contoh Format:</b>\n6281234567890\n+6281234567890\n+748394834\n2348948394</blockquote>\n<i>Kirim nomor sekarang:</i>`;
    await ctx.editMessageCaption(text, { parse_mode: "HTML" }).catch(() => {});
  } catch(e) {}
});

/* ===================== ADD BOT & PAIRING (USER) ===================== */

async function startUserBotSession(ctx: Context | null, userId: number, phone: string, sessionId: string) {
    const config: SessionConfig = { sessionId, senderType: "user_sender", label: `User ${userId}` };
    const options: InitSessionOptions = {
      phoneNumber: phone,
      onPairingCode: async (_sid, code) => {
        upsertBot(userId, { id: sessionId, phoneNumber: phone, isActive: false, addedAt: new Date().toISOString(), pairingStatus: "code_sent", lastPairingCode: code, lastPairingAt: new Date().toISOString(), lastError: null });
        if (ctx) {
            const text = `🔐 <b>KODE PAIRING</b>\n───────────────\n👤 <b>Sender:</b> <code>${phone}</code>\n\nKode pairing: <code>${code}</code>\n\n<i>Masukkan kode ini di aplikasi WhatsApp Anda.</i>`;
            const kbd = Markup.inlineKeyboard([[Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`), Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)]]);
            if (pairingMessageTracker[sessionId]) {
                await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[sessionId], undefined, text, { parse_mode: "HTML", ...kbd }).catch(()=>{});
            } else {
                const msg = await ctx.reply(text, { parse_mode: "HTML", ...kbd });
                pairingMessageTracker[sessionId] = msg.message_id;
            }
        }
      },
      onConnected: async () => {
        upsertBot(userId, { id: sessionId, phoneNumber: phone, isActive: true, addedAt: new Date().toISOString(), pairingStatus: "connected", lastError: null });
        if (ctx) {
            const text = `✅ <b>KONEKSI BERHASIL</b>\n───────────────\n👤 <b>Sender:</b> <code>${phone}</code>\n\n✅ Perangkat berhasil terhubung dan siap digunakan!`;
            if (pairingMessageTracker[sessionId]) {
                await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[sessionId], undefined, text, { parse_mode: "HTML" }).catch(()=>{});
                delete pairingMessageTracker[sessionId]; 
            } else {
                await ctx.reply(text, { parse_mode: "HTML" });
            }
        }
      },
      onFailed: async (_sid, reason) => {
        upsertBot(userId, { id: sessionId, phoneNumber: phone, isActive: false, addedAt: new Date().toISOString(), pairingStatus: "failed", lastError: reason });
        if (ctx) {
            const text = `❌ <b>KONEKSI GAGAL</b>\n───────────────\n👤 <b>Sender:</b> <code>${phone}</code>\n\n⚠️ Error/Terputus: ${escapeHTML(reason)}`;
            const kbd = Markup.inlineKeyboard([[Markup.button.callback("🔁 Try Again", `pair_try_${sessionId}`), Markup.button.callback("🛑 Cancel", `pair_cancel_${sessionId}`)]]);
            if (pairingMessageTracker[sessionId]) {
                await ctx.telegram.editMessageText(ctx.chat!.id, pairingMessageTracker[sessionId], undefined, text, { parse_mode: "HTML", ...kbd }).catch(()=>{});
            } else {
                await ctx.reply(text, { parse_mode: "HTML", ...kbd });
            }
        }
      },
    };
    await engine.createSession(config, options);
}

async function initAllSessions() {
    // 1. Init Global
    const cfg = loadConfig();
    if (cfg.globalSenderPhone) {
      await startGlobalBotSession(null, cfg.globalSenderPhone).catch(e => console.log("Global session init error", e));
    }
    // 2. Init Users
    const users = loadUsers();
    for (const user of users.values()) {
        if (!user.bots) continue;
        for (const b of user.bots) {
            if (b.pairingStatus === "connected" || b.isActive) {
                await startUserBotSession(null, user.userId, b.phoneNumber, b.id);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
}

bot.action(/^pair_try_(.+)$/, async (ctx) => {
  try {
    const sessionId = (ctx.match as RegExpExecArray)[1];
    const b = getUser(ctx.from.id)?.bots?.find((x) => x.id === sessionId);
    if (!b) return ctx.answerCbQuery("Bot tidak ditemukan", { show_alert: true });

    const info = engine.getSessionPairingInfo(sessionId);
    if (!info) return ctx.answerCbQuery("Sesi tidak aktif. Silakan hapus dan tambah ulang bot.", { show_alert: true });

    pairingMessageTracker[sessionId] = ctx.callbackQuery.message!.message_id;
    await ctx.answerCbQuery("Meminta ulang kode...").catch(() => {});
    await engine.retryPairingCode(sessionId, b.phoneNumber);
  } catch (e: unknown) {
    await ctx.answerCbQuery(e instanceof Error ? e.message : "Retry gagal", { show_alert: true }).catch(() => {});
  }
});

bot.action(/^pair_cancel_(.+)$/, async (ctx) => {
  try {
    const sessionId = (ctx.match as RegExpExecArray)[1];
    await engine.cancelPairing(sessionId);
    removeBotFromUser(ctx.from.id, sessionId);
    await ctx.answerCbQuery("Pairing dibatalkan.").catch(() => {});
    await ctx.editMessageText("🛑 <b>PAIRING DIBATALKAN</b>\n───────────────\nProses pairing telah dihentikan dan data dihapus dari sistem.", { parse_mode: "HTML" }).catch(() => {});
  } catch(e) {}
});

bot.action(/^start_bot_(.+)$/, async (ctx) => {
  try {
    const sessionId = (ctx.match as RegExpExecArray)[1];
    const b = getUser(ctx.from.id)?.bots?.find((x) => x.id === sessionId);
    if (!b) return ctx.answerCbQuery("Bot tidak ditemukan", { show_alert: true });

    await ctx.answerCbQuery("Memulai ulang bot...").catch(() => {});
    const msg = await ctx.reply("⏳ Menghubungkan ke server WhatsApp...");
    pairingMessageTracker[sessionId] = msg.message_id;
    await startUserBotSession(ctx, ctx.from.id, b.phoneNumber, sessionId);
  } catch(e) {}
});

bot.action(/^detail_bot_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const sessionId = (ctx.match as RegExpExecArray)[1];
    const b = getUser(ctx.from.id)?.bots?.find((x) => x.id === sessionId);
    if (!b) return ctx.answerCbQuery("Bot tidak ditemukan", { show_alert: true });

    const isRuntimeConnected = engine.isSessionConnected(b.id);
    const engineInfo = engine.getSessionPairingInfo(b.id);

    const detailText = `🔍 <b>DETAIL BOT</b>\n───────────────\n📱 Nomor: <code>${b.phoneNumber}</code>\n🔋 Aktif DB: ${b.isActive ? "Ya" : "Tidak"}\n📡 Status Runtime: ${engineInfo?.pairingStatus ?? "Offline"}\n🟢 Connected: ${isRuntimeConnected ? "Ya" : "Tidak"}\n⚠️ Last Error: ${escapeHTML(b.lastError ?? "-")}`;
    const kbd: any[][] = [];
    if (!isRuntimeConnected) {
      kbd.push([Markup.button.callback("▶️ Start / Restart Bot", `start_bot_${sessionId}`)]);
    }
    kbd.push([Markup.button.callback("🗑 Hapus Bot", `delete_bot_${sessionId}`)]);
    await ctx.editMessageCaption(detailText, { parse_mode: "HTML", ...Markup.inlineKeyboard(kbd) }).catch(() => {});
  } catch(e){}
});

bot.action(/^delete_bot_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery("Menghapus bot...").catch(() => {});
    const sessionId = (ctx.match as RegExpExecArray)[1];
    await engine.deleteSession(sessionId).catch(console.error);
    removeBotFromUser(ctx.from.id, sessionId);
    await ctx.editMessageCaption("✅ <b>Bot berhasil dihapus.</b>", { parse_mode: "HTML" }).catch(() => {});
  } catch(e){}
});

/* ===================== CHECK MODE ===================== */

bot.action("mode_user", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const actives = (getUser(ctx.from.id)?.bots || []).filter((b) => b.isActive && engine.isSessionConnected(b.id));

    if (actives.length === 0) {
      await ctx.editMessageCaption("❌ <b>TIDAK ADA BOT AKTIF</b>\n───────────────\nSilakan tambahkan atau nyalakan bot Anda terlebih dahulu.", { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    if (actives.length === 1) {
      ctx.session.pendingCheck = { mode: "user", botId: actives[0].id, botPhone: actives[0].phoneNumber };
      await ctx.editMessageCaption("📄 <b>KIRIM DAFTAR NOMOR</b>\n───────────────\nKirim nomor yang ingin dicek (teks manual atau file .txt, maksimal 500 nomor per sesi).", {parse_mode: "HTML"}).catch(() => {});
      return;
    }

    const keyboard: any[][] = [];
    actives.forEach((b) => keyboard.push([Markup.button.callback(`Pilih ${b.phoneNumber}`, `select_bot_${b.id}`)]));
    await ctx.editMessageCaption("📱 <b>PILIH BOT AKTIF</b>\n───────────────\nPilih nomor pengirim yang ingin digunakan:", {parse_mode: "HTML", ...Markup.inlineKeyboard(keyboard)}).catch(() => {});
  } catch(e){}
});

bot.action(/^select_bot_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const sessionId = (ctx.match as RegExpExecArray)[1];
    const b = getUser(ctx.from.id)?.bots?.find((x) => x.id === sessionId);
    if (!b || !(b.isActive && engine.isSessionConnected(b.id))) return ctx.answerCbQuery("Bot offline", { show_alert: true });

    ctx.session.pendingCheck = { mode: "user", botId: b.id, botPhone: b.phoneNumber };
    await ctx.editMessageCaption("📄 <b>KIRIM DAFTAR NOMOR</b>\n───────────────\nKirim nomor yang ingin dicek (teks manual atau file .txt, maksimal 500 nomor per sesi).", {parse_mode: "HTML"}).catch(() => {});
  } catch(e){}
});

bot.action("mode_global", async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    if (!globalSessionReady || !engine.isSessionConnected(GLOBAL_SESSION_ID)) {
      await ctx.editMessageCaption("❌ Global sender sedang offline atau dalam perbaikan.").catch(() => {});
      return;
    }
    ctx.session.pendingCheck = { mode: "global", botId: GLOBAL_SESSION_ID };
    await ctx.editMessageCaption("📄 <b>KIRIM DAFTAR NOMOR</b>\n───────────────\nKirim nomor yang ingin dicek (teks manual atau file .txt, maksimal 500 nomor per sesi).", {parse_mode:"HTML"}).catch(() => {});
  } catch(e){}
});

bot.action(/^history_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery("Memuat laporan...").catch(() => {});
    const id = (ctx.match as RegExpExecArray)[1];
    const item = getUserHistory(ctx.from.id, 100).find((x) => x.id === id);
    if (!item || !item.fullResult) return ctx.answerCbQuery("Riwayat tidak lengkap", { show_alert: true });
    
    const txtBuffer = generateTxtReport(item.fullResult, item.id);
    await ctx.replyWithDocument(
      { source: txtBuffer, filename: `PNR_Report_${item.id}_${item.totalNumbers}Nomor.txt` },
      { caption: getSummaryCaption(item), parse_mode: "HTML", ...getSummaryKeyboard(item) }
    );
  } catch(e){}
});

/* ===================== PAGINATION & CATEGORY LOGIC ===================== */

bot.action(/^vcat_([^_]+)_([^_]+)(?:_(\d+))?$/, async (ctx) => {
  try {
    const reportId = ctx.match[1];
    const cat = ctx.match[2];
    const pageStr = ctx.match[3];
    
    const item = getUserHistory(ctx.from.id, 100).find(x => x.id === reportId);
    
    if (!item || !item.fullResult) {
        return ctx.answerCbQuery("Report tidak valid/sudah kadaluarsa.", {show_alert:true}).catch(()=>{});
    }
    
    await ctx.answerCbQuery().catch(() => {});
    const { filtered, title } = filterCategory(item.fullResult, cat);

    const itemsPerPage = 10;
    const totalPages = Math.ceil(filtered.length / itemsPerPage) || 1;
    const page = Math.min(Math.max(1, parseInt(pageStr) || 1), totalPages);

    const startIdx = (page - 1) * itemsPerPage;
    const endIdx = page * itemsPerPage;
    const show = filtered.slice(startIdx, endIdx);

    let text = `✅ <b>DAFTAR LENGKAP ${title} (${filtered.length})</b>\n───────────────\n`;
    text += `Halaman : ${page}/${totalPages}\n───────────────\n`;
    
    if (filtered.length === 0) {
        text += "<i>Tidak ada data di kategori ini.</i>\n───────────────\n";
    } else {
        show.forEach((x, i) => { 
            text += `${startIdx + i + 1}. <code>${x.phone}</code>\n`; 
        });
        text += `───────────────\n`;
    }
    text += `👇 <i>Pilih aksi di bawah ini:</i>`;

    const kbd = [];
    const navRow = [];
    if (page > 1) {
        navRow.push(Markup.button.callback("◀️ Prev", `vcat_${reportId}_${cat}_${page - 1}`));
    }
    if (page < totalPages) {
        navRow.push(Markup.button.callback("Next ▶️", `vcat_${reportId}_${cat}_${page + 1}`));
    }
    if (navRow.length > 0) kbd.push(navRow);

    if (filtered.length > 0) {
        kbd.push([
            Markup.button.callback("📄 Download TXT", `dlcat_${reportId}_${cat}_txt`),
            Markup.button.callback("📊 Download XLSX", `dlcat_${reportId}_${cat}_xlsx`)
        ]);
    }
    kbd.push([Markup.button.callback("◁ Kembali", `vsum_${reportId}`)]);

    await ctx.editMessageCaption(text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(kbd)
    }).catch(()=>{});
  } catch (error) {}
});

bot.action(/^vsum_([^_]+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const reportId = ctx.match[1];
    const item = getUserHistory(ctx.from.id, 100).find(x => x.id === reportId);
    if (!item) return;
    await ctx.editMessageCaption(getSummaryCaption(item), { parse_mode: "HTML", ...getSummaryKeyboard(item) }).catch(()=>{});
  } catch(e){}
});

bot.action(/^dlcat_([^_]+)_(.+?)_(.+)$/, async (ctx) => {
  try {
    const reportId = ctx.match[1];
    const cat = ctx.match[2];
    const format = ctx.match[3];
    
    const item = getUserHistory(ctx.from.id, 100).find(x => x.id === reportId);
    if (!item || !item.fullResult) return ctx.answerCbQuery("Report tidak valid.", {show_alert:true});
    
    const { filtered, title } = filterCategory(item.fullResult, cat);
    if (filtered.length === 0) return ctx.answerCbQuery("Tidak ada data untuk diunduh.", {show_alert:true});
    
    await ctx.answerCbQuery(`Menyiapkan ${format.toUpperCase()}...`).catch(() => {});
    const nums = filtered.map(x => x.phone);
    const safeTitle = title.replace(/[^a-zA-Z0-9]/g, "_");
    
    if (format === "txt") {
        const content = `DAFTAR LENGKAP ${title}\nTotal: ${nums.length}\n\n${nums.join("\n")}`;
        await ctx.replyWithDocument({ source: Buffer.from(content, "utf-8"), filename: `PNR_Detail_${safeTitle}_${reportId}.txt` });
    } else if (format === "xlsx") {
        const buffer = await createExcelBuffer(nums, title);
        await ctx.replyWithDocument({ source: buffer, filename: `PNR_Detail_${safeTitle}_${reportId}.xlsx` });
    }
  } catch(e){}
});

/* ===================== LOGIC CEK BIO ===================== */

async function handleCheckNumbers(ctx: BotContext, textContent: string) {
  if (!ctx.session.pendingCheck) return;
  const pending = ctx.session.pendingCheck;
  ctx.session.pendingCheck = undefined;

  const numbers = parseNumbersFromText(textContent);
  if (!numbers.length) return ctx.reply("❌ Tidak ada nomor valid yang ditemukan.");

  const max = 500; 
  if (numbers.length > max) return ctx.reply(`❌ Ditemukan ${numbers.length} nomor. Maksimal ${max} nomor dalam sekali cek.`);

  const progress = await ctx.reply("⏳ <b>PROSES CEK BIO SEDANG BERJALAN!</b>\n───────────────\nMohon tunggu, sistem sedang memeriksa daftar nomor secara detail dan akurat...", {parse_mode:"HTML"});
  
  try {
    const start = Date.now();
    const result = await engine.checkNumbers(pending.botId, numbers, { batchSize: 5, concurrencyPerBatch: 3, minBatchDelayMs: 500, maxBatchDelayMs: 1500, perNumberTimeoutMs: 8000 });
    const durationMs = Date.now() - start;
    
    const uniqueNum = Math.floor(Math.random() * 9000) + 1000;
    const reportId = `PNR${Date.now().toString().slice(-4)}${uniqueNum}`;

    const item: CheckHistoryItem = { id: reportId, userId: ctx.from!.id, mode: pending.mode, botPhone: pending.botPhone, timestamp: new Date().toISOString(), totalNumbers: result.total_checked, durationMs, fullResult: result };
    addHistoryItem(item);

    await ctx.telegram.editMessageText(ctx.chat!.id, progress.message_id, undefined, `✅ <b>PROSES CEK BIO SELESAI!</b>\n───────────────\nLaporan hasil cek bio telah berhasil disusun. Anda dapat mengunduh dokumen laporan di pesan berikutnya.`, {parse_mode:"HTML"}).catch(()=>{});

    const txtBuffer = generateTxtReport(result, reportId);
    await ctx.replyWithDocument(
      { source: txtBuffer, filename: `PNR_Report_${reportId}_${result.total_checked}Nomor.txt` },
      {
        caption: getSummaryCaption(item),
        parse_mode: "HTML",
        message_effect_id: "5046509860389126442", 
        ...getSummaryKeyboard(item)
      } as any
    );

  } catch (e: unknown) {
    await ctx.telegram.editMessageText(ctx.chat!.id, progress.message_id, undefined, `❌ Error: ${e instanceof Error ? e.message : "Unknown error"}`).catch(()=>{});
  }
}

/* ===================== MESSAGE HANDLERS ===================== */

bot.on(message("document"), async (ctx) => {
  if (!ctx.session.pendingCheck) return;

  const doc = ctx.message.document;
  if (doc.mime_type !== "text/plain" && !doc.file_name?.endsWith(".txt")) {
    return ctx.reply("❌ Silakan kirim file dengan format .txt");
  }

  const waitMsg = await ctx.reply("⏳ Membaca dan memproses file dokumen Anda...");
  try {
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileUrl.href);
    const fileContent = String(response.data);
    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(()=>{});
    await handleCheckNumbers(ctx, fileContent);
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, "❌ Gagal membaca atau memproses file dokumen.").catch(()=>{});
  }
});

bot.on(message("text"), async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // STATE: ADMIN BROADCAST
  if (ctx.session.adminAction === "broadcast" && ADMIN_IDS.includes(userId)) {
    ctx.session.adminAction = undefined;
    const users = loadUsers();
    let success = 0, failed = 0;
    const broadcastMsg = await ctx.reply("📢 Mengirim broadcast...");
    
    for (const uid of users.keys()) {
      try {
        await bot.telegram.sendMessage(uid, `📢 <b>INFORMASI SISTEM</b>\n───────────────\n${escapeHTML(text)}`, {parse_mode: "HTML"});
        success++;
      } catch (e) { failed++; }
    }
    return ctx.telegram.editMessageText(ctx.chat.id, broadcastMsg.message_id, undefined, `✅ <b>Broadcast Selesai</b>\nBerhasil: ${success}\nGagal: ${failed}`, {parse_mode: "HTML"});
  }

  // STATE: ADMIN CHANGE BACKGROUND
  if (ctx.session.adminAction === "bg" && ADMIN_IDS.includes(userId)) {
    ctx.session.adminAction = undefined;
    if (!text.startsWith("http")) return ctx.reply("❌ Format URL tidak valid.");
    const config = loadConfig();
    config.bgImage = text;
    saveConfig(config);
    return ctx.reply("✅ Background berhasil diubah!");
  }

  // STATE: ADMIN BAN USER
  if (ctx.session.adminAction === "ban" && ADMIN_IDS.includes(userId)) {
    ctx.session.adminAction = undefined;
    const targetId = parseInt(text, 10);
    if (isNaN(targetId)) return ctx.reply("❌ ID User tidak valid.");
    const config = loadConfig();
    if (!config.bannedUsers.includes(targetId)) {
      config.bannedUsers.push(targetId);
      saveConfig(config);
    }
    return ctx.reply(`✅ User ID <code>${targetId}</code> berhasil di-Banned.`, {parse_mode: "HTML"});
  }

  // STATE: ADMIN UNBAN USER
  if (ctx.session.adminAction === "unban" && ADMIN_IDS.includes(userId)) {
    ctx.session.adminAction = undefined;
    const targetId = parseInt(text, 10);
    if (isNaN(targetId)) return ctx.reply("❌ ID User tidak valid.");
    const config = loadConfig();
    config.bannedUsers = config.bannedUsers.filter(id => id !== targetId);
    saveConfig(config);
    return ctx.reply(`✅ Akses User ID <code>${targetId}</code> berhasil dipulihkan.`, {parse_mode: "HTML"});
  }

  // STATE: ADMIN PAIR GLOBAL SENDER
  if (ctx.session.adminAction === "global_pair" && ADMIN_IDS.includes(userId)) {
    ctx.session.adminAction = undefined;
    const phone = sanitizePhone(text);
    if (!/^\d{8,16}$/.test(phone)) return ctx.reply("❌ Format nomor salah.");
    const msg = await ctx.reply("⏳ Menghubungkan Global Sender...");
    pairingMessageTracker[GLOBAL_SESSION_ID] = msg.message_id;
    await startGlobalBotSession(ctx, phone);
    return;
  }

  // STATE: USER PAIRING NEW BOT
  if (ctx.session.waitingForBotNumber) {
    ctx.session.waitingForBotNumber = false;
    const phone = sanitizePhone(text);
    if (!/^\d{8,16}$/.test(phone)) return ctx.reply("❌ Format nomor salah.");

    const existing = getUser(userId)?.bots?.find((b) => b.phoneNumber === phone);
    if (existing) {
        const isConnected = engine.isSessionConnected(existing.id);
        if (existing.isActive && isConnected) return ctx.reply("❌ Nomor sudah terdaftar & aktif.");
        if (existing.isActive && !isConnected) return ctx.reply(`⚠️ Nomor terdaftar tapi offline.\nSilakan jalankan ulang bot.`, Markup.inlineKeyboard([[Markup.button.callback("▶️ Start / Restart Bot", `start_bot_${existing.id}`)]]));
        return ctx.reply(`⚠️ Nomor sudah ada tapi belum terhubung.`, Markup.inlineKeyboard([[Markup.button.callback("🔁 Try Again", `pair_try_${existing.id}`)],[Markup.button.callback("🛑 Cancel", `pair_cancel_${existing.id}`)]]));
    }

    const sessionId = `user_${userId}_${phone}`;
    upsertBot(userId, { id: sessionId, phoneNumber: phone, isActive: false, addedAt: new Date().toISOString(), pairingStatus: "pending_pairing" });

    const msg = await ctx.reply("⏳ Menghubungkan ke server WhatsApp...");
    pairingMessageTracker[sessionId] = msg.message_id;
    await startUserBotSession(ctx, userId, phone, sessionId);
    return;
  }

  // STATE: USER SENDING TEXT NUMBERS TO CHECK
  if (ctx.session.pendingCheck) {
    await handleCheckNumbers(ctx, text);
  }
});

/* ===================== START ===================== */

async function main() {
  await initAllSessions(); 
  await bot.launch();
  console.log("🤖 Panorama Bot running...");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch(console.error);
