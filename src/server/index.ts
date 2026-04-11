import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import formbody from "@fastify/formbody";
import {
  LEVELS,
  type AdminAssistantMessage,
  type CreateQuestionRequest,
  type AuthenticatedAdmin,
  type AuthenticatedStudent,
  type Level,
  type QuizSettings,
  type StudentSubmission
} from "../shared/types";
import { parseStudentRosterFromBuffer } from "./import/student-roster";
import { parseWorkbookFromBuffer } from "./import/workbook";
import { generateAdminAssistantReply } from "./services/admin-assistant";
import { dashboardCache, questionCache, getAllCacheMetrics } from "./services/cache";
import { quizSubmitSemaphore, quizSubmitQueue, dbCircuitBreaker } from "./services/concurrency";
import { getServerRuntimeConfig, type ServerRuntimeConfig } from "./services/env";
import { evaluateSubmissions } from "./services/evaluator";
import { verifyGoogleCredential } from "./services/google-auth";
import { getPerformanceSnapshot, getSlowQueries, logRequestMetrics, markServerStarted } from "./services/logger";
import { buildClearedSessionCookie, buildSessionCookie, parseCookies } from "./services/security";
import { PostgresPlatformStore } from "./storage/platform-store-postgres";
import { PostgresQuestionStore } from "./storage/question-store-postgres";

function isLevel(value: string | undefined): value is Level {
  return !!value && LEVELS.includes(value as Level);
}

