import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_QUIZ_QUESTION_COUNT,
  DEFAULT_QUIZ_TIME_LIMIT_MINUTES,
  LEVELS,
  type AdminRosterEntry,
  type AttemptDetail,
  type AttemptSummary,
  type AuthenticatedAdmin,
  type AuthenticatedStudent,
  type AuthenticatedUser,
  type Level,
  type PaginationMeta,
  type PerformanceLabel,
  type QuizSettings,
  type StudentAccessStatus,
  type StudentImportResponse,
  type StudentRosterEntry,
  type UpdateAdminRequest,
  type UpdateStudentRequest
} from "../../shared/types";
import type { ImportedStudent } from "../import/student-roster";
import {
  createSessionToken,
  getSessionMaxAgeSeconds,
  hashPassword,
  hashToken,
  validatePassword,
  verifyPassword
} from "../services/security";
import { sessionCache } from "../services/cache";
import { normalizeGoogleEmail, validateGoogleEmail } from "../services/google-auth";
import { applyPostgresSchema, openPostgresPool, queryMany, queryOne, readJsonFile, withPostgresTransaction } from "./postgres";
import type { AdminAssistantContext, AssistantStudentLeaderboardEntry } from "./platform-store";
import { resolveSqlitePath } from "./sqlite";

interface PasswordCredential { passwordHash: string | null; passwordSalt: string | null; }
interface AdminRecord extends PasswordCredential { id: string; username: string; name: string; isSuperAdmin: boolean; createdAt: string; updatedAt: string; }
interface StudentRecord extends PasswordCredential { id: string; registerNumber: string; name: string; registeredName: string | null; accessStartsAt: string; accessExpiresAt: string; createdAt: string; updatedAt: string; }
interface SessionRecord { id: string; tokenHash: string; userId: string; role: "admin" | "student"; createdAt: string; expiresAt: string; }
interface SessionActivityRecord { sessionId: string; userId: string; role: "admin" | "student"; startedAt: string; lastSeenAt: string; endedAt: string | null; requestCount: number; }
interface QuizSessionRecord { id: string; studentId: string; level: Level; questionIds: string[]; createdAt: string; expiresAt: string; }
type AttemptResultsPayload = Omit<AttemptDetail, "attemptId" | "score" | "performanceLabel" | "completedAt">;
interface AttemptRecord { id: string; quizId: string; studentId: string; level: Level; score: number; totalQuestions: number; percentage: number; performanceLabel: PerformanceLabel; completedAt: string; results: AttemptResultsPayload; }
interface PlatformData { version: number; settings: QuizSettings; admins: AdminRecord[]; students: StudentRecord[]; sessions: SessionRecord[]; sessionActivities: SessionActivityRecord[]; quizSessions: QuizSessionRecord[]; attempts: AttemptRecord[]; }
interface CachedPlatformSnapshot extends PlatformData { loadedAt: number; }
interface SearchToken { field: string | null; value: string; }
interface AssistantUsageSummary { sessionCount: number; activeSessionCount: number; totalRequests: number; totalTrackedMinutes: number; lastSeenAt: string | null; }
interface AssistantRecentAttempt { attemptId: string; studentId: string; email: string; name: string; level: Level; score: number; totalQuestions: number; percentage: number; performanceLabel: PerformanceLabel; completedAt: string; }
interface AssistantModePerformance { level: Level; attempts: number; averagePercentage: number | null; latestScore: number | null; latestTotalQuestions: number | null; latestPerformanceLabel: PerformanceLabel | null; latestCompletedAt: string | null; }
interface AssistantStudentSnapshot { id: string; email: string; name: string; accessStartsAt: string; accessExpiresAt: string; accessStatus: StudentAccessStatus; remainingAccessDays: number; attemptsCount: number; latestAttempt: AssistantRecentAttempt | null; modePerformance: AssistantModePerformance[]; usage: AssistantUsageSummary; }
interface PlatformMetaRowPayload { key: string; value: string; }
interface AdminRowPayload { id: string; username: string; name: string; is_super_admin: boolean; password_hash: string | null; password_salt: string | null; created_at: string; updated_at: string; }
interface StudentRowPayload { id: string; register_number: string; name: string; registered_name: string | null; password_hash: string | null; password_salt: string | null; access_starts_at: string; access_expires_at: string; created_at: string; updated_at: string; }
interface StudentListRowPayload extends StudentRowPayload { attempts_count: number | string; }
interface SessionRowPayload { id: string; token_hash: string; user_id: string; role: "admin" | "student"; created_at: string; expires_at: string; }
interface SessionUserLookupRow {
  session_id: string;
  session_user_id: string;
  session_role: "admin" | "student";
  session_expires_at: string;
  admin_email: string | null;
  admin_name: string | null;
  admin_is_super_admin: boolean | null;
  student_email: string | null;
  student_name: string | null;
  student_access_starts_at: string | null;
  student_access_expires_at: string | null;
}
interface SessionActivityRowPayload { session_id: string; user_id: string; role: "admin" | "student"; started_at: string; last_seen_at: string; ended_at: string | null; request_count: number; }
interface QuizSessionRowPayload { id: string; student_id: string; level: Level; question_ids: string[]; created_at: string; expires_at: string; }
interface AttemptRowPayload { id: string; quiz_id: string; student_id: string; level: Level; score: number; total_questions: number; percentage: number; performance_label: PerformanceLabel; completed_at: string; results_json: string; }
interface CachedSessionUser { user: AuthenticatedUser | null; sessionId: string | null; sessionExpiresAtMs: number; }

const EMPTY_PLATFORM_DATA: PlatformData = {
  version: 1,
  settings: { questionsPerQuiz: DEFAULT_QUIZ_QUESTION_COUNT, timeLimitMinutes: DEFAULT_QUIZ_TIME_LIMIT_MINUTES },
  admins: [], students: [], sessions: [], sessionActivities: [], quizSessions: [], attempts: []
};
const ACCESS_DAY_MS = 24 * 60 * 60 * 1000;
const PLATFORM_SNAPSHOT_TTL_MS = 15_000;
const SESSION_ACTIVITY_TOUCH_WINDOW_MS = 15_000;
const EXPIRY_PRUNE_WINDOW_MS = 60_000;
const ADMIN_SETUP_CACHE_TTL_MS = 60_000;
const SESSION_USER_NEGATIVE_CACHE_TTL_MS = 10_000;

function nowIso() { return new Date().toISOString(); }
function isValidDateValue(value: string | null | undefined): value is string { return typeof value === "string" && Number.isFinite(new Date(value).getTime()); }
function validateAccessDays(value: number): number { if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error("Access days must be a whole number between 1 and 3650."); return value; }
function buildStudentAccessWindow(accessDays: number, baseTimeMs = Date.now()) { const normalizedAccessDays = validateAccessDays(accessDays); return { accessStartsAt: new Date(baseTimeMs).toISOString(), accessExpiresAt: new Date(baseTimeMs + normalizedAccessDays * ACCESS_DAY_MS).toISOString() }; }
function normalizeImportedStudents(importedStudents: ImportedStudent[]) {
  const normalizedStudents: Array<{
    registerNumber: string;
    name: string;
    accessDays: number;
  }> = [];
  const seenEmails = new Set<string>();
  let skippedDuplicates = 0;

  for (const student of importedStudents) {
    const registerNumber = normalizeGoogleEmail(student.registerNumber);
    const name = student.name.trim();

    if (!registerNumber || !name) {
      continue;
    }

    const emailError = validateGoogleEmail(registerNumber);
    if (emailError) {
      throw new Error(emailError);
    }

    const accessDays = validateAccessDays(student.accessDays);
    const emailKey = registerNumber.toLowerCase();

    if (seenEmails.has(emailKey)) {
      skippedDuplicates += 1;
      continue;
    }

    seenEmails.add(emailKey);
    normalizedStudents.push({
      registerNumber,
      name,
      accessDays
    });
  }

  return {
    students: normalizedStudents,
    skippedDuplicates
  };
}
function getStudentAccessSnapshot(student: Pick<StudentRecord, "accessStartsAt" | "accessExpiresAt">) {
  const startsAt = isValidDateValue(student.accessStartsAt) ? student.accessStartsAt : nowIso();
  const expiresAt = isValidDateValue(student.accessExpiresAt) ? student.accessExpiresAt : startsAt;
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  return { accessStartsAt: startsAt, accessExpiresAt: expiresAt, accessStatus: remainingMs > 0 ? "active" as const : "expired" as const, remainingAccessDays: remainingMs > 0 ? Math.ceil(remainingMs / ACCESS_DAY_MS) : 0 };
}
function toAttemptSummary(record: AttemptRecord): AttemptSummary { return { id: record.id, level: record.level, score: record.score, totalQuestions: record.totalQuestions, percentage: record.percentage, performanceLabel: record.performanceLabel, completedAt: record.completedAt }; }
function getPerformanceLabel(score: number, totalQuestions: number): PerformanceLabel { if (totalQuestions === 0) return "Poor"; const percentage = score / totalQuestions; if (percentage < 0.4) return "Poor"; if (percentage < 0.7) return "Good"; if (percentage < 0.9) return "Very Good"; return "Excellent"; }
function tokenizeSearch(search?: string): SearchToken[] {
  if (!search?.trim()) return [];
  const matches = search.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches.map((token) => token.replace(/^"|"$/g, "").trim()).filter(Boolean).map((token) => {
    const separatorIndex = token.indexOf(":");
    return separatorIndex <= 0 ? { field: null, value: token.toLowerCase() } : { field: token.slice(0, separatorIndex).toLowerCase(), value: token.slice(separatorIndex + 1).trim().toLowerCase() };
  }).filter((token) => token.value);
}
function paginateItems<T>(items: T[], page = 1, pageSize = 10) {
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 10));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;
  return { items: items.slice(startIndex, startIndex + safePageSize), pagination: { page: currentPage, pageSize: safePageSize, totalItems, totalPages } };
}
function matchesValue(entries: Array<string | number | boolean>, value: string) { return entries.some((entry) => String(entry).toLowerCase().includes(value)); }
function isPlatformSnapshotEmpty(data: PlatformData) { return data.admins.length === 0 && data.students.length === 0 && data.sessions.length === 0 && data.sessionActivities.length === 0 && data.quizSessions.length === 0 && data.attempts.length === 0; }
function readPlatformSnapshotFromSqlite(storagePath: string): PlatformData | null {
  const sqlitePath = resolveSqlitePath(storagePath);
  if (!existsSync(sqlitePath)) return null;
  const db = new Database(sqlitePath, { readonly: true });
  try {
    const settings = {
      questionsPerQuiz: Number((db.prepare("SELECT value FROM platform_meta WHERE key = ?").get("questionsPerQuiz") as { value?: string } | undefined)?.value ?? DEFAULT_QUIZ_QUESTION_COUNT),
      timeLimitMinutes: Number((db.prepare("SELECT value FROM platform_meta WHERE key = ?").get("timeLimitMinutes") as { value?: string } | undefined)?.value ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES)
    };
    const admins = db.prepare(`SELECT id, username, name, is_super_admin AS isSuperAdmin, password_hash AS passwordHash, password_salt AS passwordSalt, created_at AS createdAt, updated_at AS updatedAt FROM admins`).all() as AdminRecord[];
    const students = db.prepare(`SELECT id, register_number AS registerNumber, name, registered_name AS registeredName, password_hash AS passwordHash, password_salt AS passwordSalt, access_starts_at AS accessStartsAt, access_expires_at AS accessExpiresAt, created_at AS createdAt, updated_at AS updatedAt FROM students`).all() as StudentRecord[];
    const sessions = db.prepare(`SELECT id, token_hash AS tokenHash, user_id AS userId, role, created_at AS createdAt, expires_at AS expiresAt FROM sessions`).all() as SessionRecord[];
    const sessionActivities = db.prepare(`SELECT session_id AS sessionId, user_id AS userId, role, started_at AS startedAt, last_seen_at AS lastSeenAt, ended_at AS endedAt, request_count AS requestCount FROM session_activity`).all() as SessionActivityRecord[];
    const quizSessions = db.prepare(`SELECT id, student_id AS studentId, level, question_ids_json AS questionIdsJson, created_at AS createdAt, expires_at AS expiresAt FROM quiz_sessions`).all().map((row) => ({ id: (row as { id: string }).id, studentId: (row as { studentId: string }).studentId, level: (row as { level: Level }).level, questionIds: JSON.parse((row as { questionIdsJson: string }).questionIdsJson) as string[], createdAt: (row as { createdAt: string }).createdAt, expiresAt: (row as { expiresAt: string }).expiresAt })) as QuizSessionRecord[];
    const attempts = db.prepare(`SELECT id, quiz_id AS quizId, student_id AS studentId, level, score, total_questions AS totalQuestions, percentage, performance_label AS performanceLabel, completed_at AS completedAt, results_json AS resultsJson FROM attempts`).all().map((row) => ({ id: (row as { id: string }).id, quizId: (row as { quizId: string }).quizId, studentId: (row as { studentId: string }).studentId, level: (row as { level: Level }).level, score: Number((row as { score: number }).score), totalQuestions: Number((row as { totalQuestions: number }).totalQuestions), percentage: Number((row as { percentage: number }).percentage), performanceLabel: (row as { performanceLabel: PerformanceLabel }).performanceLabel, completedAt: (row as { completedAt: string }).completedAt, results: JSON.parse((row as { resultsJson: string }).resultsJson) as AttemptResultsPayload })) as AttemptRecord[];
    return { version: 1, settings, admins: admins.map((admin) => ({ ...admin, isSuperAdmin: Boolean(admin.isSuperAdmin) })), students, sessions, sessionActivities, quizSessions, attempts };
  } finally { db.close(); }
}

