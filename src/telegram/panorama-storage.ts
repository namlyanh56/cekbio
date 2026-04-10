import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "panorama_data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const USERS_FILE = path.join(DATA_DIR, "users.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");

export interface PanoramaUser {
  userId: number;
  username?: string;
  firstName?: string;
  tier: "free" | "vip";
  createdAt: string;
  // Bot WhatsApp milik user (sender user)
  bots: PanoramaBot[];
  // Preferensi mode terakhir
  lastMode: "user" | "global" | null;
}

export interface PanoramaBot {
  id: string; // sessionId
  phoneNumber: string;
  isActive: boolean;
  addedAt: string;
  lastUsed?: string;
  pairingCode?: string | null;
}

export interface CheckHistoryItem {
  id: string;
  userId: number;
  mode: "user" | "global";
  botPhone?: string; // jika mode user
  timestamp: string;
  totalNumbers: number;
  registeredCount: number;
  unregisteredCount: number;
  businessCount: number;
  regularCount: number;
  metaVerifiedCount: number;
  obaCount: number;
  durationMs: number;
  detailsFile?: string; // path ke file txt/xlsx jika disimpan
  numbersList: string[]; // daftar nomor yang dicek
  registeredNumbers: string[]; // nomor terdaftar
}

// Load data
export function loadUsers(): Map<number, PanoramaUser> {
  if (!fs.existsSync(USERS_FILE)) return new Map();
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  const map = new Map<number, PanoramaUser>();
  for (const [key, val] of Object.entries(data)) {
    map.set(Number(key), val as PanoramaUser);
  }
  return map;
}

export function saveUsers(users: Map<number, PanoramaUser>) {
  const obj: Record<number, PanoramaUser> = {};
  for (const [k, v] of users.entries()) obj[k] = v;
  fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2));
}

export function loadHistory(): CheckHistoryItem[] {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
}

export function saveHistory(history: CheckHistoryItem[]) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// Helper: get user
export function getUser(userId: number): PanoramaUser | undefined {
  const users = loadUsers();
  return users.get(userId);
}

export function saveUser(user: PanoramaUser) {
  const users = loadUsers();
  users.set(user.userId, user);
  saveUsers(users);
}

// Tambah bot ke user
export function addBotToUser(userId: number, bot: PanoramaBot) {
  const users = loadUsers();
  const user = users.get(userId);
  if (!user) throw new Error("User not found");
  // Cek duplikat
  const existing = user.bots.find(b => b.phoneNumber === bot.phoneNumber);
  if (existing) throw new Error("Bot dengan nomor itu sudah ada");
  user.bots.push(bot);
  users.set(userId, user);
  saveUsers(users);
}

export function removeBotFromUser(userId: number, botId: string) {
  const users = loadUsers();
  const user = users.get(userId);
  if (!user) return;
  user.bots = user.bots.filter(b => b.id !== botId);
  users.set(userId, user);
  saveUsers(users);
}

export function addHistoryItem(item: CheckHistoryItem) {
  const history = loadHistory();
  history.unshift(item);
  // Simpan max 100 per user? Tapi kita simpan semua, nanti filter by userId
  saveHistory(history);
}

export function getUserHistory(userId: number, limit = 10): CheckHistoryItem[] {
  const history = loadHistory();
  return history.filter(h => h.userId === userId).slice(0, limit);
}