function resolveProjectPath(...segments: string[]): string {
  return join(process.cwd(), ...segments);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function getSessionToken(request: FastifyRequest): string | null {
  return parseCookies(request.headers.cookie).jet_session ?? null;
}

async function buildServer(config: ServerRuntimeConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel
    },
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes
  });
  const seedWorkbookPath = resolveProjectPath("Jet questions.xlsx");
  const storageProvider = "postgres" as const;

  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required. Configure a Supabase or Postgres connection string.");
  }

  const questionStore = new PostgresQuestionStore(resolveProjectPath("data", "questions.json"), config.databaseUrl);
  const platformStore = new PostgresPlatformStore(resolveProjectPath("data", "platform.json"), config.databaseUrl);
  await Promise.all([
    questionStore.initialize(seedWorkbookPath),
    platformStore.initialize()
  ]);
  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(compress, {
    global: true,
    threshold: 1024
  });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
    skipOnError: true
  });
  const authRateLimitConfig = {
    config: {
      rateLimit: {
        max: config.authRateLimitMax,
        timeWindow: config.rateLimitWindowMs
      }
    }
  } as const;
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.length === 0 || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    }
  });
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024
    }
  });
  await app.register(formbody);

  // Request timing and structured logging
  app.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { startTime: number }).startTime = Date.now();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startTime = (request as FastifyRequest & { startTime?: number }).startTime;
    if (startTime) {
      logRequestMetrics(app.log, {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Date.now() - startTime
      });
    }
  });

  // Smart cache headers for API responses
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      if (request.method === "GET") {
        // Allow short caching for GET endpoints, revalidate for freshness
        reply.header("Cache-Control", "private, no-cache, must-revalidate");
        reply.header("Vary", "Cookie, Accept-Encoding");
      } else {
        reply.header("Cache-Control", "no-store");
      }
    }

    if (
      request.url.startsWith("/api/") &&
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "OPTIONS"
    ) {
      const origin = request.headers.origin;
      if (origin && config.corsOrigins.length > 0 && !config.corsOrigins.includes(origin)) {
        reply.code(403);
        void reply.send({ message: "Origin not allowed." });
        return;
      }
    }
  });

  app.get("/api/health/live", async () => ({
    status: "live",
    timestamp: new Date().toISOString()
  }));

  app.get("/api/health/ready", async (_request, reply) => {
    try {
      const questionSummary = await questionStore.getSummary();
      const settings = await platformStore.getSettings();

      return {
        status: "ready",
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv,
        appOrigin: config.appOrigin,
        adminSetupRequired: await platformStore.adminSetupRequired(),
        storageProvider,
        database: {
          configured: true,
          active: true
        },
        checks: {
          settingsLoaded: Boolean(settings),
          questionStoreLoaded: questionSummary.totalQuestions >= 0
        }
      };
    } catch (error) {
      reply.code(503);
      return {
        status: "degraded",
        timestamp: new Date().toISOString(),
        message: getErrorMessage(error)
      };
    }
  });

  // Metrics endpoint for monitoring dashboards
  app.get("/api/health/metrics", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;

    return {
      timestamp: new Date().toISOString(),
      performance: getPerformanceSnapshot(),
      caches: getAllCacheMetrics(),
      concurrency: {
        quizSubmitSemaphore: quizSubmitSemaphore.getMetrics(),
        quizSubmitQueue: quizSubmitQueue.getMetrics(),
        circuitBreaker: dbCircuitBreaker.getState()
      },
      slowQueries: getSlowQueries()
    };
  });

  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AuthenticatedAdmin | undefined> => {
    const user = await platformStore.getUserForSession(getSessionToken(request));

    if (!user) {
      reply.code(401);
      void reply.send({ message: "Authentication required." });
      return undefined;
    }

    if (user.role !== "admin") {
      reply.code(403);
      void reply.send({ message: "Admin access required." });
      return undefined;
    }

    return user;
  };

  const requireSuperAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AuthenticatedAdmin | undefined> => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return undefined;
    }

    if (!admin.isSuperAdmin) {
      reply.code(403);
      void reply.send({ message: "Super admin access required." });
      return undefined;
    }

    return admin;
  };

  const requireStudent = async (
    request: FastifyRequest,
    reply: FastifyReply,
    options?: { allowExpiredAccess?: boolean }
  ): Promise<AuthenticatedStudent | undefined> => {
    const user = await platformStore.getUserForSession(getSessionToken(request), {
      requireActiveStudentAccess: false
    });

    if (!user) {
      reply.code(401);
      void reply.send({ message: "Authentication required." });
      return undefined;
    }

    if (user.role !== "student") {
      reply.code(403);
      void reply.send({ message: "Student access required." });
      return undefined;
    }

    if (!options?.allowExpiredAccess && user.accessStatus !== "active") {
      reply.code(403);
      void reply.send({ message: "Student access has expired. Contact the admin." });
      return undefined;
    }

    return user;
  };

  app.get("/api/auth/status", async (request, reply) => {
    const startedAt = Date.now();
    const [user, adminSetupRequired] = await Promise.all([
      platformStore.getUserForSession(getSessionToken(request), { requireActiveStudentAccess: true }),
      platformStore.adminSetupRequired()
    ]);

    reply.header("Server-Timing", `auth-status;dur=${Math.max(0, Date.now() - startedAt)}`);
    return {
      user,
      adminSetupRequired
    };
  });

  app.post("/api/auth/google", authRateLimitConfig, async (request, reply) => {
    const body = request.body as { credential?: string; role?: "admin" | "student" };

    if (!config.googleClientId) {
      reply.code(503);
      return { message: "Google sign-in is not configured. Add GOOGLE_CLIENT_ID on the server." };
    }

    if (!body.credential?.trim()) {
      reply.code(400);
      return { message: "Google credential is required." };
    }

    if (body.role !== "admin" && body.role !== "student") {
      reply.code(400);
      return { message: "A valid login role is required." };
    }

    try {
      const identity = await verifyGoogleCredential(body.credential, config.googleClientId);
      const result = body.role === "admin"
        ? await platformStore.loginAdminWithGoogle(identity.name, identity.email, config.superAdminEmail)
        : await platformStore.loginStudentWithGoogle(identity.email);

      reply.header("Set-Cookie", buildSessionCookie(result.token));
      return {
        user: result.user,
        adminSetupRequired: false
      };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  // Google Identity Services redirect callback
  // When ux_mode is "redirect", Google POSTs the credential here as form-urlencoded
  // Uses path param for role: /api/auth/google/callback/student or /api/auth/google/callback/admin
  app.post("/api/auth/google/callback/:role", async (request, reply) => {
    if (!config.googleClientId) {
      reply.code(503);
      return reply.send({ message: "Google sign-in is not configured." });
    }

    // Parse the credential from the form-encoded body
    // Google sends: credential=<JWT>&g_csrf_token=<token>
    const body = request.body as Record<string, string> | undefined;
    const credential = typeof body === "object" && body !== null
      ? (body.credential ?? "")
      : "";

    if (!credential) {
      reply.code(400);
      return reply.send({ message: "Google credential is missing." });
    }

    // Determine the role from the path parameter
    const { role: roleParam } = request.params as { role: string };
    const role: "admin" | "student" = roleParam === "admin" ? "admin" : "student";
    const redirectPath = role === "admin" ? "/admin/dashboard" : "/student/dashboard";
    const loginPath = role === "admin" ? "/admin/login" : "/student/login";

    try {
      const identity = await verifyGoogleCredential(credential, config.googleClientId);
      const result = role === "admin"
        ? await platformStore.loginAdminWithGoogle(identity.name, identity.email, config.superAdminEmail)
        : await platformStore.loginStudentWithGoogle(identity.email);

      reply.header("Set-Cookie", buildSessionCookie(result.token));
      reply.redirect(redirectPath);
    } catch (error) {
      reply.redirect(`${loginPath}?error=${encodeURIComponent(getErrorMessage(error))}`);
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await platformStore.logout(getSessionToken(request));
    reply.header("Set-Cookie", buildClearedSessionCookie());
    return { success: true };
  });

  app.get("/api/student/dashboard", async (request, reply) => {
    const student = await requireStudent(request, reply);
    if (!student) {
      return;
    }

    const cacheKey = `student-dash:${student.id}`;
    const cached = dashboardCache.get(cacheKey);

    // ETag support for conditional requests
    if (cached && !cached.stale) {
      const etag = dashboardCache.getETag(cacheKey);
      if (etag && request.headers["if-none-match"] === etag) {
        reply.code(304);
        return;
      }
      if (etag) reply.header("ETag", etag);
      return cached.value;
    }

    const result = {
      settings: await platformStore.getSettings(),
      questionSummary: await questionStore.getSummary(),
      student,
      pastScores: await platformStore.getPastScores(student.id)
    };

    dashboardCache.set(cacheKey, result);
    const etag = dashboardCache.getETag(cacheKey);
    if (etag) reply.header("ETag", etag);
    return result;
  });

  app.post("/api/student/quiz/start", async (request, reply) => {
    const student = await requireStudent(request, reply);
    if (!student) {
      return;
    }

    const body = request.body as { level?: string };
    if (!isLevel(body.level)) {
      reply.code(400);
      return { message: "A valid level is required." };
    }

    const settings = await platformStore.getSettings();
    const questions = await questionStore.getRandomStudentQuestions(body.level, settings.questionsPerQuiz);
    const quizSession = await platformStore.createQuizSession(
      student.id,
      body.level,
      questions.map((question) => question.id),
      settings.timeLimitMinutes
    );

    return {
      quizId: quizSession.quizId,
      level: body.level,
      questionCount: questions.length,
      timeLimitMinutes: quizSession.timeLimitMinutes,
      expiresAt: quizSession.expiresAt,
      questions
    };
  });

  app.post("/api/student/quiz/submit", async (request, reply) => {
    const student = await requireStudent(request, reply, { allowExpiredAccess: true });
    if (!student) {
      return;
    }

    const body = request.body as { quizId?: string; submissions?: StudentSubmission[] };
    if (!body.quizId || !Array.isArray(body.submissions)) {
      reply.code(400);
      return { message: "Quiz id and submissions are required." };
    }

    try {
      const submissionState = await platformStore.getQuizSubmissionState(student.id, body.quizId!);
      if (submissionState.status === "completed") {
        return {
          attempt: submissionState.attempt
        };
      }

      const quizSession = submissionState.quizSession;
      const quizExpired = Date.now() > new Date(quizSession.expiresAt).getTime() + 5000;

      if (quizExpired) {
        reply.code(400);
        return { message: "Quiz time expired. Start a new quiz." };
      }

      const questions = await questionStore.getQuestionsByIds(quizSession.questionIds);
      const results = evaluateSubmissions(quizSession.level, questions, body.submissions!);
      const attempt = await platformStore.completeQuizSession(student.id, results, body.quizId!);

      dashboardCache.invalidatePrefix(`student-dash:${student.id}`);

      return {
        attempt
      };
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.includes("temporarily unavailable") || message.includes("capacity")) {
        reply.code(503);
      } else {
        reply.code(400);
      }
      return { message };
    }
  });

  app.get("/api/student/attempts/:id", async (request, reply) => {
    const student = await requireStudent(request, reply);
    if (!student) {
      return;
    }

    try {
      const { id } = request.params as { id: string };
      return await platformStore.getAttemptDetail(student.id, id);
    } catch (error) {
      reply.code(404);
      return { message: getErrorMessage(error) };
    }
  });

  app.get("/api/admin/dashboard", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const cacheKey = "admin-dash";
    const cached = dashboardCache.get(cacheKey);
    if (cached && !cached.stale) {
      const etag = dashboardCache.getETag(cacheKey);
      if (etag && request.headers["if-none-match"] === etag) {
        reply.code(304);
        return;
      }
      if (etag) reply.header("ETag", etag);
      return cached.value;
    }

    const result = {
      settings: await platformStore.getSettings(),
      questionSummary: await questionStore.getSummary(),
      studentsCount: (await platformStore.listStudents()).length,
      adminsCount: (await platformStore.listAdmins()).length
    };

    dashboardCache.set(cacheKey, result);
    const etag = dashboardCache.getETag(cacheKey);
    if (etag) reply.header("ETag", etag);
    return result;
  });

  app.post("/api/admin/assistant", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { message?: string; history?: AdminAssistantMessage[] };
    const message = body.message?.trim() ?? "";
    const history = Array.isArray(body.history)
      ? body.history
          .filter((entry): entry is AdminAssistantMessage => Boolean(entry?.content) && (entry.role === "user" || entry.role === "assistant"))
          .map((entry) => ({ role: entry.role, content: entry.content.trim() }))
          .filter((entry) => entry.content)
      : [];

    if (!message) {
      reply.code(400);
      return { message: "Assistant message is required." };
    }

    try {
      const searchText = [message, ...history.filter((entry) => entry.role === "user").map((entry) => entry.content)].join(" ");
      const assistantContext = await platformStore.getAdminAssistantContext(searchText);
      const replyText = await generateAdminAssistantReply({
        message,
        history,
        context: assistantContext,
        questionSummary: await questionStore.getSummary()
      });

      return { reply: replyText };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as Partial<QuizSettings>;
    const questionsPerQuiz = Number(body.questionsPerQuiz);
    const timeLimitMinutes = Number(body.timeLimitMinutes);

    if (!Number.isInteger(questionsPerQuiz) || questionsPerQuiz < 1 || questionsPerQuiz > 100) {
      reply.code(400);
      return { message: "Question count must be an integer between 1 and 100." };
    }

    if (!Number.isInteger(timeLimitMinutes) || timeLimitMinutes < 1 || timeLimitMinutes > 300) {
      reply.code(400);
      return { message: "Time limit must be an integer between 1 and 300 minutes." };
    }

    await platformStore.updateSettings({ questionsPerQuiz, timeLimitMinutes });
    dashboardCache.clear();
    return { settings: await platformStore.getSettings() };
  });

  app.get("/api/admin/questions", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { level, search, page, pageSize } = request.query as {
      level?: string;
      search?: string;
      page?: string;
      pageSize?: string;
    };

    if (level && !isLevel(level)) {
      reply.code(400);
      return { message: "Invalid level filter." };
    }

    return await questionStore.listQuestions({
      level: level as Level | undefined,
      search,
      page: parsePositiveInteger(page, 1),
      pageSize: parsePositiveInteger(pageSize, 10)
    });
  });

  app.post("/api/admin/questions", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as Partial<CreateQuestionRequest>;

    if (!body.level || !isLevel(body.level)) {
      reply.code(400);
      return { message: "A valid level is required." };
    }

    if (!body.prompt?.trim()) {
      reply.code(400);
      return { message: "Question prompt is required." };
    }

    const answerRows = Array.isArray(body.answerRows)
      ? body.answerRows
          .map((row) => ({
            account: row.account?.trim() ?? "",
            debit: row.debit ?? null,
            credit: row.credit ?? null
          }))
          .filter((row) => row.account || row.debit !== null || row.credit !== null)
      : [];

    if (!answerRows.length) {
      reply.code(400);
      return { message: "Add at least one answer row." };
    }

    if (answerRows.some((row) => !row.account)) {
      reply.code(400);
      return { message: "Each answer row needs an account name." };
    }

    const options = Array.isArray(body.options)
      ? body.options.map((option) => option.trim()).filter(Boolean)
      : [];

    try {
      const question = await questionStore.addQuestion({
        level: body.level,
        sourceQuestionNo: body.sourceQuestionNo?.trim(),
        prompt: body.prompt,
        options,
        answerRows
      });

      return { question };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.patch("/api/admin/questions/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    const body = request.body as Partial<CreateQuestionRequest>;

    if (!body.level || !isLevel(body.level)) {
      reply.code(400);
      return { message: "A valid level is required." };
    }

    if (!body.prompt?.trim()) {
      reply.code(400);
      return { message: "Question prompt is required." };
    }

    const answerRows = Array.isArray(body.answerRows)
      ? body.answerRows
          .map((row) => ({
            account: row.account?.trim() ?? "",
            debit: row.debit ?? null,
            credit: row.credit ?? null
          }))
          .filter((row) => row.account || row.debit !== null || row.credit !== null)
      : [];

    if (!answerRows.length) {
      reply.code(400);
      return { message: "Add at least one answer row." };
    }

    if (answerRows.some((row) => !row.account)) {
      reply.code(400);
      return { message: "Each answer row needs an account name." };
    }

    const options = Array.isArray(body.options)
      ? body.options.map((option) => option.trim()).filter(Boolean)
      : [];

    try {
      const question = await questionStore.updateQuestion(id, {
        level: body.level,
        sourceQuestionNo: body.sourceQuestionNo?.trim(),
        prompt: body.prompt,
        options,
        answerRows
      });

      return { question };
    } catch (error) {
      reply.code(getErrorMessage(error) === "Question not found." ? 404 : 400);
      return { message: getErrorMessage(error) };
    }
  });

  app.post("/api/admin/questions/import", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { message: "Excel file is required." };
    }

    try {
      const parsed = await parseWorkbookFromBuffer(await file.toBuffer());
      const result = await questionStore.importQuestions(parsed.questions);
      dashboardCache.clear();
      questionCache.clear();
      return {
        importedLevels: parsed.importedLevels,
        importedQuestions: result.addedQuestions,
        skippedQuestions: result.skippedQuestions,
        totalQuestions: (await questionStore.getSummary()).totalQuestions
      };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.delete("/api/admin/questions/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    await questionStore.deleteQuestion(id);
    return { success: true };
  });

  app.post("/api/admin/questions/bulk-delete", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { ids?: string[]; level?: string; all?: boolean };

    if (body.all) {
      return { deleted: await questionStore.deleteAllQuestions() };
    }

    if (Array.isArray(body.ids) && body.ids.length > 0) {
      return { deleted: await questionStore.deleteQuestions(body.ids) };
    }

    if (isLevel(body.level)) {
      return { deleted: await questionStore.deleteByLevel(body.level) };
    }

    reply.code(400);
    return { message: "Provide question ids or a level to delete." };
  });

  app.post("/api/admin/students/import", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const file = await request.file();
    if (!file) {
      reply.code(400);
      return { message: "Student roster file is required." };
    }

    try {
      const students = await parseStudentRosterFromBuffer(file.filename ?? "students.csv", await file.toBuffer());
      return await platformStore.importStudents(students);
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.post("/api/admin/students", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { email?: string; name?: string; accessDays?: number };

    try {
      const student = await platformStore.createStudent(
        body.email ?? "",
        body.name ?? "",
        Number(body.accessDays)
      );
      return { student };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.get("/api/admin/students", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { search, page, pageSize } = request.query as { search?: string; page?: string; pageSize?: string };

    return await platformStore.listStudentsPage({
      search,
      page: parsePositiveInteger(page, 1),
      pageSize: parsePositiveInteger(pageSize, 10)
    });
  });

  app.patch("/api/admin/students/:id", async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    const body = request.body as { email?: string; name?: string; accessDaysToAdd?: number };

    try {
      const student = await platformStore.updateStudent(id, {
        email: body.email ?? "",
        name: body.name ?? "",
        accessDaysToAdd: body.accessDaysToAdd === undefined ? undefined : Number(body.accessDaysToAdd)
      });
      return { student };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.post("/api/admin/students/bulk-delete", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { ids?: string[]; all?: boolean };
    if (body.all) {
      return { deleted: await platformStore.deleteAllStudents() };
    }

    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      reply.code(400);
      return { message: "Provide at least one student id to delete." };
    }

    return { deleted: await platformStore.deleteStudents(body.ids) };
  });

  app.delete("/api/admin/students/:id", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    try {
      const { id } = request.params as { id: string };
      await platformStore.deleteStudent(id);
      return { success: true };
    } catch (error) {
      reply.code(404);
      return { message: getErrorMessage(error) };
    }
  });

  app.get("/api/admin/admins", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { search, page, pageSize } = request.query as { search?: string; page?: string; pageSize?: string };

    return await platformStore.listAdminsPage({
      search,
      page: parsePositiveInteger(page, 1),
      pageSize: parsePositiveInteger(pageSize, 10)
    });
  });

  app.post("/api/admin/admins", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { name?: string; email?: string };

    try {
      const createdAdmin = await platformStore.createAdmin(body.name ?? "", body.email ?? "", "");
      return { admin: createdAdmin };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.patch("/api/admin/admins/:id", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; email?: string };

    try {
      const updatedAdmin = await platformStore.updateAdmin(id, {
        name: body.name ?? "",
        email: body.email ?? ""
      });
      return { admin: updatedAdmin };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.post("/api/admin/admins/bulk-delete", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    const body = request.body as { ids?: string[] };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      reply.code(400);
      return { message: "Provide at least one admin id to delete." };
    }

    try {
      return { deleted: await platformStore.deleteAdmins(body.ids, admin.id) };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  app.delete("/api/admin/admins/:id", async (request, reply) => {
    const admin = await requireSuperAdmin(request, reply);
    if (!admin) {
      return;
    }

    try {
      const { id } = request.params as { id: string };
      await platformStore.deleteAdmin(id, admin.id);
      return { success: true };
    } catch (error) {
      reply.code(400);
      return { message: getErrorMessage(error) };
    }
  });

  const builtWebPath = resolveProjectPath("dist", "web");
  if (await pathExists(builtWebPath)) {
    await app.register(fastifyStatic, {
      root: builtWebPath,
      // Long-term caching for hashed assets, no-cache for index.html
      setHeaders(res, filePath) {
        if (filePath.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache, must-revalidate");
        }
      }
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api")) {
      reply.code(404);
      return { message: "Not found." };
    }

    if (await pathExists(builtWebPath)) {
      return reply.sendFile("index.html");
    }

    reply.type("text/plain");
    return "Frontend build not found. Run `npm run dev` for development or `npm run build` before `npm start`.";
  });

  return app;
}

async function start() {
  const config = getServerRuntimeConfig();
  const app = await buildServer(config);
  const port = config.port;
  const host = config.host;
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "Graceful shutdown initiated");

    // Give in-flight requests up to 10s to complete
    const forceTimeout = setTimeout(() => {
      app.log.warn("Force shutdown after timeout");
      process.exit(1);
    }, 10_000);

    try {
      await app.close();
      clearTimeout(forceTimeout);
      app.log.info({ signal }, "Server shut down cleanly");
      process.exit(0);
    } catch (error) {
      clearTimeout(forceTimeout);
      app.log.error({ err: error, signal }, "Failed during shutdown");
      process.exit(1);
    }
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

  // Handle uncaught errors gracefully
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection");
  });

  await app.listen({ port, host });
  markServerStarted();
  app.log.info({ host, port, environment: config.nodeEnv }, "API server running");
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