export class PostgresPlatformStore {
  private pool: Pool | null = null;
  private snapshotCache: CachedPlatformSnapshot | null = null;
  private snapshotPromise: Promise<CachedPlatformSnapshot> | null = null;
  private adminSetupRequiredCache: { value: boolean; expiresAt: number } | null = null;
  private readonly sessionLookupPromises = new Map<string, Promise<CachedSessionUser>>();
  private readonly sessionActivityTouchTimes = new Map<string, number>();
  private sessionCacheEpoch = 0;
  private lastPruneAt = 0;
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(private readonly storagePath: string, private readonly connectionString: string) {}

  async initialize(): Promise<void> {
    if (this.pool) return;
    const pool = openPostgresPool(this.connectionString);
    await applyPostgresSchema(pool);
    this.pool = pool;
    if (isPlatformSnapshotEmpty(await this.readSnapshotFromPostgres())) {
      await this.importSnapshotToPostgres(readPlatformSnapshotFromSqlite(this.storagePath) ?? readJsonFile<PlatformData>(this.storagePath) ?? EMPTY_PLATFORM_DATA);
    }
    await this.ensureSettings();
    await this.ensureSuperAdminInvariant();
    await this.maybePruneExpired(true);
    if (!this.pruneInterval) {
      this.pruneInterval = setInterval(() => {
        void this.maybePruneExpired().catch(() => {
          // Ignore background prune failures; foreground auth checks remain strict.
        });
      }, EXPIRY_PRUNE_WINDOW_MS);
      this.pruneInterval.unref?.();
    }
    await this.getSnapshot(true);
  }

