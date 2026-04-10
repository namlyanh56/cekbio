import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
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

interface SessionConfig {
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
}

interface NumberCheckDetail {
  phone: string;
  jid: string;
  isRegistered: boolean;
  bio: string | null;

  // Tipe akun
  type: "business" | "regular" | "unknown";

  // Informasi business profile mentah/ringan
  businessName: string | null;
  verifiedName: string | null;

  // Flag verifikasi penting
  isMetaVerified: boolean;
  isOfficialBusinessAccount: boolean; // OBA

  // Optional label mentah jika tersedia
  verificationLabel: string | null;

  error?: string;
}

interface CheckSummary {
  session_id: string;
  sender_type: SenderType;
  total_checked: number;
  registered_count: number;
  unregistered_count: number;
  business_account_count: number;
  regular_account_count: number;

  // Tambahan statistik baru
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

interface CheckOptions {
  batchSize?: number;
  concurrencyPerBatch?: number;
  minBatchDelayMs?: number;
  maxBatchDelayMs?: number;
  perNumberTimeoutMs?: number;
}

interface InitSessionOptions {
  phoneNumber?: string;
  onPairingCode?: (sessionId: string, pairingCode: string) => void | Promise<void>;
}

/* =========================================================
 * Utils
 * ======================================================= */

const logger = P({ level: "info" });
const store = makeInMemoryStore({ logger: P({ level: "silent" }) });

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = "Timeout"): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Helper untuk membaca properti business profile secara aman.
 * Struktur field bisa berbeda antar versi/proto, jadi gunakan fallback defensif.
 */
