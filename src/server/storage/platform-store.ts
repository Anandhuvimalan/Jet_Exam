import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
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
import {
  createSessionToken,
  getSessionMaxAgeSeconds,
  hashPassword,
  hashToken,
  validatePassword,
  verifyPassword
} from "../services/security";
import { normalizeGoogleEmail, validateGoogleEmail } from "../services/google-auth";
import type { ImportedStudent } from "../import/student-roster";
import { getLegacyJsonPath, openSqliteDatabase, readJsonFile, withTransaction } from "./sqlite";

interface PasswordCredential {
  passwordHash: string | null;
  passwordSalt: string | null;
}

interface AdminRecord extends PasswordCredential {
  id: string;
  username: string;
  name: string;
  isSuperAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StudentRecord extends PasswordCredential {
  id: string;
  registerNumber: string;
  name: string;
  registeredName: string | null;
  accessStartsAt: string;
  accessExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionRecord {
  id: string;
  tokenHash: string;
  userId: string;
  role: "admin" | "student";
  createdAt: string;
  expiresAt: string;
}

interface QuizSessionRecord {
  id: string;
  studentId: string;
  level: Level;
  questionIds: string[];
  createdAt: string;
  expiresAt: string;
}

type AttemptResultsPayload = Omit<AttemptDetail, "attemptId" | "score" | "performanceLabel" | "completedAt">;

interface AttemptRecord {
  id: string;
  quizId: string;
  studentId: string;
  level: Level;
  score: number;
  totalQuestions: number;
  percentage: number;
  performanceLabel: PerformanceLabel;
  completedAt: string;
  results: AttemptResultsPayload;
}

interface PlatformData {
  version: number;
  settings: QuizSettings;
  admins: AdminRecord[];
  students: StudentRecord[];
  sessions: SessionRecord[];
  quizSessions: QuizSessionRecord[];
  attempts: AttemptRecord[];
}

type QuizSubmissionState =
  | { status: "active"; quizSession: QuizSessionRecord }
  | { status: "completed"; attempt: AttemptDetail };

interface SearchToken {
  field: string | null;
  value: string;
}

interface AdminRowRecord {
  id: string;
  username: string;
  name: string;
  isSuperAdmin: number;
  passwordHash: string | null;
  passwordSalt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StudentRowRecord {
  id: string;
  registerNumber: string;
  name: string;
  registeredName: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  accessStartsAt: string | null;
  accessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StudentListRowRecord extends StudentRowRecord {
  attemptsCount: number;
}

interface SessionRowRecord {
  id: string;
  tokenHash: string;
  userId: string;
  role: "admin" | "student";
  createdAt: string;
  expiresAt: string;
}

interface SessionActivityRowRecord {
  sessionId: string;
  userId: string;
  role: "admin" | "student";
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  requestCount: number;
}

interface AssistantUsageSummary {
  sessionCount: number;
  activeSessionCount: number;
  totalRequests: number;
  totalTrackedMinutes: number;
  lastSeenAt: string | null;
}

interface AssistantUsageSummaryRowRecord {
  sessionCount: number;
  activeSessionCount: number;
  totalRequests: number;
  totalTrackedMinutes: number;
  lastSeenAt: string | null;
}

interface AssistantRecentAttemptRowRecord {
  id: string;
  studentId: string;
  email: string;
  name: string;
  level: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  performanceLabel: string;
  completedAt: string;
}

interface AssistantRecentAttempt {
  attemptId: string;
  studentId: string;
  email: string;
  name: string;
  level: Level;
  score: number;
  totalQuestions: number;
  percentage: number;
  performanceLabel: PerformanceLabel;
  completedAt: string;
}

interface AssistantModePerformance {
  level: Level;
  attempts: number;
  averagePercentage: number | null;
  latestScore: number | null;
  latestTotalQuestions: number | null;
  latestPerformanceLabel: PerformanceLabel | null;
  latestCompletedAt: string | null;
}

interface AssistantStudentSnapshot {
  id: string;
  email: string;
  name: string;
  accessStartsAt: string;
  accessExpiresAt: string;
  accessStatus: StudentAccessStatus;
  remainingAccessDays: number;
  attemptsCount: number;
  latestAttempt: AssistantRecentAttempt | null;
  modePerformance: AssistantModePerformance[];
  usage: AssistantUsageSummary;
}

export interface AssistantStudentLeaderboardEntry {
  studentId: string;
  name: string;
  email: string;
  accessStatus: StudentAccessStatus;
  remainingAccessDays: number;
  attemptsCount: number;
  averagePercentage: number | null;
  bestPercentage: number | null;
  latestPercentage: number | null;
  lastCompletedAt: string | null;
}

export interface AdminAssistantContext {
  generatedAt: string;
  settings: QuizSettings;
  adminsCount: number;
  studentsCount: number;
  activeStudentsCount: number;
  expiredStudentsCount: number;
  registeredStudentsCount: number;
  pendingRegistrationCount: number;
  totalAttemptsCount: number;
  studentUsage: AssistantUsageSummary;
  matchedStudents: AssistantStudentSnapshot[];
  matchedStudentsCount?: number;
  recentAttempts: AssistantRecentAttempt[];
  studentLeaderboards?: {
    topByAverage: AssistantStudentLeaderboardEntry[];
    topByEfficiency: AssistantStudentLeaderboardEntry[];
    lowPerformers: AssistantStudentLeaderboardEntry[];
    expiredAccess: AssistantStudentLeaderboardEntry[];
    expiringSoon: AssistantStudentLeaderboardEntry[];
  };
  assistantPolicy?: {
    applicationName: string;
    aliases: string[];
    knowledgeAreas: string[];
    guardrails: string[];
  };
  importGuides: {
    studentRoster: string[];
    questionWorkbook: string[];
  };
}

interface QuizSessionRowRecord {
  id: string;
  studentId: string;
  level: string;
  questionIdsJson: string;
  createdAt: string;
  expiresAt: string;
}

interface AttemptRowRecord {
  id: string;
  quizId: string;
  studentId: string;
  level: string;
  score: number;
  totalQuestions: number;
  percentage: number;
  performanceLabel: string;
  completedAt: string;
  resultsJson: string;
}

const EMPTY_PLATFORM_DATA: PlatformData = {
  version: 1,
  settings: {
    questionsPerQuiz: DEFAULT_QUIZ_QUESTION_COUNT,
    timeLimitMinutes: DEFAULT_QUIZ_TIME_LIMIT_MINUTES
  },
  admins: [],
  students: [],
  sessions: [],
  quizSessions: [],
  attempts: []
};

const ACCESS_DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_ACTIVITY_TOUCH_WINDOW_MS = 15_000;

function nowIso(): string {
  return new Date().toISOString();
}

function isValidDateValue(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function validateAccessDays(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error("Access days must be a whole number between 1 and 3650.");
  }

  return value;
}

function buildStudentAccessWindow(accessDays: number, baseTimeMs = Date.now()): { accessStartsAt: string; accessExpiresAt: string } {
  const normalizedAccessDays = validateAccessDays(accessDays);
  return {
    accessStartsAt: new Date(baseTimeMs).toISOString(),
    accessExpiresAt: new Date(baseTimeMs + normalizedAccessDays * ACCESS_DAY_MS).toISOString()
  };
}

function normalizeImportedStudents(importedStudents: ImportedStudent[]): {
  students: Array<{
    registerNumber: string;
    name: string;
    accessDays: number;
  }>;
  skippedDuplicates: number;
} {
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

function getStudentAccessSnapshot(student: Pick<StudentRecord, "accessStartsAt" | "accessExpiresAt">): {
  accessStartsAt: string;
  accessExpiresAt: string;
  accessStatus: StudentAccessStatus;
  remainingAccessDays: number;
} {
  const startsAt = isValidDateValue(student.accessStartsAt) ? student.accessStartsAt : nowIso();
  const expiresAt = isValidDateValue(student.accessExpiresAt) ? student.accessExpiresAt : startsAt;
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());

  return {
    accessStartsAt: startsAt,
    accessExpiresAt: expiresAt,
    accessStatus: remainingMs > 0 ? "active" : "expired",
    remainingAccessDays: remainingMs > 0 ? Math.ceil(remainingMs / ACCESS_DAY_MS) : 0
  };
}

function toAttemptSummary(record: AttemptRecord): AttemptSummary {
  return {
    id: record.id,
    level: record.level,
    score: record.score,
    totalQuestions: record.totalQuestions,
    percentage: record.percentage,
    performanceLabel: record.performanceLabel,
    completedAt: record.completedAt
  };
}

function getPerformanceLabel(score: number, totalQuestions: number): PerformanceLabel {
  if (totalQuestions === 0) {
    return "Poor";
  }

  const percentage = score / totalQuestions;
  if (percentage < 0.4) return "Poor";
  if (percentage < 0.7) return "Good";
  if (percentage < 0.9) return "Very Good";
  return "Excellent";
}

function tokenizeSearch(search?: string): SearchToken[] {
  if (!search?.trim()) {
    return [];
  }

  const matches = search.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return matches
    .map((token) => token.replace(/^"|"$/g, "").trim())
    .filter(Boolean)
    .map((token) => {
      const separatorIndex = token.indexOf(":");
      if (separatorIndex <= 0) {
        return { field: null, value: token.toLowerCase() };
      }

      return {
        field: token.slice(0, separatorIndex).toLowerCase(),
        value: token.slice(separatorIndex + 1).trim().toLowerCase()
      };
    })
    .filter((token) => token.value);
}

function paginateItems<T>(items: T[], page = 1, pageSize = 10): { items: T[]; pagination: PaginationMeta } {
  const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 10));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const currentPage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const startIndex = (currentPage - 1) * safePageSize;

  return {
    items: items.slice(startIndex, startIndex + safePageSize),
    pagination: {
      page: currentPage,
      pageSize: safePageSize,
      totalItems,
      totalPages
    }
  };
}

function matchesValue(entries: Array<string | number | boolean>, value: string): boolean {
  return entries.some((entry) => String(entry).toLowerCase().includes(value));
}

export class PlatformStore {
  private db: Database.Database | null = null;
  private readonly legacyJsonPath: string | null;
  private readonly sessionActivityTouchTimes = new Map<string, number>();

  constructor(private readonly storagePath: string) {
    this.legacyJsonPath = getLegacyJsonPath(storagePath);
  }

  async initialize(): Promise<void> {
    if (this.db) {
      return;
    }

    const db = openSqliteDatabase(this.storagePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        is_super_admin INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT,
        password_salt TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        register_number TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        registered_name TEXT,
        password_hash TEXT,
        password_salt TEXT,
        access_starts_at TEXT,
        access_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_activity (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ended_at TEXT,
        request_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL,
        level TEXT NOT NULL,
        question_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        quiz_id TEXT NOT NULL UNIQUE,
        student_id TEXT NOT NULL,
        level TEXT NOT NULL,
        score INTEGER NOT NULL,
        total_questions INTEGER NOT NULL,
        percentage REAL NOT NULL,
        performance_label TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        results_json TEXT NOT NULL,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_session_activity_user_role ON session_activity(user_id, role);
      CREATE INDEX IF NOT EXISTS idx_students_register_number ON students(register_number);
      CREATE INDEX IF NOT EXISTS idx_admins_username ON admins(username);
      CREATE INDEX IF NOT EXISTS idx_quiz_sessions_student_id ON quiz_sessions(student_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_student_id ON attempts(student_id);
    `);

    this.db = db;
    this.ensureStudentAccessColumns();

    if (this.isDatabaseEmpty()) {
      const legacyData = readJsonFile<PlatformData>(this.legacyJsonPath);
      if (legacyData) {
        this.importLegacyData(legacyData);
      }
    }

    this.ensureSettings();
    this.ensureSuperAdminInvariant();
    this.pruneExpired();
  }

  adminSetupRequired(): boolean {
    return this.getAdminCount() === 0;
  }

  getSettings(): QuizSettings {
    return {
      questionsPerQuiz: Number(this.getMeta("questionsPerQuiz") ?? DEFAULT_QUIZ_QUESTION_COUNT),
      timeLimitMinutes: Number(this.getMeta("timeLimitMinutes") ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES)
    };
  }

  async updateSettings(nextSettings: QuizSettings): Promise<void> {
    withTransaction(this.requireDb(), () => {
      this.setMeta("questionsPerQuiz", String(nextSettings.questionsPerQuiz));
      this.setMeta("timeLimitMinutes", String(nextSettings.timeLimitMinutes));
    });
  }

  async bootstrapAdmin(name: string, username: string, password: string): Promise<{ token: string; user: AuthenticatedAdmin }> {
    if (this.getAdminCount() > 0) {
      throw new Error("Admin setup has already been completed.");
    }

    if (!name.trim() || !username.trim()) {
      throw new Error("Admin name and username are required.");
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      throw new Error(passwordError);
    }

    const { hash, salt } = await hashPassword(password);
    const timestamp = nowIso();
    const admin: AdminRecord = {
      id: randomUUID(),
      name: name.trim(),
      username: username.trim().toLowerCase(),
      isSuperAdmin: true,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const token = withTransaction(this.requireDb(), () => {
      this.insertAdmin(admin);
      return this.createSession(admin.id, "admin").token;
    });

    return {
      token,
      user: this.toAuthenticatedAdmin(admin)
    };
  }

  async loginAdmin(username: string, password: string): Promise<{ token: string; user: AuthenticatedAdmin }> {
    const admin = this.findAdminByUsername(username.trim());

    if (!admin || !admin.passwordHash || !admin.passwordSalt) {
      throw new Error("Invalid admin credentials.");
    }

    const valid = await verifyPassword(password, admin.passwordSalt, admin.passwordHash);
    if (!valid) {
      throw new Error("Invalid admin credentials.");
    }

    const token = withTransaction(this.requireDb(), () => this.createSession(admin.id, "admin").token);

    return {
      token,
      user: this.toAuthenticatedAdmin(admin)
    };
  }

  async loginStudent(registerNumber: string, password: string): Promise<{ token: string; user: AuthenticatedStudent }> {
    const student = this.findStudentByRegisterNumber(registerNumber.trim());

    if (!student || !student.passwordHash || !student.passwordSalt) {
      throw new Error("Invalid student credentials.");
    }

    this.assertStudentHasActiveAccess(student);

    const valid = await verifyPassword(password, student.passwordSalt, student.passwordHash);
    if (!valid) {
      throw new Error("Invalid student credentials.");
    }

    const token = withTransaction(this.requireDb(), () => this.createSession(student.id, "student").token);

    return {
      token,
      user: this.toAuthenticatedStudent(student)
    };
  }

  async registerStudent(registerNumber: string, name: string, password: string): Promise<{ token: string; user: AuthenticatedStudent }> {
    const normalizedRegisterNumber = registerNumber.trim();
    const normalizedName = name.trim();
    const student = this.findStudentByRegisterNumber(normalizedRegisterNumber);

    if (!student) {
      throw new Error("Student record not found. Ask the admin to add you first.");
    }

    this.assertStudentHasActiveAccess(student);

    if (student.passwordHash || student.passwordSalt) {
      throw new Error("Password already exists for this student. Use login instead.");
    }

    if (!normalizedName) {
      throw new Error("Full name is required.");
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      throw new Error(passwordError);
    }

    const { hash, salt } = await hashPassword(password);
    const updatedStudent: StudentRecord = {
      ...student,
      registeredName: normalizedName,
      passwordHash: hash,
      passwordSalt: salt,
      updatedAt: nowIso()
    };

    const token = withTransaction(this.requireDb(), () => {
      this.upsertStudent(updatedStudent);
      return this.createSession(updatedStudent.id, "student").token;
    });

    return {
      token,
      user: this.toAuthenticatedStudent(updatedStudent)
    };
  }

  async logout(sessionToken: string | null): Promise<void> {
    if (!sessionToken) {
      return;
    }

    const tokenHash = hashToken(sessionToken);
    const db = this.requireDb();
    const session = db.prepare(`
      SELECT
        id,
        token_hash AS tokenHash,
        user_id AS userId,
        role,
        created_at AS createdAt,
        expires_at AS expiresAt
      FROM sessions
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash) as SessionRowRecord | undefined;

    if (!session) {
      return;
    }

    withTransaction(db, () => {
      this.closeSessionActivityNow(session.id);
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    });
  }

  getUserForSession(sessionToken: string | null, options?: { requireActiveStudentAccess?: boolean }): AuthenticatedUser | null {
    if (!sessionToken) {
      return null;
    }

    this.pruneExpired();

    const tokenHash = hashToken(sessionToken);
    const sessionRow = this.requireDb().prepare(`
      SELECT
        id,
        token_hash AS tokenHash,
        user_id AS userId,
        role,
        created_at AS createdAt,
        expires_at AS expiresAt
      FROM sessions
      WHERE token_hash = ?
      LIMIT 1
    `).get(tokenHash) as SessionRowRecord | undefined;

    if (!sessionRow) {
      return null;
    }

    this.touchSessionActivity(sessionRow.id);

    if (sessionRow.role === "admin") {
      const admin = this.findAdminById(sessionRow.userId);
      return admin ? this.toAuthenticatedAdmin(admin) : null;
    }

    const student = this.findStudentById(sessionRow.userId);
    if (!student) {
      return null;
    }

    if (options?.requireActiveStudentAccess && !this.hasActiveStudentAccess(student)) {
      return null;
    }

    return this.toAuthenticatedStudent(student);
  }

  listStudents(): StudentRosterEntry[] {
    const rows = this.requireDb().prepare(`
      SELECT
        s.id,
        s.register_number AS registerNumber,
        s.name,
        s.registered_name AS registeredName,
        s.password_hash AS passwordHash,
        s.password_salt AS passwordSalt,
        s.access_starts_at AS accessStartsAt,
        s.access_expires_at AS accessExpiresAt,
        s.created_at AS createdAt,
        s.updated_at AS updatedAt,
        CAST(COUNT(a.id) AS INTEGER) AS attemptsCount
      FROM students s
      LEFT JOIN attempts a ON a.student_id = s.id
      GROUP BY s.id
      ORDER BY s.register_number COLLATE NOCASE
    `).all() as unknown as StudentListRowRecord[];

    return rows.map((student) => ({
      ...getStudentAccessSnapshot(this.toStudentRecord(student)),
      id: student.id,
      name: student.name,
      email: student.registerNumber,
      attemptsCount: Number(student.attemptsCount ?? 0),
      createdAt: student.createdAt,
      updatedAt: student.updatedAt
    }));
  }

  listStudentsPage(options: { page?: number; pageSize?: number; search?: string }): { students: StudentRosterEntry[]; pagination: PaginationMeta } {
    const tokens = tokenizeSearch(options.search);
    const students = this.listStudents().filter((student) => {
      if (!tokens.length) {
        return true;
      }

      return tokens.every((token) => this.matchesStudentToken(student, token));
    });
    const { items, pagination } = paginateItems(students, options.page, options.pageSize);
    return { students: items, pagination };
  }

  listAdmins(): AdminRosterEntry[] {
    const rows = this.requireDb().prepare(`
      SELECT
        id,
        username,
        name,
        is_super_admin AS isSuperAdmin,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM admins
      ORDER BY is_super_admin DESC, username COLLATE NOCASE
    `).all() as unknown as AdminRowRecord[];

    return rows.map((admin) => this.toAdminRosterEntry(this.toAdminRecord(admin)));
  }

  listAdminsPage(options: { page?: number; pageSize?: number; search?: string }): { admins: AdminRosterEntry[]; pagination: PaginationMeta } {
    const tokens = tokenizeSearch(options.search);
    const admins = this.listAdmins().filter((admin) => {
      if (!tokens.length) {
        return true;
      }

      return tokens.every((token) => this.matchesAdminToken(admin, token));
    });
    const { items, pagination } = paginateItems(admins, options.page, options.pageSize);
    return { admins: items, pagination };
  }

  async loginAdminWithGoogle(name: string, email: string, superAdminEmail: string): Promise<{ token: string; user: AuthenticatedAdmin }> {
    const normalizedEmail = normalizeGoogleEmail(email);
    const normalizedSuperAdminEmail = normalizeGoogleEmail(superAdminEmail);
    const emailError = validateGoogleEmail(normalizedEmail);
    if (emailError) {
      throw new Error(emailError);
    }

    const normalizedName = name.trim() || normalizedEmail;
    let admin = this.findAdminByUsername(normalizedEmail);

    if (!admin) {
      if (normalizedEmail !== normalizedSuperAdminEmail && this.getAdminCount() > 0) {
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

      withTransaction(this.requireDb(), () => {
        this.insertAdmin(admin as AdminRecord);
      });
    }

    if (normalizedEmail === normalizedSuperAdminEmail && !admin.isSuperAdmin) {
      const promotedAdmin: AdminRecord = {
        ...admin,
        name: admin.name || normalizedName,
        isSuperAdmin: true,
        passwordHash: null,
        passwordSalt: null,
        updatedAt: nowIso()
      };

      withTransaction(this.requireDb(), () => {
        this.upsertAdmin(promotedAdmin);
      });

      admin = promotedAdmin;
    }

    const token = withTransaction(this.requireDb(), () => this.createSession(admin.id, "admin").token);
    return {
      token,
      user: this.toAuthenticatedAdmin(admin)
    };
  }

  async loginStudentWithGoogle(email: string): Promise<{ token: string; user: AuthenticatedStudent }> {
    const normalizedEmail = normalizeGoogleEmail(email);
    const emailError = validateGoogleEmail(normalizedEmail);
    if (emailError) {
      throw new Error(emailError);
    }

    const student = this.findStudentByRegisterNumber(normalizedEmail);
    if (!student) {
      throw new Error("This Google account is not authorized. Contact SkillSpark administrator.");
    }

    this.assertStudentHasActiveAccess(student);

    const token = withTransaction(this.requireDb(), () => this.createSession(student.id, "student").token);
    return {
      token,
      user: this.toAuthenticatedStudent(student)
    };
  }

  async createStudent(email: string, name: string, accessDays: number): Promise<StudentRosterEntry> {
    const normalizedRegisterNumber = normalizeGoogleEmail(email);
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

    if (this.findStudentByRegisterNumber(normalizedRegisterNumber)) {
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

    withTransaction(this.requireDb(), () => {
      this.insertStudent(student);
    });

    return this.listStudents().find((entry) => entry.id === student.id) as StudentRosterEntry;
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

    const existing = this.findAdminByUsername(normalizedUsername);
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

    withTransaction(this.requireDb(), () => {
      this.insertAdmin(admin);
    });

    return this.toAdminRosterEntry(admin);
  }

  async importStudents(importedStudents: ImportedStudent[]): Promise<StudentImportResponse> {
    const { students: normalizedStudents, skippedDuplicates } = normalizeImportedStudents(importedStudents);
    let created = 0;
    let skipped = skippedDuplicates;

    withTransaction(this.requireDb(), () => {
      for (const importedStudent of normalizedStudents) {
        const existing = this.findStudentByRegisterNumber(importedStudent.registerNumber);

        if (existing) {
          skipped += 1;
          continue;
        }

        const timestamp = nowIso();
        const accessWindow = buildStudentAccessWindow(importedStudent.accessDays);
        this.insertStudent({
          id: randomUUID(),
          registerNumber: importedStudent.registerNumber,
          name: importedStudent.name,
          registeredName: null,
          passwordHash: null,
          passwordSalt: null,
          accessStartsAt: accessWindow.accessStartsAt,
          accessExpiresAt: accessWindow.accessExpiresAt,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        created += 1;
      }
    });

    return {
      created,
      skipped,
      totalStudents: this.getStudentCount()
    };
  }

  async deleteStudent(studentId: string): Promise<void> {
    const student = this.findStudentById(studentId);

    if (!student) {
      throw new Error("Student not found.");
    }

    withTransaction(this.requireDb(), () => {
      this.closeSessionActivitiesForUsers("student", [studentId]);
      this.requireDb().prepare(`
        DELETE FROM sessions
        WHERE role = 'student' AND user_id = ?
      `).run(studentId);
      this.requireDb().prepare("DELETE FROM students WHERE id = ?").run(studentId);
    });
  }

  async deleteStudents(studentIds: string[]): Promise<number> {
    const ids = [...new Set(studentIds)].filter((studentId) => this.findStudentById(studentId));
    if (ids.length === 0) {
      return 0;
    }

    const placeholders = ids.map(() => "?").join(", ");
    withTransaction(this.requireDb(), () => {
      this.closeSessionActivitiesForUsers("student", ids);
      this.requireDb().prepare(`
        DELETE FROM sessions
        WHERE role = 'student' AND user_id IN (${placeholders})
      `).run(...ids);
      this.requireDb().prepare(`DELETE FROM students WHERE id IN (${placeholders})`).run(...ids);
    });

    return ids.length;
  }
  async deleteAllStudents(): Promise<number> {
    const totalStudents = this.getStudentCount();
    if (totalStudents === 0) {
      return 0;
    }

    withTransaction(this.requireDb(), () => {
      this.closeSessionActivitiesForRole("student");
      this.requireDb().prepare(`
        DELETE FROM sessions
        WHERE role = 'student'
      `).run();
      this.requireDb().prepare("DELETE FROM students").run();
    });

    return totalStudents;
  }

  async updateStudent(studentId: string, payload: UpdateStudentRequest): Promise<StudentRosterEntry> {
    const student = this.findStudentById(studentId);

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

    const duplicate = this.findStudentByRegisterNumber(normalizedRegisterNumber);
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

    withTransaction(this.requireDb(), () => {
      this.upsertStudent(updatedStudent);
    });

    return this.listStudents().find((entry) => entry.id === updatedStudent.id) as StudentRosterEntry;
  }

  async deleteAdmin(adminId: string, actingAdminId: string): Promise<void> {
    const admin = this.findAdminById(adminId);

    if (!admin) {
      throw new Error("Admin not found.");
    }

    if (admin.id === actingAdminId) {
      throw new Error("You cannot remove your own admin account.");
    }

    if (this.getAdminCount() <= 1) {
      throw new Error("At least one admin account must remain.");
    }

    if (admin.isSuperAdmin && this.getSuperAdminCount() <= 1) {
      throw new Error("At least one super admin account must remain.");
    }

    withTransaction(this.requireDb(), () => {
      this.closeSessionActivitiesForUsers("admin", [adminId]);
      this.requireDb().prepare(`
        DELETE FROM sessions
        WHERE role = 'admin' AND user_id = ?
      `).run(adminId);
      this.requireDb().prepare("DELETE FROM admins WHERE id = ?").run(adminId);
    });
  }

  async deleteAdmins(adminIds: string[], actingAdminId: string): Promise<number> {
    const ids = [...new Set(adminIds)].filter((adminId) => adminId !== actingAdminId && this.findAdminById(adminId));
    let deleted = 0;

    for (const adminId of ids) {
      await this.deleteAdmin(adminId, actingAdminId);
      deleted += 1;
    }

    return deleted;
  }

  async updateAdmin(adminId: string, payload: UpdateAdminRequest): Promise<AdminRosterEntry> {
    const admin = this.findAdminById(adminId);

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

    const duplicate = this.findAdminByUsername(normalizedUsername);
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

    withTransaction(this.requireDb(), () => {
      this.upsertAdmin(updatedAdmin);
    });

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

    withTransaction(this.requireDb(), () => {
      this.requireDb().prepare("DELETE FROM quiz_sessions WHERE student_id = ?").run(studentId);
      this.insertQuizSession(quizSession);
    });

    return {
      quizId: quizSession.id,
      expiresAt: quizSession.expiresAt,
      timeLimitMinutes
    };
  }

  getQuizSubmissionState(studentId: string, quizId: string): QuizSubmissionState {
    this.pruneExpired();

    const existingAttempt = this.findAttemptByQuiz(studentId, quizId);
    if (existingAttempt) {
      return {
        status: "completed",
        attempt: this.toAttemptDetail(existingAttempt)
      };
    }

    const quizSession = this.findQuizSession(studentId, quizId);
    if (!quizSession) {
      throw new Error("Quiz session not found or expired.");
    }

    return {
      status: "active",
      quizSession
    };
  }

  async completeQuizSession(studentId: string, results: AttemptResultsPayload, quizId: string): Promise<AttemptDetail> {
    return withTransaction(this.requireDb(), () => {
      const existingAttempt = this.findAttemptByQuiz(studentId, quizId);
      if (existingAttempt) {
        return this.toAttemptDetail(existingAttempt);
      }

      const quizSession = this.findQuizSession(studentId, quizId);
      if (!quizSession) {
        throw new Error("Quiz session not found or expired.");
      }

      this.requireDb().prepare("DELETE FROM quiz_sessions WHERE id = ?").run(quizId);

      const score = results.correctQuestions;
      const attempt: AttemptRecord = {
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

      this.insertAttempt(attempt);
      return this.toAttemptDetail(attempt);
    });
  }

  getPastScores(studentId: string): AttemptSummary[] {
    const rows = this.requireDb().prepare(`
      SELECT
        id,
        quiz_id AS quizId,
        student_id AS studentId,
        level,
        score,
        total_questions AS totalQuestions,
        percentage,
        performance_label AS performanceLabel,
        completed_at AS completedAt,
        results_json AS resultsJson
      FROM attempts
      WHERE student_id = ?
      ORDER BY completed_at DESC
    `).all(studentId) as unknown as AttemptRowRecord[];

    return rows.map((row) => toAttemptSummary(this.toAttemptRecord(row)));
  }

  getAttemptDetail(studentId: string, attemptId: string): AttemptDetail {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        quiz_id AS quizId,
        student_id AS studentId,
        level,
        score,
        total_questions AS totalQuestions,
        percentage,
        performance_label AS performanceLabel,
        completed_at AS completedAt,
        results_json AS resultsJson
      FROM attempts
      WHERE id = ? AND student_id = ?
      LIMIT 1
    `).get(attemptId, studentId) as AttemptRowRecord | undefined;

    if (!row) {
      throw new Error("Attempt not found.");
    }

    return this.toAttemptDetail(this.toAttemptRecord(row));
  }

  getAdminAssistantContext(query: string): AdminAssistantContext {
    const students = this.listStudents();
    const rankedMatches = this.findStudentsForAssistant(query, students);
    const matchedStudents = rankedMatches
      .slice(0, 12)
      .map((student) => this.buildAssistantStudentSnapshot(student));

    return {
      generatedAt: nowIso(),
      settings: this.getSettings(),
      adminsCount: this.getAdminCount(),
      studentsCount: students.length,
      activeStudentsCount: students.filter((student) => student.accessStatus === "active").length,
      expiredStudentsCount: students.filter((student) => student.accessStatus === "expired").length,
      registeredStudentsCount: students.length,
      pendingRegistrationCount: 0,
      totalAttemptsCount: this.getAttemptCount(),
      studentUsage: this.getUsageSummaryForRole("student"),
      matchedStudents,
      matchedStudentsCount: rankedMatches.length,
      recentAttempts: this.getRecentAttemptsForAssistant(8),
      studentLeaderboards: this.buildAssistantLeaderboards(students),
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
        studentRoster: [
          "Student bulk upload accepts CSV, TXT, or XLSX.",
          "Each row must have name, email, and access days in that order.",
          "For XLSX, the first worksheet is used.",
          "Duplicate student emails inside the same upload are skipped.",
          "Existing student emails already in the system are skipped, and only new unique students are added."
        ],
        questionWorkbook: [
          "Question bulk upload accepts XLSX only.",
          "Supported formats are separate Basic, Medium, Hard sheets, or one sheet with Basic/Medium/Hard marker rows, or one sheet with three separated populated blocks in that order.",
          "Question rows should carry question number, prompt/particulars, answer dropdown/account, debit, and credit values in the existing workbook structure.",
          "Question prompts are globally unique across Basic, Medium, and Hard. Duplicate prompts inside the upload are merged, and only unique questions not already in the bank are added."
        ]
      }
    };
  }

  private isDatabaseEmpty(): boolean {
    return this.getAdminCount() === 0 &&
      this.getStudentCount() === 0 &&
      this.getAttemptCount() === 0 &&
      this.getQuizSessionCount() === 0 &&
      this.getSessionCount() === 0;
  }

  private importLegacyData(data: PlatformData): void {
    withTransaction(this.requireDb(), () => {
      const db = this.requireDb();
      db.exec(`
        DELETE FROM attempts;
        DELETE FROM quiz_sessions;
        DELETE FROM sessions;
        DELETE FROM session_activity;
        DELETE FROM students;
        DELETE FROM admins;
        DELETE FROM platform_meta;
      `);

      this.setMeta("questionsPerQuiz", String(data.settings?.questionsPerQuiz ?? DEFAULT_QUIZ_QUESTION_COUNT));
      this.setMeta("timeLimitMinutes", String(data.settings?.timeLimitMinutes ?? DEFAULT_QUIZ_TIME_LIMIT_MINUTES));

      for (const admin of data.admins ?? []) {
        this.insertAdmin({
          ...admin,
          isSuperAdmin: typeof admin.isSuperAdmin === "boolean" ? admin.isSuperAdmin : false
        });
      }

      for (const student of data.students ?? []) {
        this.insertStudent({
          ...student,
          registeredName: "registeredName" in student && typeof student.registeredName === "string" ? student.registeredName : null,
          accessStartsAt: isValidDateValue(student.accessStartsAt) ? student.accessStartsAt : student.createdAt,
          accessExpiresAt: isValidDateValue(student.accessExpiresAt) ? student.accessExpiresAt : student.createdAt
        });
      }

      for (const session of data.sessions ?? []) {
        this.insertSession(session);
      }

      for (const quizSession of data.quizSessions ?? []) {
        this.insertQuizSession(quizSession);
      }

      for (const attempt of data.attempts ?? []) {
        this.insertAttempt({
          ...attempt,
          quizId: typeof attempt.quizId === "string" && attempt.quizId ? attempt.quizId : attempt.id
        });
      }
    });
  }

  private ensureSettings(): void {
    if (!this.getMeta("questionsPerQuiz")) {
      this.setMeta("questionsPerQuiz", String(DEFAULT_QUIZ_QUESTION_COUNT));
    }

    if (!this.getMeta("timeLimitMinutes")) {
      this.setMeta("timeLimitMinutes", String(DEFAULT_QUIZ_TIME_LIMIT_MINUTES));
    }
  }

  private ensureSuperAdminInvariant(): void {
    if (this.getAdminCount() === 0 || this.getSuperAdminCount() > 0) {
      return;
    }

    const firstAdmin = this.requireDb().prepare(`
      SELECT
        id,
        username,
        name,
        is_super_admin AS isSuperAdmin,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM admins
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as AdminRowRecord | undefined;

    if (!firstAdmin) {
      return;
    }

    this.requireDb().prepare(`
      UPDATE admins
      SET is_super_admin = 1
      WHERE id = ?
    `).run(firstAdmin.id);
  }

  private ensureStudentAccessColumns(): void {
    const columns = this.requireDb().prepare("PRAGMA table_info(students)").all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("registered_name")) {
      this.requireDb().exec("ALTER TABLE students ADD COLUMN registered_name TEXT");
    }

    if (!columnNames.has("access_starts_at")) {
      this.requireDb().exec("ALTER TABLE students ADD COLUMN access_starts_at TEXT");
    }

    if (!columnNames.has("access_expires_at")) {
      this.requireDb().exec("ALTER TABLE students ADD COLUMN access_expires_at TEXT");
    }
  }

  hasActiveStudentAccess(studentOrId: StudentRecord | string): boolean {
    const student = typeof studentOrId === "string" ? this.findStudentById(studentOrId) : studentOrId;
    if (!student) {
      return false;
    }

    return getStudentAccessSnapshot(student).accessStatus === "active";
  }

  private assertStudentHasActiveAccess(student: StudentRecord): void {
    if (!this.hasActiveStudentAccess(student)) {
      throw new Error("Student access has expired. Contact the admin.");
    }
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

  private pruneExpired(): void {
    const now = Date.now();
    const quizCutoff = new Date(now - 1000 * 60 * 60 * 24).toISOString();
    const sessionCutoff = new Date(now).toISOString();

    withTransaction(this.requireDb(), () => {
      this.closeExpiredSessionActivities(sessionCutoff);
      this.requireDb().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(sessionCutoff);
      this.requireDb().prepare("DELETE FROM quiz_sessions WHERE expires_at <= ?").run(quizCutoff);
    });
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

  private findAdminById(adminId: string): AdminRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        username,
        name,
        is_super_admin AS isSuperAdmin,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM admins
      WHERE id = ?
      LIMIT 1
    `).get(adminId) as AdminRowRecord | undefined;

    return row ? this.toAdminRecord(row) : null;
  }

  private findAdminByUsername(username: string): AdminRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        username,
        name,
        is_super_admin AS isSuperAdmin,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM admins
      WHERE username = ?
      LIMIT 1
    `).get(username) as AdminRowRecord | undefined;

    return row ? this.toAdminRecord(row) : null;
  }

  private findStudentById(studentId: string): StudentRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        register_number AS registerNumber,
        name,
        registered_name AS registeredName,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        access_starts_at AS accessStartsAt,
        access_expires_at AS accessExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM students
      WHERE id = ?
      LIMIT 1
    `).get(studentId) as StudentRowRecord | undefined;

    return row ? this.toStudentRecord(row) : null;
  }

  private findStudentByRegisterNumber(registerNumber: string): StudentRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        register_number AS registerNumber,
        name,
        registered_name AS registeredName,
        password_hash AS passwordHash,
        password_salt AS passwordSalt,
        access_starts_at AS accessStartsAt,
        access_expires_at AS accessExpiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM students
      WHERE register_number = ?
      LIMIT 1
    `).get(registerNumber) as StudentRowRecord | undefined;

    return row ? this.toStudentRecord(row) : null;
  }

  private findQuizSession(studentId: string, quizId: string): QuizSessionRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        student_id AS studentId,
        level,
        question_ids_json AS questionIdsJson,
        created_at AS createdAt,
        expires_at AS expiresAt
      FROM quiz_sessions
      WHERE id = ? AND student_id = ?
      LIMIT 1
    `).get(quizId, studentId) as QuizSessionRowRecord | undefined;

    return row ? this.toQuizSessionRecord(row) : null;
  }

  private findAttemptByQuiz(studentId: string, quizId: string): AttemptRecord | null {
    const row = this.requireDb().prepare(`
      SELECT
        id,
        quiz_id AS quizId,
        student_id AS studentId,
        level,
        score,
        total_questions AS totalQuestions,
        percentage,
        performance_label AS performanceLabel,
        completed_at AS completedAt,
        results_json AS resultsJson
      FROM attempts
      WHERE quiz_id = ? AND student_id = ?
      LIMIT 1
    `).get(quizId, studentId) as AttemptRowRecord | undefined;

    return row ? this.toAttemptRecord(row) : null;
  }

  private insertAdmin(admin: AdminRecord): void {
    this.requireDb().prepare(`
      INSERT INTO admins (
        id,
        username,
        name,
        is_super_admin,
        password_hash,
        password_salt,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      admin.id,
      admin.username,
      admin.name,
      admin.isSuperAdmin ? 1 : 0,
      admin.passwordHash,
      admin.passwordSalt,
      admin.createdAt,
      admin.updatedAt
    );
  }

  private upsertAdmin(admin: AdminRecord): void {
    this.requireDb().prepare(`
      INSERT INTO admins (
        id,
        username,
        name,
        is_super_admin,
        password_hash,
        password_salt,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        name = excluded.name,
        is_super_admin = excluded.is_super_admin,
        password_hash = excluded.password_hash,
        password_salt = excluded.password_salt,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      admin.id,
      admin.username,
      admin.name,
      admin.isSuperAdmin ? 1 : 0,
      admin.passwordHash,
      admin.passwordSalt,
      admin.createdAt,
      admin.updatedAt
    );
  }

  private insertStudent(student: StudentRecord): void {
    this.requireDb().prepare(`
      INSERT INTO students (
        id,
        register_number,
        name,
        registered_name,
        password_hash,
        password_salt,
        access_starts_at,
        access_expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      student.id,
      student.registerNumber,
      student.name,
      student.registeredName,
      student.passwordHash,
      student.passwordSalt,
      student.accessStartsAt,
      student.accessExpiresAt,
      student.createdAt,
      student.updatedAt
    );
  }

  private upsertStudent(student: StudentRecord): void {
    this.requireDb().prepare(`
      INSERT INTO students (
        id,
        register_number,
        name,
        registered_name,
        password_hash,
        password_salt,
        access_starts_at,
        access_expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        register_number = excluded.register_number,
        name = excluded.name,
        registered_name = excluded.registered_name,
        password_hash = excluded.password_hash,
        password_salt = excluded.password_salt,
        access_starts_at = excluded.access_starts_at,
        access_expires_at = excluded.access_expires_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      student.id,
      student.registerNumber,
      student.name,
      student.registeredName,
      student.passwordHash,
      student.passwordSalt,
      student.accessStartsAt,
      student.accessExpiresAt,
      student.createdAt,
      student.updatedAt
    );
  }

  private insertSession(session: SessionRecord): void {
    this.requireDb().prepare(`
      INSERT INTO sessions (id, token_hash, user_id, role, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.tokenHash,
      session.userId,
      session.role,
      session.createdAt,
      session.expiresAt
    );
  }

  private insertSessionActivity(activity: SessionActivityRowRecord): void {
    this.requireDb().prepare(`
      INSERT INTO session_activity (
        session_id,
        user_id,
        role,
        started_at,
        last_seen_at,
        ended_at,
        request_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      activity.sessionId,
      activity.userId,
      activity.role,
      activity.startedAt,
      activity.lastSeenAt,
      activity.endedAt,
      activity.requestCount
    );
  }

  private insertQuizSession(session: QuizSessionRecord): void {
    this.requireDb().prepare(`
      INSERT INTO quiz_sessions (id, student_id, level, question_ids_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.studentId,
      session.level,
      JSON.stringify(session.questionIds),
      session.createdAt,
      session.expiresAt
    );
  }

  private insertAttempt(attempt: AttemptRecord): void {
    this.requireDb().prepare(`
      INSERT INTO attempts (
        id,
        quiz_id,
        student_id,
        level,
        score,
        total_questions,
        percentage,
        performance_label,
        completed_at,
        results_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.quizId,
      attempt.studentId,
      attempt.level,
      attempt.score,
      attempt.totalQuestions,
      attempt.percentage,
      attempt.performanceLabel,
      attempt.completedAt,
      JSON.stringify(attempt.results)
    );
  }

  private createSession(userId: string, role: "admin" | "student"): { token: string } {
    const { token, tokenHash } = createSessionToken();
    const createdAt = nowIso();
    const sessionId = randomUUID();
    this.insertSession({
      id: sessionId,
      tokenHash,
      userId,
      role,
      createdAt,
      expiresAt: new Date(Date.now() + getSessionMaxAgeSeconds() * 1000).toISOString()
    });
    this.insertSessionActivity({
      sessionId,
      userId,
      role,
      startedAt: createdAt,
      lastSeenAt: createdAt,
      endedAt: null,
      requestCount: 1
    });

    return { token };
  }

  private touchSessionActivity(sessionId: string): void {
    const now = Date.now();
    const previousTouch = this.sessionActivityTouchTimes.get(sessionId);
    if (previousTouch && now - previousTouch < SESSION_ACTIVITY_TOUCH_WINDOW_MS) {
      return;
    }

    this.sessionActivityTouchTimes.set(sessionId, now);
    this.requireDb().prepare(`
      UPDATE session_activity
      SET last_seen_at = ?, request_count = request_count + 1
      WHERE session_id = ?
    `).run(new Date(now).toISOString(), sessionId);
  }

  private closeSessionActivityNow(sessionId: string): void {
    this.sessionActivityTouchTimes.delete(sessionId);
    const timestamp = nowIso();
    this.requireDb().prepare(`
      UPDATE session_activity
      SET ended_at = COALESCE(ended_at, ?),
          last_seen_at = CASE
            WHEN last_seen_at < ? THEN ?
            ELSE last_seen_at
          END
      WHERE session_id = ?
    `).run(timestamp, timestamp, timestamp, sessionId);
  }

  private closeExpiredSessionActivities(cutoff: string): void {
    const expiredSessions = this.requireDb().prepare(`
      SELECT id
      FROM sessions
      WHERE expires_at <= ?
    `).all(cutoff) as Array<{ id: string }>;

    for (const session of expiredSessions) {
      this.sessionActivityTouchTimes.delete(session.id);
      this.requireDb().prepare(`
        UPDATE session_activity
        SET ended_at = COALESCE(ended_at, last_seen_at)
        WHERE session_id = ?
      `).run(session.id);
    }
  }

  private closeSessionActivitiesForUsers(role: "admin" | "student", userIds: string[]): void {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) {
      return;
    }

    const placeholders = ids.map(() => "?").join(", ");
    const timestamp = nowIso();
    const sessionIds = this.requireDb().prepare(`
      SELECT session_id AS sessionId
      FROM session_activity
      WHERE role = ? AND user_id IN (${placeholders})
    `).all(role, ...ids) as Array<{ sessionId: string }>;
    for (const session of sessionIds) {
      this.sessionActivityTouchTimes.delete(session.sessionId);
    }
    this.requireDb().prepare(`
      UPDATE session_activity
      SET ended_at = COALESCE(ended_at, ?)
      WHERE role = ? AND user_id IN (${placeholders})
    `).run(timestamp, role, ...ids);
  }

  private closeSessionActivitiesForRole(role: "admin" | "student"): void {
    const sessionIds = this.requireDb().prepare(`
      SELECT session_id AS sessionId
      FROM session_activity
      WHERE role = ?
    `).all(role) as Array<{ sessionId: string }>;
    for (const session of sessionIds) {
      this.sessionActivityTouchTimes.delete(session.sessionId);
    }

    this.requireDb().prepare(`
      UPDATE session_activity
      SET ended_at = COALESCE(ended_at, ?)
      WHERE role = ?
    `).run(nowIso(), role);
  }

  private getUsageSummaryForRole(role: "admin" | "student"): AssistantUsageSummary {
    const row = this.requireDb().prepare(`
      SELECT
        CAST(COUNT(*) AS INTEGER) AS sessionCount,
        CAST(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS activeSessionCount,
        CAST(COALESCE(SUM(request_count), 0) AS INTEGER) AS totalRequests,
        CAST(ROUND(COALESCE(SUM(
          CASE
            WHEN ended_at IS NOT NULL AND julianday(ended_at) > julianday(started_at)
              THEN (julianday(ended_at) - julianday(started_at)) * 24 * 60
            WHEN ended_at IS NULL AND julianday(last_seen_at) > julianday(started_at)
              THEN (julianday(last_seen_at) - julianday(started_at)) * 24 * 60
            ELSE 0
          END
        ), 0)) AS INTEGER) AS totalTrackedMinutes,
        MAX(last_seen_at) AS lastSeenAt
      FROM session_activity
      WHERE role = ?
    `).get(role) as AssistantUsageSummaryRowRecord | undefined;

    return {
      sessionCount: Number(row?.sessionCount ?? 0),
      activeSessionCount: Number(row?.activeSessionCount ?? 0),
      totalRequests: Number(row?.totalRequests ?? 0),
      totalTrackedMinutes: Number(row?.totalTrackedMinutes ?? 0),
      lastSeenAt: row?.lastSeenAt ?? null
    };
  }

  private getUsageSummaryForUser(role: "admin" | "student", userId: string): AssistantUsageSummary {
    const row = this.requireDb().prepare(`
      SELECT
        CAST(COUNT(*) AS INTEGER) AS sessionCount,
        CAST(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS INTEGER) AS activeSessionCount,
        CAST(COALESCE(SUM(request_count), 0) AS INTEGER) AS totalRequests,
        CAST(ROUND(COALESCE(SUM(
          CASE
            WHEN ended_at IS NOT NULL AND julianday(ended_at) > julianday(started_at)
              THEN (julianday(ended_at) - julianday(started_at)) * 24 * 60
            WHEN ended_at IS NULL AND julianday(last_seen_at) > julianday(started_at)
              THEN (julianday(last_seen_at) - julianday(started_at)) * 24 * 60
            ELSE 0
          END
        ), 0)) AS INTEGER) AS totalTrackedMinutes,
        MAX(last_seen_at) AS lastSeenAt
      FROM session_activity
      WHERE role = ? AND user_id = ?
    `).get(role, userId) as AssistantUsageSummaryRowRecord | undefined;

    return {
      sessionCount: Number(row?.sessionCount ?? 0),
      activeSessionCount: Number(row?.activeSessionCount ?? 0),
      totalRequests: Number(row?.totalRequests ?? 0),
      totalTrackedMinutes: Number(row?.totalTrackedMinutes ?? 0),
      lastSeenAt: row?.lastSeenAt ?? null
    };
  }

  private getRecentAttemptsForAssistant(limit: number): AssistantRecentAttempt[] {
    const rows = this.requireDb().prepare(`
      SELECT
        a.id,
        a.student_id AS studentId,
        s.register_number AS email,
        s.name AS name,
        a.level,
        a.score,
        a.total_questions AS totalQuestions,
        a.percentage,
        a.performance_label AS performanceLabel,
        a.completed_at AS completedAt
      FROM attempts a
      INNER JOIN students s ON s.id = a.student_id
      ORDER BY a.completed_at DESC
      LIMIT ?
    `).all(limit) as AssistantRecentAttemptRowRecord[];

    return rows.map((row) => ({
      attemptId: row.id,
      studentId: row.studentId,
      email: row.email,
      name: row.name,
      level: row.level as Level,
      score: Number(row.score),
      totalQuestions: Number(row.totalQuestions),
      percentage: Number(row.percentage),
      performanceLabel: row.performanceLabel as PerformanceLabel,
      completedAt: row.completedAt
    }));
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

  private buildAssistantStudentSnapshot(student: StudentRosterEntry): AssistantStudentSnapshot {
    const scores = this.getPastScores(student.id);
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
      usage: this.getUsageSummaryForUser("student", student.id)
    };
  }

  private buildAssistantLeaderboards(students: StudentRosterEntry[]): AdminAssistantContext["studentLeaderboards"] {
    const rows = students.map((student) => {
      const scores = this.getPastScores(student.id);
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

    const byAverage = [...rows]
      .filter((row) => row.averagePercentage !== null)
      .sort((left, right) =>
        (right.averagePercentage ?? -1) - (left.averagePercentage ?? -1) ||
        left.attemptsCount - right.attemptsCount ||
        (new Date(right.lastCompletedAt ?? 0).getTime() - new Date(left.lastCompletedAt ?? 0).getTime())
      )
      .slice(0, 8);

    const byEfficiency = [...rows]
      .filter((row) => row.bestPercentage !== null)
      .sort((left, right) =>
        (right.bestPercentage ?? -1) - (left.bestPercentage ?? -1) ||
        left.attemptsCount - right.attemptsCount ||
        (right.latestPercentage ?? -1) - (left.latestPercentage ?? -1)
      )
      .slice(0, 8);

    const lowPerformers = [...rows]
      .filter((row) => row.latestPercentage !== null || row.averagePercentage !== null)
      .sort((left, right) =>
        (left.latestPercentage ?? left.averagePercentage ?? Number.POSITIVE_INFINITY) -
          (right.latestPercentage ?? right.averagePercentage ?? Number.POSITIVE_INFINITY) ||
        right.attemptsCount - left.attemptsCount
      )
      .slice(0, 8);

    const expiredAccess = rows
      .filter((row) => row.accessStatus === "expired")
      .sort((left, right) =>
        left.remainingAccessDays - right.remainingAccessDays ||
        right.attemptsCount - left.attemptsCount
      )
      .slice(0, 8);

    const expiringSoon = rows
      .filter((row) => row.accessStatus === "active")
      .sort((left, right) =>
        left.remainingAccessDays - right.remainingAccessDays ||
        right.attemptsCount - left.attemptsCount
      )
      .slice(0, 8);

    return {
      topByAverage: byAverage,
      topByEfficiency: byEfficiency,
      lowPerformers,
      expiredAccess,
      expiringSoon
    };
  }

  private getAdminCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM admins").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getSuperAdminCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM admins WHERE is_super_admin = 1").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getStudentCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM students").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getSessionCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getQuizSessionCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM quiz_sessions").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getAttemptCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM attempts").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getMeta(key: string): string | null {
    const row = this.requireDb().prepare("SELECT value FROM platform_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.requireDb().prepare(`
      INSERT INTO platform_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  private toAdminRecord(row: AdminRowRecord): AdminRecord {
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      isSuperAdmin: Boolean(row.isSuperAdmin),
      passwordHash: row.passwordHash,
      passwordSalt: row.passwordSalt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private toStudentRecord(row: StudentRowRecord): StudentRecord {
    return {
      id: row.id,
      registerNumber: row.registerNumber,
      name: row.name,
      registeredName: row.registeredName,
      passwordHash: row.passwordHash,
      passwordSalt: row.passwordSalt,
      accessStartsAt: isValidDateValue(row.accessStartsAt) ? row.accessStartsAt : row.createdAt,
      accessExpiresAt: isValidDateValue(row.accessExpiresAt) ? row.accessExpiresAt : row.createdAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  private toQuizSessionRecord(row: QuizSessionRowRecord): QuizSessionRecord {
    return {
      id: row.id,
      studentId: row.studentId,
      level: row.level as Level,
      questionIds: JSON.parse(row.questionIdsJson) as string[],
      createdAt: row.createdAt,
      expiresAt: row.expiresAt
    };
  }

  private toAttemptRecord(row: AttemptRowRecord): AttemptRecord {
    return {
      id: row.id,
      quizId: row.quizId,
      studentId: row.studentId,
      level: row.level as Level,
      score: Number(row.score),
      totalQuestions: Number(row.totalQuestions),
      percentage: Number(row.percentage),
      performanceLabel: row.performanceLabel as PerformanceLabel,
      completedAt: row.completedAt,
      results: JSON.parse(row.resultsJson) as AttemptResultsPayload
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

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error("Platform store has not been initialized.");
    }

    return this.db;
  }
}
