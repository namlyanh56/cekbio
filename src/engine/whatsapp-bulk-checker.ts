import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WABusinessProfile,
  WASocket,
} from "@whiskeysockets/baileys";
import pLimit from "p-limit";
import P from "pino";
import fs from "node:fs";
import path from "node:path";
import { Boom } from "@hapi/boom";

/* =========================================================
 * Types
 * ======================================================= */

type SenderType = "global_sender" | "user_sender";

export type PairingStatus =
  | "idle"
  | "pending_pairing"
  | "code_sent"
  | "connected"
  | "failed"
  | "logged_out"
  | "cancelled";

export interface SessionConfig {
  sessionId: string;
  senderType: SenderType;
  label?: string;
}

interface SessionRuntime {
  config: SessionConfig;
  sock: WASocket;
  isConnected: boolean;
  isBusy: boolean;
  lastSeenAt: number;
  pairingCode?: string | null;
  pairingPhone?: string | null;
  pairingStatus: PairingStatus;
  pairingAttempts: number;
  lastDisconnectCode?: number | null;
  lastError?: string | null;
}

export interface NumberCheckDetail {
  phone: string;
  jid: string;
  isRegistered: boolean;
  bio: string | null;
  type: "business" | "regular" | "unknown";
  businessName: string | null;
  verifiedName: string | null;
  isMetaVerified: boolean;
  isOfficialBusinessAccount: boolean;
  verificationLabel: string | null;
  error?: string;
}

export interface CheckSummary {
  session_id: string;
  sender_type: SenderType;
  total_checked: number;
  registered_count: number;
  unregistered_count: number;
  business_account_count: number;
  regular_account_count: number;
  meta_verified_count: number;
  oba_count: number;
  details: NumberCheckDetail[];
  meta: {
    batch_size: number;
    concurrency_per_batch: number;
    min_delay_ms: number;
    max_delay_ms: number;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  };
}

interface QueueTask {
  id: string;
  createdAt: number;
  numbers: string[];
  options?: CheckOptions;
  resolve: (value: CheckSummary) => void;
  reject: (reason?: unknown) => void;
}

interface SessionQueueState {
  processing: boolean;
  tasks: QueueTask[];
}

export interface CheckOptions {
  batchSize?: number;
  concurrencyPerBatch?: number;
  minBatchDelayMs?: number;
  maxBatchDelayMs?: number;
  perNumberTimeoutMs?: number;
}

export interface InitSessionOptions {
  phoneNumber?: string;
  onPairingCode?: (sessionId: string, pairingCode: string) => void | Promise<void>;
  onConnected?: (sessionId: string) => void | Promise<void>;
  onFailed?: (sessionId: string, reason: string) => void | Promise<void>;
}

export interface SessionPairingInfo {
  sessionId: string;
  pairingPhone: string | null;
  pairingCode: string | null;
  pairingStatus: PairingStatus;
  pairingAttempts: number;
  isConnected: boolean;
  isRegistered: boolean;
  lastDisconnectCode: number | null;
  lastError: string | null;
}

/* =========================================================
 * Utils
 * ======================================================= */

const logger = P({ level: "silent" }); // Kurangi log noise dari Baileys