function parseBusinessVerification(profile: any): {
  businessName: string | null;
  verifiedName: string | null;
  isMetaVerified: boolean;
  isOfficialBusinessAccount: boolean;
  verificationLabel: string | null;
} {
  if (!profile || typeof profile !== "object") {
    return {
      businessName: null,
      verifiedName: null,
      isMetaVerified: false,
      isOfficialBusinessAccount: false,
      verificationLabel: null,
    };
  }

  // Nama bisnis umum
  const businessName =
    profile?.description ??
    profile?.businessName ??
    profile?.name ??
    null;

  // verified_name biasa ada di payload WA Business tertentu
  const verifiedName =
    profile?.verified_name ??
    profile?.verifiedName ??
    profile?.profileOptions?.verified_name ??
    null;

  // Label verifikasi (fallback, jika tersedia)
  const rawLabel =
    profile?.verificationLabel ??
    profile?.verified_level ??
    profile?.profileOptions?.verificationLabel ??
    profile?.profileOptions?.verified_level ??
    null;

  const labelText = rawLabel ? String(rawLabel).toLowerCase() : "";

  // Meta Verified detection (heuristic multi-field)
  const isMetaVerified =
    Boolean(verifiedName) ||
    labelText.includes("meta verified") ||
    labelText.includes("verified");

  // OBA detection (heuristic multi-field)
  const isOfficialBusinessAccount =
    labelText.includes("official business account") ||
    labelText.includes("oba") ||
    Boolean(profile?.isOfficialBusinessAccount) ||
    Boolean(profile?.officialBusinessAccount);

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

  public getQueueStatus(sessionId: string) {
    const q = this.queues.get(sessionId);
    return {
      sessionId,
      isProcessing: q?.processing ?? false,
      queueLength: q?.tasks.length ?? 0,
      status: q?.processing ? "Sedang diproses" : "Idle",
    };
  }

  public getPairingInfo(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    return {
      sessionId,
      pairingPhone: s.pairingPhone ?? null,
      pairingCode: s.pairingCode ?? null,
      isConnected: s.isConnected,
      isRegistered: s.sock.authState.creds.registered,
    };
  }

  public async initSession(config: SessionConfig, options?: InitSessionOptions): Promise<SessionRuntime> {
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
      logger: P({ level: "silent" }),
      browser: ["Chrome (Linux)", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 20_000,
    });

    store.bind(sock.ev);
    sock.ev.on("creds.update", saveCreds);

    const runtime: SessionRuntime = {
      config,
      sock,
      isConnected: false,
      isBusy: false,
      lastSeenAt: Date.now(),
      pairingCode: null,
      pairingPhone: options?.phoneNumber ? sanitizePhone(options.phoneNumber) : null,
    };

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;
      runtime.lastSeenAt = Date.now();

      if (connection === "open") {
        runtime.isConnected = true;
        runtime.pairingCode = null;
        logger.info(`[${config.sessionId}] connected`);
      }

      if (connection === "close") {
        runtime.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        logger.warn(`[${config.sessionId}] disconnected. code=${statusCode}, loggedOut=${isLoggedOut}`);

        if (isLoggedOut) {
          await this.deleteSession(config.sessionId);
          return;
        }

        await sleep(1000);
        try {
          await this.restartSession(config.sessionId, {
            phoneNumber: runtime.pairingPhone ?? undefined,
            onPairingCode: options?.onPairingCode,
          });
        } catch (e) {
          logger.error(e, `[${config.sessionId}] restart failed`);
        }
      }
    });

    this.sessions.set(config.sessionId, runtime);
    if (!this.queues.has(config.sessionId)) {
      this.queues.set(config.sessionId, { processing: false, tasks: [] });
    }

    if (!sock.authState.creds.registered) {
      if (!options?.phoneNumber) {
        logger.warn(`[${config.sessionId}] belum registered, phoneNumber tidak diberikan`);
      } else {
        setTimeout(async () => {
          try {
            const cleanNumber = sanitizePhone(options.phoneNumber!);
            const code = await sock.requestPairingCode(cleanNumber);

            runtime.pairingCode = code;
            runtime.pairingPhone = cleanNumber;

            logger.info(`PAIRING CODE ${config.sessionId}: ${code}`);

            if (options.onPairingCode) {
              await options.onPairingCode(config.sessionId, code);
            }
          } catch (error) {
            logger.error(error, `[${config.sessionId}] gagal request pairing code`);
          }
        }, 3000);
      }
    }

    return runtime;
  }

  public async restartSession(sessionId: string, options?: InitSessionOptions): Promise<void> {
    const old = this.sessions.get(sessionId);
    if (!old) throw new Error(`Session ${sessionId} not found`);

    try {
      old.sock.end(new Error("Manual restart"));
    } catch {}
    this.sessions.delete(sessionId);

    await this.initSession(old.config, options);
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      try {
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
    if (!queue) throw new Error(`Queue for session ${sessionId} not initialized`);

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
        this.processQueue(sessionId).catch((e) => {
          logger.error(e, `[${sessionId}] queue worker crashed`);
        });
      }
    });
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.queues.get(sessionId);
    if (!queue) throw new Error(`Queue for session ${sessionId} not initialized`);
    if (queue.processing) return;

    queue.processing = true;
    const runtime = this.sessions.get(sessionId);
    if (!runtime) {
      queue.processing = false;
      throw new Error(`Session ${sessionId} not found`);
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

  try {
    const waCheck = await withTimeout(sock.onWhatsApp(jid), timeoutMs, "onWhatsApp timeout");
    const isRegistered = Array.isArray(waCheck) && waCheck.length > 0 && Boolean(waCheck[0]?.exists);

    if (!isRegistered) {
      return {
        phone,
        jid,
        isRegistered: false,
        bio: null,
        type: "unknown",
        businessName: null,
        verifiedName: null,
        isMetaVerified: false,
        isOfficialBusinessAccount: false,
        verificationLabel: null,
      };
    }

    // ambil bio
    let bio: string | null = null;
    try {
      const status = await withTimeout(sock.fetchStatus(jid), timeoutMs, "fetchStatus timeout");
      bio = status?.status || null;
    } catch {
      bio = null;
    }

    // ambil business profile + deteksi verifikasi
    let type: "business" | "regular" | "unknown" = "regular";
    let businessName: string | null = null;
    let verifiedName: string | null = null;
    let isMetaVerified = false;
    let isOfficialBusinessAccount = false;
    let verificationLabel: string | null = null;

    try {
      const profile = (await withTimeout(
        sock.businessProfile(jid),
        timeoutMs,
        "businessProfile timeout"
      )) as WABusinessProfile | null;

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
      // jika gagal baca business profile, anggap regular
      type = "regular";
    }

    return {
      phone,
      jid,
      isRegistered: true,
      bio,
      type,
      businessName,
      verifiedName,
      isMetaVerified,
      isOfficialBusinessAccount,
      verificationLabel,
    };
  } catch (error: any) {
    return {
      phone,
      jid,
      isRegistered: false,
      bio: null,
      type: "unknown",
      businessName: null,
      verifiedName: null,
      isMetaVerified: false,
      isOfficialBusinessAccount: false,
      verificationLabel: null,
      error: error?.message || "Unknown check error",
    };
  }
}