  async adminSetupRequired() {
    const cached = this.adminSetupRequiredCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const row = await queryOne<{ count: number | string }>(this.requirePool(), "SELECT COUNT(*)::int AS count FROM admins");
    const value = Number(row?.count ?? 0) === 0;
    this.adminSetupRequiredCache = {
      value,
      expiresAt: Date.now() + ADMIN_SETUP_CACHE_TTL_MS
    };
    return value;
  }
  async getSettings(): Promise<QuizSettings> {
    const [questionsPerQuizRow, timeLimitMinutesRow] = await Promise.all([
      queryOne<{ value: string }>(this.requirePool(), "SELECT value FROM platform_meta WHERE key = $1", ["questionsPerQuiz"]),
      queryOne<{ value: string }>(this.requirePool(), "SELECT value FROM platform_meta WHERE key = $1", ["timeLimitMinutes"])
    ]);
    return { questionsPerQuiz: Number(questionsPerQuizRow?.value ?? DEFAULT_QUIZ_QUESTION_COUNT), timeLimitMinutes: Number(timeLimitMinutesRow?.value ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES) };
  }
  async listStudents(): Promise<StudentRosterEntry[]> {
    const rows = await queryMany<StudentListRowPayload>(
      this.requirePool(),
      `SELECT
        s.id::text AS id,
        s.email::text AS email,
        s.name,
        s.access_starts_at::text AS access_starts_at,
        s.access_expires_at::text AS access_expires_at,
        s.created_at::text AS created_at,
        s.updated_at::text AS updated_at,
        COUNT(a.id)::int AS attempts_count
      FROM students s
      LEFT JOIN attempts a ON a.student_id = s.id
      GROUP BY
        s.id,
        s.email,
        s.name,
        s.access_starts_at,
        s.access_expires_at,
        s.created_at,
        s.updated_at
      ORDER BY s.email ASC`
    );

    return rows.map((row) => {
      const student = {
        id: row.id,
        email: (row as any).email ?? row.register_number,
        name: row.name,
        accessStartsAt: isValidDateValue(row.access_starts_at) ? row.access_starts_at : row.created_at,
        accessExpiresAt: isValidDateValue(row.access_expires_at) ? row.access_expires_at : row.created_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
      const access = getStudentAccessSnapshot(student);

      return {
        ...access,
        id: student.id,
        name: student.name,
        email: student.email,
        attemptsCount: Number(row.attempts_count ?? 0),
        createdAt: student.createdAt,
        updatedAt: student.updatedAt
      };
    });
  }
  async listStudentsPage(options: { page?: number; pageSize?: number; search?: string }) {
    const tokens = tokenizeSearch(options.search);
    const students = (await this.listStudents()).filter((student) => !tokens.length || tokens.every((token) => this.matchesStudentToken(student, token)));
    const { items, pagination } = paginateItems(students, options.page, options.pageSize);
    return { students: items, pagination };
  }
  async listAdmins(): Promise<AdminRosterEntry[]> {
    const rows = await queryMany<AdminRowPayload>(
      this.requirePool(),
      `SELECT
        id::text AS id,
        email::text AS email,
        name,
        is_super_admin,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM admins
      ORDER BY is_super_admin DESC, email ASC`
    );

    return rows.map((row) =>
      this.toAdminRosterEntry({
        id: row.id,
        username: (row as any).email ?? row.username,
        name: row.name,
        isSuperAdmin: Boolean(row.is_super_admin),
        passwordHash: null,
        passwordSalt: null,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })
    );
  }
  async listAdminsPage(options: { page?: number; pageSize?: number; search?: string }) {
    const tokens = tokenizeSearch(options.search);
    const admins = (await this.listAdmins()).filter((admin) => !tokens.length || tokens.every((token) => this.matchesAdminToken(admin, token)));
    const { items, pagination } = paginateItems(admins, options.page, options.pageSize);
    return { admins: items, pagination };
  }
  async getPastScores(studentId: string): Promise<AttemptSummary[]> {
    const rows = await queryMany<AttemptRowPayload>(
      this.requirePool(),
      `SELECT
        id::text AS id,
        quiz_id::text AS quiz_id,
        student_id::text AS student_id,
        level,
        score,
        total_questions,
        percentage,
        performance_label,
        completed_at::text AS completed_at,
        results_json::text AS results_json
      FROM attempts
      WHERE student_id = $1::uuid
      ORDER BY completed_at DESC`,
      [studentId]
    );

    return rows.map((row) => toAttemptSummary(this.toAttemptRecord(row)));
  }
  async getAttemptDetail(studentId: string, attemptId: string): Promise<AttemptDetail> {
    const row = await queryOne<AttemptRowPayload>(
      this.requirePool(),
      `SELECT
        id::text AS id,
        quiz_id::text AS quiz_id,
        student_id::text AS student_id,
        level,
        score,
        total_questions,
        percentage,
        performance_label,
        completed_at::text AS completed_at,
        results_json::text AS results_json
      FROM attempts
      WHERE id = $1::uuid AND student_id = $2::uuid
      LIMIT 1`,
      [attemptId, studentId]
    );
    if (!row) throw new Error("Attempt not found.");
    return this.toAttemptDetail(this.toAttemptRecord(row));
  }
  async getAdminAssistantContext(query: string): Promise<AdminAssistantContext> {
    const snapshot = await this.getSnapshot();
    const students = this.buildStudentRoster(snapshot);
    const rankedMatches = this.findStudentsForAssistant(query, students);
    const matchedStudents = rankedMatches.slice(0, 12).map((student) => this.buildAssistantStudentSnapshot(student, snapshot));
    return {
      generatedAt: nowIso(),
      settings: snapshot.settings,
      adminsCount: snapshot.admins.length,
      studentsCount: students.length,
      activeStudentsCount: students.filter((student) => student.accessStatus === "active").length,
      expiredStudentsCount: students.filter((student) => student.accessStatus === "expired").length,
      registeredStudentsCount: students.length,
      pendingRegistrationCount: 0,
      totalAttemptsCount: snapshot.attempts.length,
      studentUsage: this.getUsageSummaryForRole("student", snapshot),
      matchedStudents,
      matchedStudentsCount: rankedMatches.length,
      recentAttempts: this.getRecentAttemptsForAssistant(snapshot, 8),
      studentLeaderboards: this.buildAssistantLeaderboards(students, snapshot),
      assistantPolicy: {
        applicationName: "Skillspark JET Examination Platform",
        aliases: ["Skillspark", "JET"],
        knowledgeAreas: [
          "student lookups by name or email",
          "student reports, attempts, scores, tracked session time, and mode performance",
          "rankings such as top students, efficient high scorers, low performers, expired access, and expiring access",
          "admin panel settings, bulk imports, student management, admin management, and question management"
        ],
        guardrails: [
          "Do not claim chat already created, updated, deleted, exported, or generated a file unless the operation result exists in context.",
          "Do not suggest creating, editing, deleting, or downgrading super admins through normal admin actions.",
          "Student emails must stay unique.",
          "Admin emails must stay unique.",
          "Questions must stay globally unique across all modes."
        ]
      },
      importGuides: {
        studentRoster: ["Student bulk upload accepts CSV, TXT, or XLSX.", "Each row must have name, email, and access days in that order.", "For XLSX, the first worksheet is used.", "Duplicate student emails inside the same upload are skipped.", "Existing student emails already in the system are skipped, and only new unique students are added."],
        questionWorkbook: ["Question bulk upload accepts XLSX only.", "Supported formats are separate Basic, Medium, Hard sheets, or one sheet with Basic/Medium/Hard marker rows, or one sheet with three separated populated blocks in that order.", "Question rows should carry question number, prompt/particulars, answer dropdown/account, debit, and credit values in the existing workbook structure.", "Question prompts are globally unique across Basic, Medium, and Hard. Duplicate prompts inside the upload are merged, and only unique questions not already in the bank are added."]
      }
    };
  }
  async hasActiveStudentAccess(studentOrId: string) { const student = await this.findStudentById(studentOrId); return student ? getStudentAccessSnapshot(student).accessStatus === "active" : false; }
  async updateSettings(nextSettings: QuizSettings) { await withPostgresTransaction(this.requirePool(), async (client) => { await this.setMeta("questionsPerQuiz", String(nextSettings.questionsPerQuiz), client); await this.setMeta("timeLimitMinutes", String(nextSettings.timeLimitMinutes), client); }); this.invalidateSnapshotCache(); }
  async bootstrapAdmin(name: string, username: string, password: string) {
    if (!name.trim() || !username.trim()) throw new Error("Admin name and username are required.");
    if (!await this.adminSetupRequired()) throw new Error("Admin setup has already been completed.");
    const passwordError = validatePassword(password); if (passwordError) throw new Error(passwordError);
    const { hash, salt } = await hashPassword(password); const timestamp = nowIso();
    const admin: AdminRecord = { id: randomUUID(), name: name.trim(), username: username.trim().toLowerCase(), isSuperAdmin: true, passwordHash: hash, passwordSalt: salt, createdAt: timestamp, updatedAt: timestamp };
    const token = await withPostgresTransaction(this.requirePool(), async (client) => { await this.insertAdmin(client, admin); return this.createSession(client, admin.id, "admin"); });
    this.invalidateSnapshotCache(); return { token, user: this.toAuthenticatedAdmin(admin) };
  }
  async loginAdmin(username: string, password: string) {
    const admin = await this.findAdminByUsername(username.trim());
    if (!admin || !admin.passwordHash || !admin.passwordSalt) throw new Error("Invalid admin credentials.");
    if (!await verifyPassword(password, admin.passwordSalt, admin.passwordHash)) throw new Error("Invalid admin credentials.");
    const token = await withPostgresTransaction(this.requirePool(), async (client) => this.createSession(client, admin.id, "admin"));
    this.invalidateSnapshotCache(); return { token, user: this.toAuthenticatedAdmin(admin) };
  }
  async loginStudent(registerNumber: string, password: string) {
    const student = await this.findStudentByRegisterNumber(registerNumber.trim());
    if (!student || !student.passwordHash || !student.passwordSalt) throw new Error("Invalid student credentials.");
    this.assertStudentHasActiveAccess(student);
    if (!await verifyPassword(password, student.passwordSalt, student.passwordHash)) throw new Error("Invalid student credentials.");
    const token = await withPostgresTransaction(this.requirePool(), async (client) => this.createSession(client, student.id, "student"));
    this.invalidateSnapshotCache(); return { token, user: this.toAuthenticatedStudent(student) };
  }
  async registerStudent(registerNumber: string, name: string, password: string) {
    const normalizedRegisterNumber = registerNumber.trim(), normalizedName = name.trim(), student = await this.findStudentByRegisterNumber(normalizedRegisterNumber);
    if (!student) throw new Error("Student record not found. Ask the admin to add you first.");
    this.assertStudentHasActiveAccess(student);
    if (student.passwordHash || student.passwordSalt) throw new Error("Password already exists for this student. Use login instead.");
    if (!normalizedName) throw new Error("Full name is required.");
    const passwordError = validatePassword(password); if (passwordError) throw new Error(passwordError);
    const { hash, salt } = await hashPassword(password);
    const updatedStudent: StudentRecord = { ...student, registeredName: normalizedName, passwordHash: hash, passwordSalt: salt, updatedAt: nowIso() };
    const token = await withPostgresTransaction(this.requirePool(), async (client) => { await this.upsertStudent(client, updatedStudent); return this.createSession(client, updatedStudent.id, "student"); });
    this.invalidateSnapshotCache(); return { token, user: this.toAuthenticatedStudent(updatedStudent) };
  }
  async loginAdminWithGoogle(name: string, email: string, superAdminEmail: string) {
    const normalizedEmail = normalizeGoogleEmail(email);
    const normalizedSuperAdminEmail = normalizeGoogleEmail(superAdminEmail);
    const emailError = validateGoogleEmail(normalizedEmail);
    if (emailError) throw new Error(emailError);
    const normalizedName = name.trim() || normalizedEmail;
    let admin = await this.findAdminByUsername(normalizedEmail);
    if (!admin) {
      if (normalizedEmail !== normalizedSuperAdminEmail && await this.getAdminCount() > 0) {
        throw new Error("This Google account is not authorized for admin access. Contact SkillSpark administrator.");
      }

      if (normalizedEmail !== normalizedSuperAdminEmail) {
        throw new Error(`Only ${normalizedSuperAdminEmail} can initialize the admin workspace.`);
      }

      admin = {
        id: randomUUID(),
        name: normalizedName,
        username: normalizedEmail,
        isSuperAdmin: true,
        passwordHash: null,
        passwordSalt: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      await withPostgresTransaction(this.requirePool(), async (client) => {
        await this.insertAdmin(client, admin as AdminRecord);
      });
      this.invalidateSnapshotCache();
    }

    if (normalizedEmail === normalizedSuperAdminEmail && !admin.isSuperAdmin) {
      admin = {
        ...admin,
        name: admin.name || normalizedName,
        isSuperAdmin: true,
        passwordHash: null,
        passwordSalt: null,
        updatedAt: nowIso()
      };

      await withPostgresTransaction(this.requirePool(), async (client) => {
        await this.upsertAdmin(client, admin as AdminRecord);
      });
      this.invalidateSnapshotCache();
    }

    const token = await withPostgresTransaction(this.requirePool(), async (client) => this.createSession(client, admin.id, "admin"));
    this.invalidateSnapshotCache();
    return { token, user: this.toAuthenticatedAdmin(admin) };
  }
  async loginStudentWithGoogle(email: string) {
    const normalizedEmail = normalizeGoogleEmail(email);
    const emailError = validateGoogleEmail(normalizedEmail);
    if (emailError) throw new Error(emailError);
    const student = await this.findStudentByRegisterNumber(normalizedEmail);
    if (!student) throw new Error("This Google account is not authorized. Contact SkillSpark administrator.");
    this.assertStudentHasActiveAccess(student);
    const token = await withPostgresTransaction(this.requirePool(), async (client) => this.createSession(client, student.id, "student"));
    this.invalidateSnapshotCache();
    return { token, user: this.toAuthenticatedStudent(student) };
  }
  async logout(sessionToken: string | null): Promise<void> {
    if (!sessionToken) return;
    const tokenHash = hashToken(sessionToken);
    await withPostgresTransaction(this.requirePool(), async (client) => {
      const session = await this.findSessionByTokenHash(tokenHash, client);
      if (!session) return;
      await this.closeSessionActivityNow(client, session.id);
      await client.query("DELETE FROM sessions WHERE id = $1::uuid", [session.id]);
    });
    this.invalidateSnapshotCache();
  }
  async getUserForSession(sessionToken: string | null, options?: { requireActiveStudentAccess?: boolean }): Promise<AuthenticatedUser | null> {
    if (!sessionToken) return null;
    const tokenHash = hashToken(sessionToken);
    const requireActiveStudentAccess = Boolean(options?.requireActiveStudentAccess);
    const cacheKey = this.getSessionCacheKey(tokenHash, requireActiveStudentAccess);
    const cached = sessionCache.get(cacheKey) as { value: CachedSessionUser; stale: boolean } | null;

    if (cached) {
      if (cached.value.sessionExpiresAtMs > 0 && cached.value.sessionExpiresAtMs <= Date.now()) {
        sessionCache.invalidate(cacheKey);
      } else {
        this.scheduleSessionActivityTouch(cached.value.sessionId);
        if (cached.stale) {
          void this.loadSessionUserCache(cacheKey, tokenHash, requireActiveStudentAccess).catch(() => {
            // Keep serving the stale-but-valid cached session when background refresh fails.
          });
        }
        return cached.value.user;
      }
    }

    const resolved = await this.loadSessionUserCache(cacheKey, tokenHash, requireActiveStudentAccess);
    return resolved.user;
  }
  async createStudent(registerNumber: string, name: string, accessDays: number): Promise<StudentRosterEntry> {
    const normalizedRegisterNumber = normalizeGoogleEmail(registerNumber);
    const normalizedName = name.trim();
    const normalizedAccessDays = validateAccessDays(accessDays);

    const emailError = validateGoogleEmail(normalizedRegisterNumber);
    if (emailError) {
      throw new Error(emailError);
    }

    if (!normalizedName) {
      throw new Error("Student name is required.");
    }

    const timestamp = nowIso();
    const accessWindow = buildStudentAccessWindow(normalizedAccessDays);

    if (await this.findStudentByRegisterNumber(normalizedRegisterNumber)) {
      throw new Error("That student email is already in use.");
    }

    const student: StudentRecord = {
      id: randomUUID(),
      registerNumber: normalizedRegisterNumber,
      name: normalizedName,
      registeredName: null,
      passwordHash: null,
      passwordSalt: null,
      accessStartsAt: accessWindow.accessStartsAt,
      accessExpiresAt: accessWindow.accessExpiresAt,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.insertStudent(client, student);
    });
    this.invalidateSnapshotCache();

    return (await this.listStudents()).find((entry) => entry.id === student.id) as StudentRosterEntry;
  }
  async createAdmin(name: string, username: string, password: string): Promise<AdminRosterEntry> {
    const normalizedName = name.trim();
    const normalizedUsername = normalizeGoogleEmail(username);

    const emailError = validateGoogleEmail(normalizedUsername);
    if (emailError) {
      throw new Error(emailError);
    }

    if (!normalizedName) {
      throw new Error("Admin name is required.");
    }

    const existing = await this.findAdminByUsername(normalizedUsername);
    if (existing) {
      throw new Error("That admin email is already in use.");
    }

    const timestamp = nowIso();
    const admin: AdminRecord = {
      id: randomUUID(),
      name: normalizedName,
      username: normalizedUsername,
      isSuperAdmin: false,
      passwordHash: null,
      passwordSalt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.insertAdmin(client, admin);
    });
    this.invalidateSnapshotCache();

    return this.toAdminRosterEntry(admin);
  }
  async importStudents(importedStudents: ImportedStudent[]): Promise<StudentImportResponse> {
    const { students: normalizedStudents, skippedDuplicates } = normalizeImportedStudents(importedStudents);
    let created = 0;
    let skipped = skippedDuplicates;

    if (!normalizedStudents.length) {
      return {
        created: 0,
        skipped,
        totalStudents: await this.getStudentCount()
      };
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      const existingRows = await queryMany<StudentRowPayload>(
        client,
        `SELECT
          id::text AS id,
          email::text AS register_number,
          name,
          NULL AS registered_name,
          NULL AS password_hash,
          NULL AS password_salt,
          access_starts_at::text AS access_starts_at,
          access_expires_at::text AS access_expires_at,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM students
        WHERE email = ANY($1::citext[])`,
        [normalizedStudents.map((student) => student.registerNumber)]
      );
      const existingByRegisterNumber = new Map(
        existingRows.map((row) => [row.register_number.toLowerCase(), {
          id: row.id,
          registerNumber: row.register_number,
          name: row.name,
          registeredName: null,
          passwordHash: null,
          passwordSalt: null,
          accessStartsAt: isValidDateValue(row.access_starts_at) ? row.access_starts_at : row.created_at,
          accessExpiresAt: isValidDateValue(row.access_expires_at) ? row.access_expires_at : row.created_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        } satisfies StudentRecord])
      );
      const rowsToInsert = [];

      for (const importedStudent of normalizedStudents) {
        const existing = existingByRegisterNumber.get(importedStudent.registerNumber.toLowerCase());
        if (existing) {
          skipped += 1;
          continue;
        }

        const timestamp = nowIso();
        const accessWindow = buildStudentAccessWindow(importedStudent.accessDays);
        rowsToInsert.push({
          id: randomUUID(),
          registerNumber: importedStudent.registerNumber,
          name: importedStudent.name,
          accessStartsAt: accessWindow.accessStartsAt,
          accessExpiresAt: accessWindow.accessExpiresAt,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        created += 1;
      }

      if (rowsToInsert.length > 0) {
        await client.query(
          `INSERT INTO students (
            id,
            email,
            name,
            access_starts_at,
            access_expires_at,
            created_at,
            updated_at
          )
          SELECT
            payload.id::uuid,
            payload.email,
            payload.name,
            payload.access_starts_at::timestamptz,
            payload.access_expires_at::timestamptz,
            payload.created_at::timestamptz,
            payload.updated_at::timestamptz
          FROM jsonb_to_recordset($1::jsonb) AS payload(
            id text,
            email text,
            name text,
            access_starts_at text,
            access_expires_at text,
            created_at text,
            updated_at text
          )`,
          [JSON.stringify(rowsToInsert.map((row) => ({
            id: row.id,
            email: row.registerNumber,
            name: row.name,
            access_starts_at: row.accessStartsAt,
            access_expires_at: row.accessExpiresAt,
            created_at: row.createdAt,
            updated_at: row.updatedAt
          })))]
        );
      }
    });
    this.invalidateSnapshotCache();

    return {
      created,
      skipped,
      totalStudents: await this.getStudentCount()
    };
  }
  async deleteStudent(studentId: string): Promise<void> {
    const student = await this.findStudentById(studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.closeSessionActivitiesForUsers(client, "student", [studentId]);
      await client.query("DELETE FROM sessions WHERE role = 'student' AND user_id = $1::uuid", [studentId]);
      await client.query("DELETE FROM students WHERE id = $1::uuid", [studentId]);
    });
    this.invalidateSnapshotCache();
  }
  async deleteStudents(studentIds: string[]): Promise<number> {
    const ids = [...new Set(studentIds)].filter(Boolean);
    if (!ids.length) {
      return 0;
    }

    const rows = await queryMany<{ id: string }>(
      this.requirePool(),
      "SELECT id FROM students WHERE id = ANY($1::uuid[])",
      [ids]
    );
    const existingIds = rows.map((row) => row.id);
    if (!existingIds.length) {
      return 0;
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.closeSessionActivitiesForUsers(client, "student", existingIds);
      await client.query("DELETE FROM sessions WHERE role = 'student' AND user_id = ANY($1::uuid[])", [existingIds]);
      await client.query("DELETE FROM students WHERE id = ANY($1::uuid[])", [existingIds]);
    });
    this.invalidateSnapshotCache();

