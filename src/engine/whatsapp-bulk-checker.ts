import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
  getBinaryNodeChild,
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

const logger = P({ level: "silent" });

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

export function sanitizePhone(raw: string): string {
  let cleaned = (raw || "").replace(/[^\d]/g, "");
  if (cleaned.startsWith("08")) {
    cleaned = "628" + cleaned.substring(2);
  }
  return cleaned;
}

function toJid(phone: string): string {
  return `${phone}@s.whatsapp.net`;
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
      const rawCode = await runtime.sock.requestPairingCode(runtime.pairingPhone);
      const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
      
      runtime.pairingCode = formattedCode;
      runtime.pairingStatus = "code_sent";
      runtime.lastError = null;

      if (options?.onPairingCode) {
        try {
          await options.onPairingCode(runtime.config.sessionId, formattedCode);
        } catch (e) {
          console.error(`[Anti-Crash] Error in onPairingCode callback:`, e);
        }
      }
      return formattedCode;
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : JSON.stringify(e);
      runtime.pairingStatus = "failed";
      runtime.lastError = errorMsg;
      if (options?.onFailed) {
        try {
          await options.onFailed(runtime.config.sessionId, runtime.lastError);
        } catch (err) {
          console.error(`[Anti-Crash] Error in onFailed callback:`, err);
        }
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
      defaultQueryTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
      getMessage: async () => { return { conversation: 'hello' } } // Mencegah crash jika buffer pesan hilang
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

        if (options?.onConnected) {
          try {
            await options.onConnected(config.sessionId);
          } catch (e) {
            console.error(`[Anti-Crash] Error in onConnected callback:`, e);
          }
        }
      }

      if (connection === "close") {
        runtime.isConnected = false;
        const boomError = lastDisconnect?.error as Boom;
        const statusCode = boomError?.output?.statusCode ?? null;
        
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        runtime.lastDisconnectCode = statusCode;

        if (isLoggedOut) {
          runtime.pairingStatus = "logged_out";
          runtime.lastError = "Logged out dari perangkat";
          if (options?.onFailed) {
            try {
              await options.onFailed(config.sessionId, runtime.lastError);
            } catch (e) {
              console.error(`[Anti-Crash] Error in onFailed callback:`, e);
            }
          }
          await this.deleteSession(config.sessionId);
          return;
        }

        this.sessions.delete(config.sessionId); 
        setTimeout(() => {
            this.initSession(config, options).catch(() => {});
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
 * Core Bulk Checker
 * ======================================================= */

async function checkSingleNumber(
  sock: WASocket,
  rawPhone: string,
  timeoutMs: number
): Promise<NumberCheckDetail> {
  const phone = sanitizePhone(rawPhone);
  const jid = toJid(phone);
  const outputPhone = "+" + phone;

  try {
    const waCheck = await withTimeout(sock.onWhatsApp(jid), timeoutMs, "onWhatsApp timeout");
    const isRegistered = Array.isArray(waCheck) && waCheck.length > 0 && Boolean(waCheck[0]?.exists);

    if (!isRegistered) {
      return { phone: outputPhone, jid, isRegistered: false, bio: null, type: "unknown", businessName: null, verifiedName: null, isMetaVerified: false, isOfficialBusinessAccount: false, verificationLabel: null };
    }

    await sleep(randomBetween(500, 1000));

    let bio: string | null = null;
    try {
      const statusNode = await withTimeout(
        sock.query({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'status' },
            content: [{ tag: 'status', attrs: { jid } }]
        }), 
        timeoutMs, "fetchStatus timeout"
      );
      
      const statusChild = getBinaryNodeChild(statusNode, 'status');
      if (statusChild && statusChild.content) {
        bio = Buffer.isBuffer(statusChild.content) ? statusChild.content.toString() : String(statusChild.content);
      }
    } catch (e) {}

    await sleep(randomBetween(500, 1000));

    let type: "business" | "regular" | "unknown" = "regular";
    let businessName: string | null = null;
    let verifiedName: string | null = null;
    let isMetaVerified = false;
    let isOfficialBusinessAccount = false;
    let verificationLabel: string | null = null;

    try {
      const bizNode = await withTimeout(
          sock.query({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', type: 'get', xmlns: 'w:biz' },
            content: [{ tag: 'business_profile', attrs: { v: '116' }, content: [{ tag: 'profile', attrs: { jid } }] }]
          }), 
          timeoutMs, "getBusinessProfile timeout"
      );

      const profileChild = getBinaryNodeChild(getBinaryNodeChild(bizNode, 'business_profile'), 'profile');
      if (profileChild && profileChild.attrs) {
          type = "business";
          const attrs = profileChild.attrs;
          
          businessName = attrs.name || null;
          verifiedName = attrs.verified_name || null;
          verificationLabel = attrs.verified_level || null;
          
          const labelText = String(verificationLabel).toLowerCase();
          isMetaVerified = Boolean(verifiedName) || labelText.includes("meta verified") || labelText.includes("verified");
          isOfficialBusinessAccount = labelText.includes("official business account") || labelText.includes("oba");
      }
    } catch {}

    return { phone: outputPhone, jid, isRegistered: true, bio, type, businessName, verifiedName, isMetaVerified, isOfficialBusinessAccount, verificationLabel };
  } catch (error: unknown) {
    return { phone: outputPhone, jid, isRegistered: false, bio: null, type: "unknown", businessName: null, verifiedName: null, isMetaVerified: false, isOfficialBusinessAccount: false, verificationLabel: null, error: error instanceof Error ? error.message : "Timeout" };
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
  
  const batchSize = opts?.batchSize ?? 3;
  const concurrencyPerBatch = opts?.concurrencyPerBatch ?? 1; 
  const minBatchDelayMs = opts?.minBatchDelayMs ?? 1500;
  const maxBatchDelayMs = opts?.maxBatchDelayMs ?? 3000;
  const perNumberTimeoutMs = opts?.perNumberTimeoutMs ?? 10000;

  const cleanNumbers = phoneNumbersArray.map(sanitizePhone).filter(Boolean);
  const batches = chunkArray(cleanNumbers, batchSize);
  const details: NumberCheckDetail[] = [];
  const limit = pLimit(concurrencyPerBatch);

  for (let i = 0; i < batches.length; i++) {
    // CIRCUIT BREAKER: Hentikan sisa antrean jika tiba-tiba WhatsApp putus, cegah crash Node.js
    if (!runtime.isConnected) {
      console.warn(`[Circuit Breaker] Koneksi WA terputus di tengah proses. Menghentikan ${batches.length - i} batch yang tersisa secara elegan.`);
      break; 
    }

    const batch = batches[i];
    const batchResults = await Promise.all(
      batch.map((phone) =>
        limit(async () => {
          return checkSingleNumber(runtime.sock, phone, perNumberTimeoutMs);
        })
      )
    );
    details.push(...batchResults);
    
    if (i < batches.length - 1 && runtime.isConnected) {
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