const SESSION_ROOT = path.join(process.cwd(), "sessions");
if (!fs.existsSync(SESSION_ROOT)) fs.mkdirSync(SESSION_ROOT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sanitizePhone(raw: string): string {
  return (raw || "").replace(/[^\d]/g, "");
}

function toJid(phone: string): string {
  return `${sanitizePhone(phone)}@s.whatsapp.net`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label = "Timeout"
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`${label} after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function parseBusinessVerification(profile: unknown): {
  businessName: string | null;
  verifiedName: string | null;
  isMetaVerified: boolean;
  isOfficialBusinessAccount: boolean;
  verificationLabel: string | null;
} {
  const p = (profile ?? {}) as Record<string, unknown>;
  const businessName = (p.description as string | undefined) ?? (p.businessName as string | undefined) ?? (p.name as string | undefined) ?? null;
  const verifiedName = (p.verified_name as string | undefined) ?? (p.verifiedName as string | undefined) ?? ((p.profileOptions as Record<string, unknown> | undefined)?.verified_name as string | undefined) ?? null;
  const rawLabel = (p.verificationLabel as string | undefined) ?? (p.verified_level as string | undefined) ?? ((p.profileOptions as Record<string, unknown> | undefined)?.verificationLabel as string | undefined) ?? ((p.profileOptions as Record<string, unknown> | undefined)?.verified_level as string | undefined) ?? null;
  
  const labelText = rawLabel ? String(rawLabel).toLowerCase() : "";
  const isMetaVerified = Boolean(verifiedName) || labelText.includes("meta verified") || labelText.includes("verified");
  const isOfficialBusinessAccount = labelText.includes("official business account") || labelText.includes("oba") || Boolean(p.isOfficialBusinessAccount) || Boolean(p.officialBusinessAccount);

  return {
    businessName: businessName ? String(businessName) : null,
    verifiedName: verifiedName ? String(verifiedName) : null,
    isMetaVerified,
    isOfficialBusinessAccount,
    verificationLabel: rawLabel ? String(rawLabel) : null,
  };
}

/* =========================================================
 * SessionManager
 * ======================================================= */

class SessionManager {
  private sessions = new Map<string, SessionRuntime>();
  private queues = new Map<string, SessionQueueState>();

  private getSessionAuthDir(sessionId: string) {
    return path.join(SESSION_ROOT, sessionId);
  }

  public getSession(sessionId: string): SessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  public isSessionConnected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isConnected ?? false;
  }

  public getQueueStatus(sessionId: string) {
    const q = this.queues.get(sessionId);
    return {
      sessionId,
      isProcessing: q?.processing ?? false,
      queueLength: q?.tasks.length ?? 0,
      status: q?.processing ? "Sedang diproses" : "Idle",
    };
  }

  public getPairingInfo(sessionId: string): SessionPairingInfo | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      sessionId,
      pairingPhone: s.pairingPhone ?? null,
      pairingCode: s.pairingCode ?? null,
      pairingStatus: s.pairingStatus,
      pairingAttempts: s.pairingAttempts,
      isConnected: s.isConnected,
      isRegistered: s.sock.authState.creds.registered,
      lastDisconnectCode: s.lastDisconnectCode ?? null,
      lastError: s.lastError ?? null,
    };
  }

  private async requestPairingCode(
    runtime: SessionRuntime,
    options?: InitSessionOptions
  ): Promise<string> {
    if (!runtime.pairingPhone) throw new Error("pairing phone is missing");

    runtime.pairingStatus = "pending_pairing";
    runtime.pairingAttempts += 1;

    try {
      console.log(`⏳ [DEBUG] Meminta kode pairing untuk ${runtime.pairingPhone}...`);
      const rawCode = await runtime.sock.requestPairingCode(runtime.pairingPhone);
      
      // FORMAT KODE: Pisahkan dengan tanda strip (-) di tengah agar mudah dibaca
      const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      
      runtime.pairingCode = formattedCode;
      runtime.pairingStatus = "code_sent";
      runtime.lastError = null;
      console.log(`✅ [DEBUG] Kode didapat: ${formattedCode}`);

      if (options?.onPairingCode) {
        await options.onPairingCode(runtime.config.sessionId, formattedCode);
      }
      return formattedCode;
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : JSON.stringify(e);
      console.error(`❌ [DEBUG] Gagal meminta kode:`, errorMsg);

      runtime.pairingStatus = "failed";
      runtime.lastError = errorMsg;
      if (options?.onFailed) {
        await options.onFailed(runtime.config.sessionId, runtime.lastError);
      }
      throw e;
    }
  }

  public async initSession(
    config: SessionConfig,
    options?: InitSessionOptions
  ): Promise<SessionRuntime> {
    const existing = this.sessions.get(config.sessionId);
    if (existing) return existing;

    const authDir = this.getSessionAuthDir(config.sessionId);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger, 
      browser: ["Ubuntu", "Chrome", "20.0.04"], 
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 30_000, // Timeout ditingkatkan agar lebih toleran
      keepAliveIntervalMs: 25_000,   // Ping rutin untuk menjaga sesi tetap hidup
    });

    sock.ev.on("creds.update", saveCreds);

    const runtime: SessionRuntime = {
      config,
      sock,
      isConnected: false,
      isBusy: false,
      lastSeenAt: Date.now(),
      pairingCode: null,
      pairingPhone: options?.phoneNumber ? sanitizePhone(options.phoneNumber) : null,
      pairingStatus: "idle",
      pairingAttempts: 0,
      lastDisconnectCode: null,
      lastError: null,
    };

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      runtime.lastSeenAt = Date.now();

      if (connection === "open") {
        runtime.isConnected = true;
        runtime.pairingCode = null;
        runtime.pairingStatus = "connected";
        runtime.lastError = null;
        console.log(`✅ [${config.sessionId}] Terhubung stabil.`);

        if (options?.onConnected) {
          await options.onConnected(config.sessionId);
        }
      }

      if (connection === "close") {
        runtime.isConnected = false;
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode ?? null;
        
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        runtime.lastDisconnectCode = statusCode;

        if (isLoggedOut) {
          console.warn(`🛑 [${config.sessionId}] Perangkat Logged Out. Sesi dihapus.`);
          runtime.pairingStatus = "logged_out";
          runtime.lastError = "Logged out dari perangkat";
          if (options?.onFailed) await options.onFailed(config.sessionId, runtime.lastError);
          await this.deleteSession(config.sessionId);
          return;
        }

        // AUTO RECONNECT AGRESSIVE UNTUK MENJAGA STABILITAS SESI (Selama bukan log out manual)
        console.log(`🔄 [${config.sessionId}] Sesi terputus (Code: ${statusCode}). Melakukan reconnect otomatis...`);
        this.sessions.delete(config.sessionId); 
        
        // Jeda waktu yang eksponensial/acak untuk menghindari deteksi spam restart
        setTimeout(() => {
            this.initSession(config, options).catch(e => console.error("Auto-restart error:", e));
        }, randomBetween(3000, 7000));
      }
    });

    this.sessions.set(config.sessionId, runtime);
    if (!this.queues.has(config.sessionId)) {
      this.queues.set(config.sessionId, { processing: false, tasks: [] });
    }

    if (!sock.authState.creds.registered) {
      if (runtime.pairingPhone) {
        setTimeout(async () => {
          try {
            await this.requestPairingCode(runtime, options);
          } catch (e) {}
        }, 3500);
      }
    } else {
        runtime.pairingStatus = "pending_pairing";
    }

    return runtime;
  }

  public async retryPairingCode(sessionId: string, phoneNumber?: string): Promise<string> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new Error(`Sesi tidak aktif.`);
    if (phoneNumber) runtime.pairingPhone = sanitizePhone(phoneNumber);
    return this.requestPairingCode(runtime);
  }

  public async cancelPairing(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
        runtime.pairingStatus = "cancelled";
        runtime.pairingCode = null;
        try { runtime.sock.end(new Error("Pairing cancelled")); } catch {}
    }
    await this.deleteSession(sessionId);
  }

  public async restartSession(sessionId: string, options?: InitSessionOptions): Promise<void> {
    const old = this.sessions.get(sessionId);
    if (!old) throw new Error(`Sesi tidak aktif.`);
    try { old.sock.end(new Error("Manual restart")); } catch {}
    this.sessions.delete(sessionId);
    await this.initSession(old.config, { ...options, phoneNumber: options?.phoneNumber ?? old.pairingPhone ?? undefined });
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      try {
        s.sock.logout();
        s.sock.end(new Error("Session deleted"));
      } catch {}
      this.sessions.delete(sessionId);
    }
    this.queues.delete(sessionId);
    const authDir = this.getSessionAuthDir(sessionId);
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
  }

  public enqueueCheck(sessionId: string, numbers: string[], options?: CheckOptions): Promise<CheckSummary> {
    const queue = this.queues.get(sessionId);
    if (!queue) throw new Error("Antrean tidak diinisialisasi");

    return new Promise<CheckSummary>((resolve, reject) => {
      queue.tasks.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        createdAt: Date.now(),
        numbers,
        options,
        resolve,
        reject,
      });

      if (!queue.processing) {
        this.processQueue(sessionId).catch(() => {});
      }
    });
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue) return;
    if (queue.processing) return;

    queue.processing = true;
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      queue.processing = false;
      return;
    }

    while (queue.tasks.length > 0) {
      const task = queue.tasks.shift()!;
      runtime.isBusy = true;
      try {
        const result = await runBulkCheck(runtime, task.numbers, task.options);
        task.resolve(result);
      } catch (e) {
        task.reject(e);
      } finally {
        runtime.isBusy = false;
      }
    }
    queue.processing = false;
  }
}

/* =========================================================
 * Core Bulk Checker (EVALUASI ANTI-SPAM & AKURASI DATA)
 * ======================================================= */

async function checkSingleNumber(
  sock: WASocket,
  rawPhone: string,
  timeoutMs: number
): Promise<NumberCheckDetail> {
  const phone = sanitizePhone(rawPhone);
  const jid = toJid(phone);

  try {
    // 1. Cek apakah nomor terdaftar
    const waCheck = await withTimeout(sock.onWhatsApp(jid), timeoutMs, "onWhatsApp timeout");
    const isRegistered = Array.isArray(waCheck) && waCheck.length > 0 && Boolean(waCheck[0]?.exists);

    if (!isRegistered) {
      return { phone, jid, isRegistered: false, bio: null, type: "unknown", businessName: null, verifiedName: null, isMetaVerified: false, isOfficialBusinessAccount: false, verificationLabel: null };
    }

    // JEDA ANTI-SPAM PENTING: Mencegah Rate-Limit WhatsApp yang menyebabkan Bio kosong (0)
    await sleep(randomBetween(500, 1000));

    // 2. Mengambil BIO (Status)
    let bio: string | null = null;
    try {
      const statusResult = await withTimeout(sock.fetchStatus(jid), timeoutMs, "fetchStatus timeout");
      if (typeof statusResult === "string") {
        bio = statusResult;
      } else if (statusResult && typeof statusResult === "object") {
        const maybeObj = statusResult as { status?: unknown };
        if (typeof maybeObj.status === "string") bio = maybeObj.status;
      }
    } catch (e: unknown) {
       // Abaikan error 401 (Privasi Bio Tertutup) atau 404 (Tidak Punya Bio)
    }

    // JEDA ANTI-SPAM PENTING
    await sleep(randomBetween(500, 1000));

    // 3. Mengecek Akun Bisnis & Meta Verified
    let type: "business" | "regular" | "unknown" = "regular";
    let businessName: string | null = null;
    let verifiedName: string | null = null;
    let isMetaVerified = false;
    let isOfficialBusinessAccount = false;
    let verificationLabel: string | null = null;

    try {
      const profile = (await withTimeout(sock.getBusinessProfile(jid), timeoutMs, "getBusinessProfile timeout")) as WABusinessProfile | null;
      if (profile) {
        type = "business";
        const parsed = parseBusinessVerification(profile);
        businessName = parsed.businessName;
        verifiedName = parsed.verifiedName;
        isMetaVerified = parsed.isMetaVerified;
        isOfficialBusinessAccount = parsed.isOfficialBusinessAccount;
        verificationLabel = parsed.verificationLabel;
      }
    } catch { 
      // Akan error 404 jika bukan akun bisnis, diabaikan (dianggap akun regular)
    }

    return { phone, jid, isRegistered: true, bio, type, businessName, verifiedName, isMetaVerified, isOfficialBusinessAccount, verificationLabel };
  } catch (error: unknown) {
    return { phone, jid, isRegistered: false, bio: null, type: "unknown", businessName: null, verifiedName: null, isMetaVerified: false, isOfficialBusinessAccount: false, verificationLabel: null, error: error instanceof Error ? error.message : "Timeout" };
  }
}

async function runBulkCheck(
  runtime: SessionRuntime,
  phoneNumbersArray: string[],
  opts?: CheckOptions
): Promise<CheckSummary> {
  if (!runtime.isConnected) {
    throw new Error(`Koneksi server bot sedang terputus.`);
  }

  const startedAt = new Date();
  
  // MENGURANGI BEBAN PARALEL AGAR DATA AKURAT & TIDAK CRASH
  // Proses berjalan lebih stabil (batch lebih kecil tapi konsisten)
  const batchSize = opts?.batchSize ?? 3;
  const concurrencyPerBatch = opts?.concurrencyPerBatch ?? 1; // Memastikan request WA murni sekuensial
  const minBatchDelayMs = opts?.minBatchDelayMs ?? 1500;
  const maxBatchDelayMs = opts?.maxBatchDelayMs ?? 3000;
  const perNumberTimeoutMs = opts?.perNumberTimeoutMs ?? 10000;

  const cleanNumbers = phoneNumbersArray.map(sanitizePhone).filter(Boolean);
  const batches = chunkArray(cleanNumbers, batchSize);
  const details: NumberCheckDetail[] = [];
  const limit = pLimit(concurrencyPerBatch);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchResults = await Promise.all(
      batch.map((phone) =>
        limit(async () => {
          return checkSingleNumber(runtime.sock, phone, perNumberTimeoutMs);
        })
      )
    );
    details.push(...batchResults);
    
    // Istirahat antar batch agar server WA bernapas
    if (i < batches.length - 1) {
      await sleep(randomBetween(minBatchDelayMs, maxBatchDelayMs));
    }
  }

  const registered = details.filter((d) => d.isRegistered);
  const unregistered = details.length - registered.length;
  const finishedAt = new Date();

  return {
    session_id: runtime.config.sessionId,
    sender_type: runtime.config.senderType,
    total_checked: details.length,
    registered_count: registered.length,
    unregistered_count: unregistered,
    business_account_count: registered.filter((d) => d.type === "business").length,
    regular_account_count: registered.filter((d) => d.type === "regular").length,
    meta_verified_count: registered.filter((d) => d.isMetaVerified).length,
    oba_count: registered.filter((d) => d.isOfficialBusinessAccount).length,
    details,
    meta: {
      batch_size: batchSize,
      concurrency_per_batch: concurrencyPerBatch,
      min_delay_ms: minBatchDelayMs,
      max_delay_ms: maxBatchDelayMs,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
    },
  };
}

/* =========================================================
 * Public API
 * ======================================================= */

export class WhatsAppBulkCheckerEngine {
  private sessionManager = new SessionManager();

  async createSession(config: SessionConfig, options?: InitSessionOptions) {
    return this.sessionManager.initSession(config, options);
  }

  async retryPairingCode(sessionId: string, phoneNumber?: string) {
    return this.sessionManager.retryPairingCode(sessionId, phoneNumber);
  }

  async cancelPairing(sessionId: string) {
    return this.sessionManager.cancelPairing(sessionId);
  }

  async restartSession(sessionId: string, options?: InitSessionOptions) {
    return this.sessionManager.restartSession(sessionId, options);
  }

  async deleteSession(sessionId: string) {
    return this.sessionManager.deleteSession(sessionId);
  }

  isSessionConnected(sessionId: string): boolean {
    return this.sessionManager.isSessionConnected(sessionId);
  }

  getSessionQueueStatus(sessionId: string) {
    return this.sessionManager.getQueueStatus(sessionId);
  }

  getSessionPairingInfo(sessionId: string) {
    return this.sessionManager.getPairingInfo(sessionId);
  }

  async checkNumbers(
    sessionId: string,
    phoneNumbersArray: string[],
    options?: CheckOptions
  ): Promise<CheckSummary> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Sesi tidak aktif.`);
    if (!session.isConnected) throw new Error(`Sesi sedang offline/mencoba menghubungkan ulang.`);
    return this.sessionManager.enqueueCheck(sessionId, phoneNumbersArray, options);
  }
}