    return existingIds.length;
  }
  async deleteAllStudents(): Promise<number> {
    const totalStudents = await this.getStudentCount();
    if (totalStudents === 0) {
      return 0;
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.closeSessionActivitiesForRole(client, "student");
      await client.query("DELETE FROM sessions WHERE role = 'student'");
      await client.query("DELETE FROM students");
    });
    this.invalidateSnapshotCache();

    return totalStudents;
  }
  async updateStudent(studentId: string, payload: UpdateStudentRequest): Promise<StudentRosterEntry> {
    const student = await this.findStudentById(studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    const normalizedRegisterNumber = normalizeGoogleEmail(payload.email);
    const normalizedName = payload.name.trim();
    const emailError = validateGoogleEmail(normalizedRegisterNumber);
    if (emailError) {
      throw new Error(emailError);
    }

    if (!normalizedName) {
      throw new Error("Student name is required.");
    }

    const duplicate = await this.findStudentByRegisterNumber(normalizedRegisterNumber);
    if (duplicate && duplicate.id !== studentId) {
      throw new Error("That email is already assigned to another student.");
    }

    let accessStartsAt = student.accessStartsAt;
    let accessExpiresAt = student.accessExpiresAt;

    if (payload.accessDaysToAdd !== undefined) {
      const accessWindow = this.extendStudentAccess(student, payload.accessDaysToAdd);
      accessStartsAt = accessWindow.accessStartsAt;
      accessExpiresAt = accessWindow.accessExpiresAt;
    }

    const updatedStudent: StudentRecord = {
      ...student,
      registerNumber: normalizedRegisterNumber,
      name: normalizedName,
      registeredName: null,
      passwordHash: null,
      passwordSalt: null,
      accessStartsAt,
      accessExpiresAt,
      updatedAt: nowIso()
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.upsertStudent(client, updatedStudent);
    });
    this.invalidateSnapshotCache();

    return (await this.listStudents()).find((entry) => entry.id === updatedStudent.id) as StudentRosterEntry;
  }
  async deleteAdmin(adminId: string, actingAdminId: string): Promise<void> {
    const admin = await this.findAdminById(adminId);

    if (!admin) {
      throw new Error("Admin not found.");
    }

    if (admin.id === actingAdminId) {
      throw new Error("You cannot remove your own admin account.");
    }

    if (await this.getAdminCount() <= 1) {
      throw new Error("At least one admin account must remain.");
    }

    if (admin.isSuperAdmin && await this.getSuperAdminCount() <= 1) {
      throw new Error("At least one super admin account must remain.");
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.closeSessionActivitiesForUsers(client, "admin", [adminId]);
      await client.query("DELETE FROM sessions WHERE role = 'admin' AND user_id = $1::uuid", [adminId]);
      await client.query("DELETE FROM admins WHERE id = $1::uuid", [adminId]);
    });
    this.invalidateSnapshotCache();
  }
  async deleteAdmins(adminIds: string[], actingAdminId: string): Promise<number> {
    const ids = [...new Set(adminIds)].filter((adminId) => adminId !== actingAdminId);
    let deleted = 0;

    for (const adminId of ids) {
      if (await this.findAdminById(adminId)) {
        await this.deleteAdmin(adminId, actingAdminId);
        deleted += 1;
      }
    }

    return deleted;
  }
  async updateAdmin(adminId: string, payload: UpdateAdminRequest): Promise<AdminRosterEntry> {
    const admin = await this.findAdminById(adminId);

    if (!admin) {
      throw new Error("Admin not found.");
    }

    const normalizedName = payload.name.trim();
    const normalizedUsername = normalizeGoogleEmail(payload.email);
    const emailError = validateGoogleEmail(normalizedUsername);
    if (emailError) {
      throw new Error(emailError);
    }

    if (!normalizedName) {
      throw new Error("Admin name is required.");
    }

    const duplicate = await this.findAdminByUsername(normalizedUsername);
    if (duplicate && duplicate.id !== adminId) {
      throw new Error("That email is already in use.");
    }

    const updatedAdmin: AdminRecord = {
      ...admin,
      name: normalizedName,
      username: normalizedUsername,
      passwordHash: null,
      passwordSalt: null,
      updatedAt: nowIso()
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.upsertAdmin(client, updatedAdmin);
    });
    this.invalidateSnapshotCache();

    return this.toAdminRosterEntry(updatedAdmin);
  }
  async createQuizSession(
    studentId: string,
    level: Level,
    questionIds: string[],
    timeLimitMinutes: number
  ): Promise<{ quizId: string; expiresAt: string; timeLimitMinutes: number }> {
    const quizSession: QuizSessionRecord = {
      id: randomUUID(),
      studentId,
      level,
      questionIds,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + timeLimitMinutes * 60 * 1000).toISOString()
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await client.query("DELETE FROM quiz_sessions WHERE student_id = $1::uuid", [studentId]);
      await this.insertQuizSession(client, quizSession);
    });
    this.invalidateSnapshotCache();

    return {
      quizId: quizSession.id,
      expiresAt: quizSession.expiresAt,
      timeLimitMinutes
    };
  }
  async getQuizSubmissionState(
    studentId: string,
    quizId: string
  ): Promise<{ status: "active"; quizSession: QuizSessionRecord } | { status: "completed"; attempt: AttemptDetail }> {
    const existingAttempt = await this.findAttemptByQuiz(studentId, quizId);
    if (existingAttempt) {
      return {
        status: "completed",
        attempt: this.toAttemptDetail(existingAttempt)
      };
    }

    const quizSession = await this.findQuizSession(studentId, quizId);
    if (!quizSession) {
      throw new Error("Quiz session not found or expired.");
    }

    return {
      status: "active",
      quizSession
    };
  }
  async completeQuizSession(studentId: string, results: AttemptResultsPayload, quizId: string): Promise<AttemptDetail> {
    const attempt = await withPostgresTransaction(this.requirePool(), async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [quizId]);

      const existingAttempt = await this.findAttemptByQuiz(studentId, quizId, client);
      if (existingAttempt) {
        return existingAttempt;
      }

      const quizSession = await this.findQuizSession(studentId, quizId, client);
      if (!quizSession) {
        const completedAttempt = await this.findAttemptByQuiz(studentId, quizId, client);
        if (completedAttempt) {
          return completedAttempt;
        }

        throw new Error("Quiz session not found or expired.");
      }

      await client.query("DELETE FROM quiz_sessions WHERE id = $1::uuid", [quizId]);

      const score = results.correctQuestions;
      const attemptRecord: AttemptRecord = {
        id: randomUUID(),
        quizId,
        studentId,
        level: results.level,
        score,
        totalQuestions: results.totalQuestions,
        percentage: results.totalQuestions === 0 ? 0 : score / results.totalQuestions,
        performanceLabel: getPerformanceLabel(score, results.totalQuestions),
        completedAt: nowIso(),
        results
      };

      const insertedAttempt = await queryOne<AttemptRowPayload>(
        client,
        `INSERT INTO attempts (
          id, quiz_id, student_id, level, score, total_questions, percentage, performance_label, completed_at, results_json
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)
        ON CONFLICT (quiz_id) DO NOTHING
        RETURNING
          id::text AS id,
          quiz_id::text AS quiz_id,
          student_id::text AS student_id,
          level,
          score,
          total_questions,
          percentage,
          performance_label,
          completed_at::text AS completed_at,
          results_json::text AS results_json`,
        [
          attemptRecord.id,
          attemptRecord.quizId,
          attemptRecord.studentId,
          attemptRecord.level,
          attemptRecord.score,
          attemptRecord.totalQuestions,
          attemptRecord.percentage,
          attemptRecord.performanceLabel,
          attemptRecord.completedAt,
          JSON.stringify(attemptRecord.results)
        ]
      );

      if (insertedAttempt) {
        return this.toAttemptRecord(insertedAttempt);
      }

      const duplicateAttempt = await this.findAttemptByQuiz(studentId, quizId, client);
      if (duplicateAttempt) {
        return duplicateAttempt;
      }

      throw new Error("Quiz submission could not be completed.");
    });
    this.invalidateSnapshotCache();
    return this.toAttemptDetail(attempt);
  }
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.invalidateSnapshotCache();
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    if (pool) {
      await pool.end();
    }
  }
  private async ensureSettings(): Promise<void> {
    const settings = await this.getSettings();
    if (!Number.isInteger(settings.questionsPerQuiz) || settings.questionsPerQuiz < 1) {
      await this.setMeta("questionsPerQuiz", String(DEFAULT_QUIZ_QUESTION_COUNT));
    }

    if (!Number.isInteger(settings.timeLimitMinutes) || settings.timeLimitMinutes < 1) {
      await this.setMeta("timeLimitMinutes", String(DEFAULT_QUIZ_TIME_LIMIT_MINUTES));
    }
  }
  private async ensureSuperAdminInvariant(): Promise<void> {
    if (await this.getAdminCount() === 0 || await this.getSuperAdminCount() > 0) {
      return;
    }

    const firstAdmin = await queryOne<{ id: string }>(
      this.requirePool(),
      "SELECT id FROM admins ORDER BY created_at ASC LIMIT 1"
    );
    if (!firstAdmin) {
      return;
    }

    await this.requirePool().query("UPDATE admins SET is_super_admin = TRUE WHERE id = $1::uuid", [firstAdmin.id]);
    this.invalidateSnapshotCache();
  }
  private async maybePruneExpired(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPruneAt < EXPIRY_PRUNE_WINDOW_MS) {
      return;
    }

    const sessionCutoff = new Date(now).toISOString();
    const quizCutoff = new Date(now - 1000 * 60 * 60 * 24).toISOString();
    await withPostgresTransaction(this.requirePool(), async (client) => {
      const expiredSessions = await queryMany<{ id: string }>(
        client,
        "SELECT id FROM sessions WHERE expires_at <= $1::timestamptz",
        [sessionCutoff]
      );
      if (expiredSessions.length > 0) {
        const sessionIds = expiredSessions.map((session) => session.id);
        for (const sessionId of sessionIds) {
          this.sessionActivityTouchTimes.delete(sessionId);
        }
        await client.query(
          `UPDATE session_activity
          SET ended_at = COALESCE(ended_at, last_seen_at)
          WHERE session_id = ANY($1::uuid[])`,
          [sessionIds]
        );
        await client.query("DELETE FROM sessions WHERE id = ANY($1::uuid[])", [sessionIds]);
      }

      await client.query("DELETE FROM quiz_sessions WHERE expires_at <= $1::timestamptz", [quizCutoff]);
    });

    this.lastPruneAt = now;
    this.invalidateSnapshotCache();
  }
  private async readSnapshotFromPostgres(): Promise<PlatformData> {
    const pool = this.requirePool();
    const [
      metaRows,
      adminRows,
      studentRows,
      sessionRows,
      sessionActivityRows,
      quizSessionRows,
      attemptRows
    ] = await Promise.all([
      queryMany<PlatformMetaRowPayload>(pool, "SELECT key, value FROM platform_meta"),
      queryMany<AdminRowPayload>(
        pool,
        `SELECT
          id::text AS id,
          email::text AS username,
          name,
          is_super_admin,
          NULL AS password_hash,
          NULL AS password_salt,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM admins`
      ),
      queryMany<StudentRowPayload>(
        pool,
        `SELECT
          id::text AS id,
          email::text AS register_number,
          name,
          NULL AS registered_name,
          NULL AS password_hash,
          NULL AS password_salt,
          access_starts_at::text AS access_starts_at,
          access_expires_at::text AS access_expires_at,
          created_at::text AS created_at,
          updated_at::text AS updated_at
        FROM students`
      ),
      queryMany<SessionRowPayload>(
        pool,
        `SELECT
          id::text AS id,
          token_hash,
          user_id::text AS user_id,
          role,
          created_at::text AS created_at,
          expires_at::text AS expires_at
        FROM sessions`
      ),
      queryMany<SessionActivityRowPayload>(
        pool,
        `SELECT
          session_id::text AS session_id,
          user_id::text AS user_id,
          role,
          started_at::text AS started_at,
          last_seen_at::text AS last_seen_at,
          ended_at::text AS ended_at,
          request_count
        FROM session_activity`
      ),
      queryMany<QuizSessionRowPayload>(
        pool,
        `SELECT
          id::text AS id,
          student_id::text AS student_id,
          level,
          question_ids,
          created_at::text AS created_at,
          expires_at::text AS expires_at
        FROM quiz_sessions`
      ),
      queryMany<AttemptRowPayload>(
        pool,
        `SELECT
          id::text AS id,
          quiz_id::text AS quiz_id,
          student_id::text AS student_id,
          level,
          score,
          total_questions,
          percentage,
          performance_label,
          completed_at::text AS completed_at,
          results_json::text AS results_json
        FROM attempts`
      )
    ]);

    const meta = new Map(metaRows.map((row) => [row.key, row.value]));
    return {
      version: 1,
      settings: {
        questionsPerQuiz: Number(meta.get("questionsPerQuiz") ?? DEFAULT_QUIZ_QUESTION_COUNT),
        timeLimitMinutes: Number(meta.get("timeLimitMinutes") ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES)
      },
      admins: adminRows.map((row) => ({
        id: row.id,
        username: row.username,
        name: row.name,
        isSuperAdmin: Boolean(row.is_super_admin),
        passwordHash: row.password_hash,
        passwordSalt: row.password_salt,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      students: studentRows.map((row) => ({
        id: row.id,
        registerNumber: row.register_number,
        name: row.name,
        registeredName: row.registered_name,
        passwordHash: row.password_hash,
        passwordSalt: row.password_salt,
        accessStartsAt: isValidDateValue(row.access_starts_at) ? row.access_starts_at : row.created_at,
        accessExpiresAt: isValidDateValue(row.access_expires_at) ? row.access_expires_at : row.created_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      })),
      sessions: sessionRows.map((row) => ({
        id: row.id,
        tokenHash: row.token_hash,
        userId: row.user_id,
        role: row.role,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      })),
      sessionActivities: sessionActivityRows.map((row) => ({
        sessionId: row.session_id,
        userId: row.user_id,
        role: row.role,
        startedAt: row.started_at,
        lastSeenAt: row.last_seen_at,
        endedAt: row.ended_at,
        requestCount: Number(row.request_count ?? 0)
      })),
      quizSessions: quizSessionRows.map((row) => ({
        id: row.id,
        studentId: row.student_id,
        level: row.level,
        questionIds: row.question_ids,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      })),
      attempts: attemptRows.map((row) => this.toAttemptRecord(row))
    };
  }
  private async importSnapshotToPostgres(data: PlatformData): Promise<void> {
    const snapshot = {
      ...EMPTY_PLATFORM_DATA,
      ...data,
      settings: {
        questionsPerQuiz: Number(data.settings?.questionsPerQuiz ?? DEFAULT_QUIZ_QUESTION_COUNT),
        timeLimitMinutes: Number(data.settings?.timeLimitMinutes ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES)
      }
    };

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await client.query("TRUNCATE TABLE attempts, quiz_sessions, session_activity, sessions, students, admins, platform_meta CASCADE");
      await this.setMeta("questionsPerQuiz", String(snapshot.settings.questionsPerQuiz), client);
      await this.setMeta("timeLimitMinutes", String(snapshot.settings.timeLimitMinutes), client);

      for (const admin of snapshot.admins ?? []) {
        await this.insertAdmin(client, {
          ...admin,
          isSuperAdmin: typeof admin.isSuperAdmin === "boolean" ? admin.isSuperAdmin : false
        });
      }

      for (const student of snapshot.students ?? []) {
        await this.insertStudent(client, {
          ...student,
          registeredName: "registeredName" in student && typeof student.registeredName === "string" ? student.registeredName : null,
          accessStartsAt: isValidDateValue(student.accessStartsAt) ? student.accessStartsAt : student.createdAt,
          accessExpiresAt: isValidDateValue(student.accessExpiresAt) ? student.accessExpiresAt : student.createdAt
        });
      }

      for (const session of snapshot.sessions ?? []) {
        await client.query(
          "INSERT INTO sessions (id, token_hash, user_id, role, created_at, expires_at) VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::timestamptz)",
          [session.id, session.tokenHash, session.userId, session.role, session.createdAt, session.expiresAt]
        );
      }

      for (const activity of snapshot.sessionActivities ?? []) {
        await client.query(
          `INSERT INTO session_activity (
            session_id, user_id, role, started_at, last_seen_at, ended_at, request_count
          ) VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7)`,
          [activity.sessionId, activity.userId, activity.role, activity.startedAt, activity.lastSeenAt, activity.endedAt, activity.requestCount]
        );
      }

      for (const quizSession of snapshot.quizSessions ?? []) {
        await this.insertQuizSession(client, quizSession);
      }

      for (const attempt of snapshot.attempts ?? []) {
        await client.query(
          `INSERT INTO attempts (
            id, quiz_id, student_id, level, score, total_questions, percentage, performance_label, completed_at, results_json
          ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb)`,
          [
            attempt.id,
            typeof attempt.quizId === "string" && attempt.quizId ? attempt.quizId : attempt.id,
            attempt.studentId,
            attempt.level,
            attempt.score,
            attempt.totalQuestions,
            attempt.percentage,
            attempt.performanceLabel,
            attempt.completedAt,
            JSON.stringify(attempt.results)
          ]
        );
      }
    });
    this.invalidateSnapshotCache();
  }
  private buildStudentRoster(snapshot: PlatformData): StudentRosterEntry[] {
    const attemptsByStudent = new Map<string, number>();
    for (const attempt of snapshot.attempts) {
      attemptsByStudent.set(attempt.studentId, (attemptsByStudent.get(attempt.studentId) ?? 0) + 1);
    }

    return [...snapshot.students]
      .sort((left, right) => left.registerNumber.localeCompare(right.registerNumber, undefined, { sensitivity: "base" }))
      .map((student) => ({
        ...getStudentAccessSnapshot(student),
        id: student.id,
        email: student.registerNumber,
        name: student.name,
        attemptsCount: attemptsByStudent.get(student.id) ?? 0,
        createdAt: student.createdAt,
        updatedAt: student.updatedAt
      }));
  }
  private matchesStudentToken(student: StudentRosterEntry, token: SearchToken): boolean {
    const searchable = [
      student.email,
      student.name,
      student.accessStatus,
      student.remainingAccessDays,
      student.accessStartsAt,
      student.accessExpiresAt,
      student.attemptsCount,
      student.createdAt,
      student.updatedAt
    ];

    if (!token.field) {
      return matchesValue(searchable, token.value);
    }

    if (["name"].includes(token.field)) {
      return matchesValue([student.name], token.value);
    }

    if (["email", "mail", "gmail"].includes(token.field)) {
      return matchesValue([student.email], token.value);
    }

    if (["status", "access"].includes(token.field)) {
      return matchesValue([student.accessStatus], token.value);
    }

    if (["day", "days", "remaining", "expires", "expiry"].includes(token.field)) {
      return matchesValue([student.remainingAccessDays, student.accessStartsAt, student.accessExpiresAt, student.accessStatus], token.value);
    }

    if (["attempt", "attempts"].includes(token.field)) {
      return matchesValue([student.attemptsCount], token.value);
    }

    if (["created", "updated", "date"].includes(token.field)) {
      return matchesValue([student.createdAt, student.updatedAt], token.value);
    }

    return matchesValue(searchable, token.value);
  }
  private matchesAdminToken(admin: AdminRosterEntry, token: SearchToken): boolean {
    const accessLabel = admin.isSuperAdmin ? "super admin" : "admin";
    const searchable = [admin.name, admin.email, accessLabel, admin.createdAt, admin.updatedAt];

    if (!token.field) {
      return matchesValue(searchable, token.value);
    }

    if (["name"].includes(token.field)) {
      return matchesValue([admin.name], token.value);
    }

    if (["email", "mail", "gmail", "login"].includes(token.field)) {
      return matchesValue([admin.email], token.value);
    }

    if (["access", "role"].includes(token.field)) {
      return matchesValue([accessLabel, admin.isSuperAdmin ? "super" : "standard"], token.value);
    }

    if (["created", "updated", "date"].includes(token.field)) {
      return matchesValue([admin.createdAt, admin.updatedAt], token.value);
    }

    return matchesValue(searchable, token.value);
  }
  private getUsageSummaryForRole(role: "admin" | "student", snapshot: PlatformData): AssistantUsageSummary {
    return this.getUsageSummary(role, null, snapshot);
  }
  private getUsageSummaryForUser(role: "admin" | "student", userId: string, snapshot: PlatformData): AssistantUsageSummary {
    return this.getUsageSummary(role, userId, snapshot);
  }
  private getUsageSummary(role: "admin" | "student", userId: string | null, snapshot: PlatformData): AssistantUsageSummary {
    const activities = snapshot.sessionActivities.filter((activity) =>
      activity.role === role && (!userId || activity.userId === userId)
    );

    let totalTrackedMinutes = 0;
    let lastSeenAt: string | null = null;
    let activeSessionCount = 0;
    let totalRequests = 0;

    for (const activity of activities) {
      totalRequests += Number(activity.requestCount ?? 0);
      if (!activity.endedAt) {
        activeSessionCount += 1;
      }

      const endTime = activity.endedAt && new Date(activity.endedAt).getTime() > new Date(activity.startedAt).getTime()
        ? new Date(activity.endedAt).getTime()
        : Math.max(new Date(activity.lastSeenAt).getTime(), new Date(activity.startedAt).getTime());
      totalTrackedMinutes += Math.max(0, endTime - new Date(activity.startedAt).getTime()) / (1000 * 60);

      if (!lastSeenAt || new Date(activity.lastSeenAt).getTime() > new Date(lastSeenAt).getTime()) {
        lastSeenAt = activity.lastSeenAt;
      }
    }

    return {
      sessionCount: activities.length,
      activeSessionCount,
      totalRequests,
      totalTrackedMinutes: Math.round(totalTrackedMinutes),
      lastSeenAt
    };
  }
  private getRecentAttemptsForAssistant(snapshot: PlatformData, limit: number): AssistantRecentAttempt[] {
    const studentsById = new Map(snapshot.students.map((student) => [student.id, student]));
    return [...snapshot.attempts]
      .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime())
      .slice(0, limit)
      .flatMap((attempt) => {
        const student = studentsById.get(attempt.studentId);
        if (!student) {
          return [];
        }

        return [{
          attemptId: attempt.id,
          studentId: student.id,
          email: student.registerNumber,
          name: student.name,
          level: attempt.level,
          score: attempt.score,
          totalQuestions: attempt.totalQuestions,
          percentage: attempt.percentage,
          performanceLabel: attempt.performanceLabel,
          completedAt: attempt.completedAt
        }];
      });
  }
  private findStudentsForAssistant(query: string, students: StudentRosterEntry[]): StudentRosterEntry[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const tokens = normalizedQuery
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);

    return students
      .map((student) => {
        const searchable = [student.email, student.name].map((value) => value.toLowerCase());
        let score = 0;

        if (searchable.some((value) => value === normalizedQuery)) {
          score += 8;
        }

        if (searchable.some((value) => value.includes(normalizedQuery))) {
          score += 5;
        }

        for (const token of tokens) {
          if (searchable.some((value) => value.includes(token))) {
            score += 2;
          }
        }

        return { student, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || right.student.attemptsCount - left.student.attemptsCount)
      .map((entry) => entry.student);
  }
  private buildAssistantStudentSnapshot(student: StudentRosterEntry, snapshot: PlatformData): AssistantStudentSnapshot {
    const scores = snapshot.attempts
      .filter((attempt) => attempt.studentId === student.id)
      .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime())
      .map((attempt) => toAttemptSummary(attempt));
    const latestAttempt = scores[0]
      ? {
          attemptId: scores[0].id,
          studentId: student.id,
          email: student.email,
          name: student.name,
          level: scores[0].level,
          score: scores[0].score,
          totalQuestions: scores[0].totalQuestions,
          percentage: scores[0].percentage,
          performanceLabel: scores[0].performanceLabel,
          completedAt: scores[0].completedAt
        }
      : null;

    const modePerformance = LEVELS.map((level) => {
      const modeScores = scores.filter((score) => score.level === level);
      const latestModeScore = modeScores[0] ?? null;
      return {
        level,
        attempts: modeScores.length,
        averagePercentage: modeScores.length
          ? Number((modeScores.reduce((total, score) => total + score.percentage, 0) / modeScores.length).toFixed(4))
          : null,
        latestScore: latestModeScore?.score ?? null,
        latestTotalQuestions: latestModeScore?.totalQuestions ?? null,
        latestPerformanceLabel: latestModeScore?.performanceLabel ?? null,
        latestCompletedAt: latestModeScore?.completedAt ?? null
      };
    });

    return {
      id: student.id,
      email: student.email,
      name: student.name,
      accessStartsAt: student.accessStartsAt,
      accessExpiresAt: student.accessExpiresAt,
      accessStatus: student.accessStatus,
      remainingAccessDays: student.remainingAccessDays,
      attemptsCount: student.attemptsCount,
      latestAttempt,
      modePerformance,
      usage: this.getUsageSummaryForUser("student", student.id, snapshot)
    };
  }
  private buildAssistantLeaderboards(
    students: StudentRosterEntry[],
    snapshot: PlatformData
  ): NonNullable<AdminAssistantContext["studentLeaderboards"]> {
    const rows: AssistantStudentLeaderboardEntry[] = students.map((student) => {
      const scores = snapshot.attempts
        .filter((attempt) => attempt.studentId === student.id)
        .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime())
        .map((attempt) => toAttemptSummary(attempt));
      const percentages = scores.map((score) => score.percentage);

      return {
        studentId: student.id,
        name: student.name,
        email: student.email,
        accessStatus: student.accessStatus,
        remainingAccessDays: student.remainingAccessDays,
        attemptsCount: student.attemptsCount,
        averagePercentage: percentages.length
          ? Number((percentages.reduce((total, value) => total + value, 0) / percentages.length).toFixed(4))
          : null,
        bestPercentage: percentages.length ? Number(Math.max(...percentages).toFixed(4)) : null,
        latestPercentage: scores[0] ? Number(scores[0].percentage.toFixed(4)) : null,
        lastCompletedAt: scores[0]?.completedAt ?? null
      };
    });

    return {
      topByAverage: [...rows]
        .filter((row) => row.averagePercentage !== null)
        .sort((left, right) =>
          (right.averagePercentage ?? -1) - (left.averagePercentage ?? -1) ||
          left.attemptsCount - right.attemptsCount ||
          (new Date(right.lastCompletedAt ?? 0).getTime() - new Date(left.lastCompletedAt ?? 0).getTime())
        )
        .slice(0, 8),
      topByEfficiency: [...rows]
        .filter((row) => row.bestPercentage !== null)
        .sort((left, right) =>
          (right.bestPercentage ?? -1) - (left.bestPercentage ?? -1) ||
          left.attemptsCount - right.attemptsCount ||
          (right.latestPercentage ?? -1) - (left.latestPercentage ?? -1)
        )
        .slice(0, 8),
      lowPerformers: [...rows]
        .filter((row) => row.latestPercentage !== null || row.averagePercentage !== null)
        .sort((left, right) =>
          (left.latestPercentage ?? left.averagePercentage ?? Number.POSITIVE_INFINITY) -
            (right.latestPercentage ?? right.averagePercentage ?? Number.POSITIVE_INFINITY) ||
          right.attemptsCount - left.attemptsCount
        )
        .slice(0, 8),
      expiredAccess: rows
        .filter((row) => row.accessStatus === "expired")
        .sort((left, right) =>
          left.remainingAccessDays - right.remainingAccessDays ||
          right.attemptsCount - left.attemptsCount
        )
        .slice(0, 8),
      expiringSoon: rows
        .filter((row) => row.accessStatus === "active")
        .sort((left, right) =>
          left.remainingAccessDays - right.remainingAccessDays ||
          right.attemptsCount - left.attemptsCount
        )
        .slice(0, 8)
    };
  }
  private extendStudentAccess(student: StudentRecord, accessDaysToAdd: number): { accessStartsAt: string; accessExpiresAt: string } {
    const normalizedAccessDays = validateAccessDays(accessDaysToAdd);
    const currentExpiryMs = isValidDateValue(student.accessExpiresAt) ? new Date(student.accessExpiresAt).getTime() : Number.NaN;
    const nowMs = Date.now();
    const baseMs = Number.isFinite(currentExpiryMs) && currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
    const accessWindow = buildStudentAccessWindow(normalizedAccessDays, baseMs);

    return {
      accessStartsAt:
        Number.isFinite(currentExpiryMs) && currentExpiryMs > nowMs && isValidDateValue(student.accessStartsAt)
          ? student.accessStartsAt
          : accessWindow.accessStartsAt,
      accessExpiresAt: accessWindow.accessExpiresAt
    };
  }
  private assertStudentHasActiveAccess(student: StudentRecord): void {
    if (getStudentAccessSnapshot(student).accessStatus !== "active") {
      throw new Error("Student access has expired. Contact the admin.");
    }
  }
  private async createSession(client: PoolClient, userId: string, role: "admin" | "student"): Promise<string> {
    const { token, tokenHash } = createSessionToken();
    const createdAt = nowIso();
    const sessionId = randomUUID();
    await client.query(
      "INSERT INTO sessions (id, token_hash, user_id, role, created_at, expires_at) VALUES ($1::uuid, $2, $3::uuid, $4, $5::timestamptz, $6::timestamptz)",
      [sessionId, tokenHash, userId, role, createdAt, new Date(Date.now() + getSessionMaxAgeSeconds() * 1000).toISOString()]
    );
    await client.query(
      `INSERT INTO session_activity (session_id, user_id, role, started_at, last_seen_at, ended_at, request_count)
      VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7)`,
      [sessionId, userId, role, createdAt, createdAt, null, 1]
    );
    return token;
  }
  private getSessionCacheKey(tokenHash: string, requireActiveStudentAccess: boolean): string {
    return `${tokenHash}:${requireActiveStudentAccess ? "active" : "any"}`;
  }
  private scheduleSessionActivityTouch(sessionId: string | null): void {
    if (!sessionId) {
      return;
    }

    void this.touchSessionActivity(sessionId).catch(() => {
      // Session activity tracking is non-critical and should not affect auth latency.
    });
  }
  private async loadSessionUserCache(
    cacheKey: string,
    tokenHash: string,
    requireActiveStudentAccess: boolean
  ): Promise<CachedSessionUser> {
    const existing = this.sessionLookupPromises.get(cacheKey);
    if (existing) {
      return existing;
    }

    const cacheEpoch = this.sessionCacheEpoch;
    const lookupPromise = this.findSessionUserByTokenHash(tokenHash, requireActiveStudentAccess)
      .then((resolved) => {
        if (cacheEpoch === this.sessionCacheEpoch) {
          const ttlMs = resolved.sessionExpiresAtMs > Date.now()
            ? Math.max(1, Math.min(60_000, resolved.sessionExpiresAtMs - Date.now()))
            : SESSION_USER_NEGATIVE_CACHE_TTL_MS;
          sessionCache.set(cacheKey, resolved, ttlMs);
        }
        this.scheduleSessionActivityTouch(resolved.user ? resolved.sessionId : null);
        return resolved;
      })
      .finally(() => {
        this.sessionLookupPromises.delete(cacheKey);
      });

    this.sessionLookupPromises.set(cacheKey, lookupPromise);
    return lookupPromise;
  }
  private async findSessionUserByTokenHash(
    tokenHash: string,
    requireActiveStudentAccess: boolean
  ): Promise<CachedSessionUser> {
    const row = await queryOne<SessionUserLookupRow>(
      this.requirePool(),
      `SELECT
        s.id::text AS session_id,
        s.user_id::text AS session_user_id,
        s.role AS session_role,
        s.expires_at::text AS session_expires_at,
        a.email::text AS admin_email,
        a.name AS admin_name,
        a.is_super_admin AS admin_is_super_admin,
        st.email::text AS student_email,
        st.name AS student_name,
        st.access_starts_at::text AS student_access_starts_at,
        st.access_expires_at::text AS student_access_expires_at
      FROM sessions s
      LEFT JOIN admins a
        ON s.role = 'admin' AND a.id = s.user_id
      LEFT JOIN students st
        ON s.role = 'student' AND st.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > timezone('utc', now())
      LIMIT 1`,
      [tokenHash]
    );

    if (!row) {
      return { user: null, sessionId: null, sessionExpiresAtMs: 0 };
    }

    const sessionExpiresAtMs = new Date(row.session_expires_at).getTime();
    if (row.session_role === "admin") {
      if (!row.admin_email || !row.admin_name) {
        return { user: null, sessionId: null, sessionExpiresAtMs };
      }

      return {
        user: {
          id: row.session_user_id,
          role: "admin",
          email: row.admin_email,
          name: row.admin_name,
          isSuperAdmin: Boolean(row.admin_is_super_admin),
          accessLevel: Boolean(row.admin_is_super_admin) ? "super_admin" : "admin"
        },
        sessionId: row.session_id,
        sessionExpiresAtMs
      };
    }

    if (!row.student_email || !row.student_name) {
      return { user: null, sessionId: null, sessionExpiresAtMs };
    }

    const accessStartsAt = isValidDateValue(row.student_access_starts_at) ? row.student_access_starts_at : nowIso();
    const accessExpiresAt = isValidDateValue(row.student_access_expires_at) ? row.student_access_expires_at : accessStartsAt;
    const access = getStudentAccessSnapshot({
      accessStartsAt,
      accessExpiresAt
    });

    if (requireActiveStudentAccess && access.accessStatus !== "active") {
      return { user: null, sessionId: null, sessionExpiresAtMs };
    }

    return {
      user: {
        id: row.session_user_id,
        role: "student",
        email: row.student_email,
        name: row.student_name,
        ...access
      },
      sessionId: row.session_id,
      sessionExpiresAtMs
    };
  }
  private async touchSessionActivity(sessionId: string): Promise<void> {
    const now = Date.now();
    const previousTouch = this.sessionActivityTouchTimes.get(sessionId);
    if (previousTouch && now - previousTouch < SESSION_ACTIVITY_TOUCH_WINDOW_MS) {
      return;
    }

    this.sessionActivityTouchTimes.set(sessionId, now);
    await this.requirePool().query(
      `UPDATE session_activity
      SET last_seen_at = $1::timestamptz, request_count = request_count + 1
      WHERE session_id = $2::uuid`,
      [new Date(now).toISOString(), sessionId]
    );
  }
  private async closeSessionActivityNow(client: PoolClient, sessionId: string): Promise<void> {
    this.sessionActivityTouchTimes.delete(sessionId);
    const timestamp = nowIso();
    await client.query(
      `UPDATE session_activity
      SET ended_at = COALESCE(ended_at, $1::timestamptz),
          last_seen_at = CASE WHEN last_seen_at < $1::timestamptz THEN $1::timestamptz ELSE last_seen_at END
      WHERE session_id = $2::uuid`,
      [timestamp, sessionId]
    );
  }
  private async closeSessionActivitiesForUsers(client: PoolClient, role: "admin" | "student", userIds: string[]): Promise<void> {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) {
      return;
    }

    const sessionRows = await queryMany<{ sessionId: string }>(
      client,
      `SELECT session_id::text AS "sessionId"
      FROM session_activity
      WHERE role = $1 AND user_id = ANY($2::uuid[])`,
      [role, ids]
    );
    for (const session of sessionRows) {
      this.sessionActivityTouchTimes.delete(session.sessionId);
    }

    await client.query(
      `UPDATE session_activity
      SET ended_at = COALESCE(ended_at, $1::timestamptz)
      WHERE role = $2 AND user_id = ANY($3::uuid[])`,
      [nowIso(), role, ids]
    );
  }
  private async closeSessionActivitiesForRole(client: PoolClient, role: "admin" | "student"): Promise<void> {
    const sessionRows = await queryMany<{ sessionId: string }>(
      client,
      `SELECT session_id::text AS "sessionId"
      FROM session_activity
      WHERE role = $1`,
      [role]
    );
    for (const session of sessionRows) {
      this.sessionActivityTouchTimes.delete(session.sessionId);
    }

    await client.query(
      `UPDATE session_activity
      SET ended_at = COALESCE(ended_at, $1::timestamptz)
      WHERE role = $2`,
      [nowIso(), role]
    );
  }
  private async insertAdmin(client: PoolClient, admin: AdminRecord): Promise<void> {
    await client.query(
      `INSERT INTO admins (
        id, email, name, is_super_admin, created_at, updated_at
      ) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
      [admin.id, admin.username, admin.name, admin.isSuperAdmin, admin.createdAt, admin.updatedAt]
    );
  }
  private async upsertAdmin(client: PoolClient, admin: AdminRecord): Promise<void> {
    await client.query(
      `INSERT INTO admins (
        id, email, name, is_super_admin, created_at, updated_at
      ) VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, $6::timestamptz)
      ON CONFLICT(id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        is_super_admin = EXCLUDED.is_super_admin,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [admin.id, admin.username, admin.name, admin.isSuperAdmin, admin.createdAt, admin.updatedAt]
    );
  }
  private async insertStudent(client: PoolClient, student: StudentRecord): Promise<void> {
    await client.query(
      `INSERT INTO students (
        id, email, name,
        access_starts_at, access_expires_at, created_at, updated_at
      ) VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz)`,
      [
        student.id,
        student.registerNumber,
        student.name,
        student.accessStartsAt,
        student.accessExpiresAt,
        student.createdAt,
        student.updatedAt
      ]
    );
  }
  private async upsertStudent(client: PoolClient, student: StudentRecord): Promise<void> {
    await client.query(
      `INSERT INTO students (
        id, email, name,
        access_starts_at, access_expires_at, created_at, updated_at
      ) VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, $7::timestamptz)
      ON CONFLICT(id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        access_starts_at = EXCLUDED.access_starts_at,
        access_expires_at = EXCLUDED.access_expires_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [
        student.id,
        student.registerNumber,
        student.name,
        student.accessStartsAt,
        student.accessExpiresAt,
        student.createdAt,
        student.updatedAt
      ]
    );
  }
  private async insertQuizSession(client: PoolClient, session: QuizSessionRecord): Promise<void> {
    await client.query(
      `INSERT INTO quiz_sessions (id, student_id, level, question_ids, created_at, expires_at)
      VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5::timestamptz, $6::timestamptz)`,
      [session.id, session.studentId, session.level, session.questionIds, session.createdAt, session.expiresAt]
    );
  }
  private async setMeta(key: string, value: string, client?: PoolClient): Promise<void> {
    await (client ?? this.requirePool()).query(
      `INSERT INTO platform_meta (key, value)
      VALUES ($1, $2)
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
  private async findAdminById(adminId: string, client?: PoolClient): Promise<AdminRecord | null> {
    const row = await queryOne<AdminRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        email::text AS username,
        name,
        is_super_admin,
        NULL AS password_hash,
        NULL AS password_salt,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM admins
      WHERE id = $1::uuid
      LIMIT 1`,
      [adminId]
    );
    return row ? {
      id: row.id,
      username: row.username,
      name: row.name,
      isSuperAdmin: Boolean(row.is_super_admin),
      passwordHash: null,
      passwordSalt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : null;
  }
  private async findAdminByUsername(username: string, client?: PoolClient): Promise<AdminRecord | null> {
    const row = await queryOne<AdminRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        email::text AS username,
        name,
        is_super_admin,
        NULL AS password_hash,
        NULL AS password_salt,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM admins
      WHERE email = $1
      LIMIT 1`,
      [username]
    );
    return row ? {
      id: row.id,
      username: row.username,
      name: row.name,
      isSuperAdmin: Boolean(row.is_super_admin),
      passwordHash: null,
      passwordSalt: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : null;
  }
  private async findStudentById(studentId: string, client?: PoolClient): Promise<StudentRecord | null> {
    const row = await queryOne<StudentRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        email::text AS register_number,
        name,
        NULL AS registered_name,
        NULL AS password_hash,
        NULL AS password_salt,
        access_starts_at::text AS access_starts_at,
        access_expires_at::text AS access_expires_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM students
      WHERE id = $1::uuid
      LIMIT 1`,
      [studentId]
    );
    return row ? {
      id: row.id,
      registerNumber: row.register_number,
      name: row.name,
      registeredName: null,
      passwordHash: null,
      passwordSalt: null,
      accessStartsAt: isValidDateValue(row.access_starts_at) ? row.access_starts_at : row.created_at,
      accessExpiresAt: isValidDateValue(row.access_expires_at) ? row.access_expires_at : row.created_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : null;
  }
  private async findStudentByRegisterNumber(registerNumber: string, client?: PoolClient): Promise<StudentRecord | null> {
    const row = await queryOne<StudentRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        email::text AS register_number,
        name,
        NULL AS registered_name,
        NULL AS password_hash,
        NULL AS password_salt,
        access_starts_at::text AS access_starts_at,
        access_expires_at::text AS access_expires_at,
        created_at::text AS created_at,
        updated_at::text AS updated_at
      FROM students
      WHERE email = $1
      LIMIT 1`,
      [registerNumber]
    );
    return row ? {
      id: row.id,
      registerNumber: row.register_number,
      name: row.name,
      registeredName: null,
      passwordHash: null,
      passwordSalt: null,
      accessStartsAt: isValidDateValue(row.access_starts_at) ? row.access_starts_at : row.created_at,
      accessExpiresAt: isValidDateValue(row.access_expires_at) ? row.access_expires_at : row.created_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    } : null;
  }
  private async findSessionByTokenHash(tokenHash: string, client?: PoolClient): Promise<SessionRecord | null> {
    const row = await queryOne<SessionRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        token_hash,
        user_id::text AS user_id,
        role,
        created_at::text AS created_at,
        expires_at::text AS expires_at
      FROM sessions
      WHERE token_hash = $1
      LIMIT 1`,
      [tokenHash]
    );
    return row ? {
      id: row.id,
      tokenHash: row.token_hash,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    } : null;
  }
  private async findActiveSessionByTokenHash(tokenHash: string, client?: PoolClient): Promise<SessionRecord | null> {
    const row = await queryOne<SessionRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        token_hash,
        user_id::text AS user_id,
        role,
        created_at::text AS created_at,
        expires_at::text AS expires_at
      FROM sessions
      WHERE token_hash = $1 AND expires_at > timezone('utc', now())
      LIMIT 1`,
      [tokenHash]
    );
    return row ? {
      id: row.id,
      tokenHash: row.token_hash,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    } : null;
  }
  private async findQuizSession(studentId: string, quizId: string, client?: PoolClient): Promise<QuizSessionRecord | null> {
    const row = await queryOne<QuizSessionRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        student_id::text AS student_id,
        level,
        question_ids,
        created_at::text AS created_at,
        expires_at::text AS expires_at
      FROM quiz_sessions
      WHERE id = $1::uuid AND student_id = $2::uuid
      LIMIT 1`,
      [quizId, studentId]
    );
    return row ? {
      id: row.id,
      studentId: row.student_id,
      level: row.level,
      questionIds: row.question_ids,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    } : null;
  }
  private async findAttemptByQuiz(studentId: string, quizId: string, client?: PoolClient): Promise<AttemptRecord | null> {
    const row = await queryOne<AttemptRowPayload>(
      client ?? this.requirePool(),
      `SELECT
        id::text AS id,
        quiz_id::text AS quiz_id,
        student_id::text AS student_id,
        level,
        score,
        total_questions,
        percentage,
        performance_label,
        completed_at::text AS completed_at,
        results_json::text AS results_json
      FROM attempts
      WHERE quiz_id = $1::uuid AND student_id = $2::uuid
      LIMIT 1`,
      [quizId, studentId]
    );
    return row ? this.toAttemptRecord(row) : null;
  }
  private async getAdminCount(client?: PoolClient): Promise<number> {
    const row = await queryOne<{ count: number | string }>(client ?? this.requirePool(), "SELECT COUNT(*)::int AS count FROM admins");
    return Number(row?.count ?? 0);
  }
  private async getSuperAdminCount(client?: PoolClient): Promise<number> {
    const row = await queryOne<{ count: number | string }>(
      client ?? this.requirePool(),
      "SELECT COUNT(*)::int AS count FROM admins WHERE is_super_admin = TRUE"
    );
    return Number(row?.count ?? 0);
  }
  private async getStudentCount(client?: PoolClient): Promise<number> {
    const row = await queryOne<{ count: number | string }>(client ?? this.requirePool(), "SELECT COUNT(*)::int AS count FROM students");
    return Number(row?.count ?? 0);
  }
  private invalidateSnapshotCache(): void {
    this.snapshotCache = null;
    this.snapshotPromise = null;
    this.adminSetupRequiredCache = null;
    this.sessionCacheEpoch += 1;
    this.sessionLookupPromises.clear();
    sessionCache.clear();
  }
  private async getSnapshot(forceReload = false): Promise<CachedPlatformSnapshot> {
    if (!forceReload && this.snapshotCache && Date.now() - this.snapshotCache.loadedAt < PLATFORM_SNAPSHOT_TTL_MS) {
      return this.snapshotCache;
    }

    if (!forceReload && this.snapshotPromise) {
      return this.snapshotPromise;
    }

    const snapshotPromise = this.readSnapshotFromPostgres().then((snapshot) => {
      const cached: CachedPlatformSnapshot = {
        ...snapshot,
        loadedAt: Date.now()
      };
      this.snapshotCache = cached;
      this.snapshotPromise = null;
      return cached;
    }).catch((error) => {
      this.snapshotPromise = null;
      throw error;
    });

    this.snapshotPromise = snapshotPromise;
    return snapshotPromise;
  }
  private toAttemptRecord(row: AttemptRowPayload): AttemptRecord {
    return {
      id: row.id,
      quizId: row.quiz_id,
      studentId: row.student_id,
      level: row.level,
      score: Number(row.score),
      totalQuestions: Number(row.total_questions),
      percentage: Number(row.percentage),
      performanceLabel: row.performance_label,
      completedAt: row.completed_at,
      results: JSON.parse(row.results_json) as AttemptResultsPayload
    };
  }
  private toAuthenticatedAdmin(admin: AdminRecord): AuthenticatedAdmin {
    return {
      id: admin.id,
      role: "admin",
      email: admin.username,
      name: admin.name,
      isSuperAdmin: admin.isSuperAdmin,
      accessLevel: admin.isSuperAdmin ? "super_admin" : "admin"
    };
  }
  private toAdminRosterEntry(admin: AdminRecord): AdminRosterEntry {
    return {
      id: admin.id,
      email: admin.username,
      name: admin.name,
      isSuperAdmin: admin.isSuperAdmin,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt
    };
  }
  private toAuthenticatedStudent(student: StudentRecord): AuthenticatedStudent {
    const access = getStudentAccessSnapshot(student);
    return {
      id: student.id,
      role: "student",
      email: student.registerNumber,
      name: student.name,
      ...access
    };
  }
  private toAttemptDetail(attempt: AttemptRecord): AttemptDetail {
    return {
      attemptId: attempt.id,
      score: attempt.score,
      performanceLabel: attempt.performanceLabel,
      completedAt: attempt.completedAt,
      ...attempt.results
    };
  }
  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("Platform store has not been initialized.");
    }

    return this.pool;
  }
}