async function runBulkCheck(
  runtime: SessionRuntime,
  phoneNumbersArray: string[],
  opts?: CheckOptions
): Promise<CheckSummary> {
  if (!runtime.isConnected) {
    throw new Error(`Session ${runtime.config.sessionId} is not connected`);
  }

  const startedAt = new Date();

  const batchSize = opts?.batchSize ?? 5;
  const concurrencyPerBatch = opts?.concurrencyPerBatch ?? 3;
  const minBatchDelayMs = opts?.minBatchDelayMs ?? 500;
  const maxBatchDelayMs = opts?.maxBatchDelayMs ?? 1500;
  const perNumberTimeoutMs = opts?.perNumberTimeoutMs ?? 8000;

  const cleanNumbers = phoneNumbersArray.map(sanitizePhone).filter(Boolean);
  const batches = chunkArray(cleanNumbers, batchSize);

  const details: NumberCheckDetail[] = [];
  const limit = pLimit(concurrencyPerBatch);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const batchResults = await Promise.all(
      batch.map((phone) =>
        limit(async () => {
          await sleep(randomBetween(80, 250));
          return checkSingleNumber(runtime.sock, phone, perNumberTimeoutMs);
        })
      )
    );

    details.push(...batchResults);

    if (i < batches.length - 1) {
      const dynamicDelay = randomBetween(minBatchDelayMs, maxBatchDelayMs);
      await sleep(dynamicDelay);
    }
  }

  const registered = details.filter((d) => d.isRegistered);
  const unregistered = details.length - registered.length;
  const businessCount = registered.filter((d) => d.type === "business").length;
  const regularCount = registered.filter((d) => d.type === "regular").length;
  const metaVerifiedCount = registered.filter((d) => d.isMetaVerified).length;
  const obaCount = registered.filter((d) => d.isOfficialBusinessAccount).length;

  const finishedAt = new Date();

  return {
    session_id: runtime.config.sessionId,
    sender_type: runtime.config.senderType,
    total_checked: details.length,
    registered_count: registered.length,
    unregistered_count: unregistered,
    business_account_count: businessCount,
    regular_account_count: regularCount,
    meta_verified_count: metaVerifiedCount,
    oba_count: obaCount,
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

  async restartSession(sessionId: string, options?: InitSessionOptions) {
    return this.sessionManager.restartSession(sessionId, options);
  }

  async deleteSession(sessionId: string) {
    return this.sessionManager.deleteSession(sessionId);
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
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return this.sessionManager.enqueueCheck(sessionId, phoneNumbersArray, options);
  }
}

/* =========================================================
 * Example Usage
 * ======================================================= */

async function bootstrapDemo() {
  const engine = new WhatsAppBulkCheckerEngine();

  await engine.createSession(
    {
      sessionId: "user-1775819391798",
      senderType: "user_sender",
      label: "User Linked Number",
    },
    {
      phoneNumber: "6281234567890",
      onPairingCode: async (sessionId, code) => {
        console.log(`[${sessionId}] Pairing code: ${code}`);
      },
    }
  );

  await sleep(8000);

  const numbers = [
    "2250713830049",
    "2250713830008",
    "2250713830232",
    "2250713830030",
    "2250713830005",
    "2250713830066",
    "2250713830154",
    "2250713830288",
    "2250713830096",
    "2250713830152",
  ];

  try {
    const result = await engine.checkNumbers("user-1775819391798", numbers, {
      batchSize: 5,
      concurrencyPerBatch: 3,
      minBatchDelayMs: 500,
      maxBatchDelayMs: 1500,
      perNumberTimeoutMs: 8000,
    });

    console.dir(result, { depth: null });
  } catch (err) {
    console.error("checkNumbers failed:", err);
  }
}

// bootstrapDemo().catch(console.error);
