import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, scrypt as nodeScrypt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Pool } from "pg";

const scrypt = promisify(nodeScrypt);

const root = process.cwd();
const PORT = Number(process.env.LOAD_PORT ?? 3212);
const USERS = Number(process.env.LOAD_USERS ?? 60);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 15);
const ADMIN_FETCH_SAMPLES = Number(process.env.LOAD_ADMIN_FETCH_SAMPLES ?? 12);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const LEVELS = ["basic", "medium", "hard"];
const RUN_ID = `${Date.now()}${randomBytes(3).toString("hex")}`;
const PREFIX = `lt${RUN_ID}`.toLowerCase();
const REGISTER_PREFIX = PREFIX.toUpperCase();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function loadProjectEnv() {
  const loaded = {};

  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(root, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      if (!key || loaded[key] !== undefined) {
        continue;
      }

      loaded[key] = parseEnvValue(line.slice(separatorIndex + 1));
    }
  }

  return loaded;
}

const envFromFiles = loadProjectEnv();
const DATABASE_URL = process.env.DATABASE_URL ?? envFromFiles.DATABASE_URL ?? "";

assert(DATABASE_URL, "DATABASE_URL is required for the PostgreSQL load test.");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, ratio) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function summarizeTimings(label, durations) {
  const total = durations.reduce((sum, value) => sum + value, 0);
  const avg = durations.length ? total / durations.length : 0;

  return {
    label,
    count: durations.length,
    avgMs: Number(avg.toFixed(1)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(1)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(1)),
    maxMs: Number((durations.length ? Math.max(...durations) : 0).toFixed(1))
  };
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

async function timedPhase(label, items, concurrency, worker) {
  const durations = [];
  const results = await runPool(items, concurrency, async (item, index) => {
    const startedAt = performance.now();
    const result = await worker(item, index);
    durations.push(performance.now() - startedAt);
    return result;
  });

  return {
    results,
    metrics: summarizeTimings(label, durations)
  };
}

async function timedSingle(label, worker) {
  const startedAt = performance.now();
  const result = await worker();
  return {
    result,
    metrics: summarizeTimings(label, [performance.now() - startedAt])
  };
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }

  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }

  return {
    status: response.status,
    text,
    data,
    cookies: getSetCookies(response.headers)
  };
}

async function waitForServer(child) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(`${BASE_URL}/api/health/live`);
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }

    await sleep(300);
  }

  throw new Error("Timed out waiting for the load-test server to start.");
}

function createPool() {
  return new Pool({
    connectionString: DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 20_000
  });
}

async function withTransaction(pool, worker) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await worker(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }

    throw error;
  } finally {
    client.release();
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64);

  return {
    salt,
    hash: Buffer.from(derivedKey).toString("hex")
  };
}

async function createTempAdmin(pool) {
  const password = `${PREFIX}!AdminPass1`;
  const { hash, salt } = await hashPassword(password);
  const admin = {
    id: randomUUID(),
    username: `${PREFIX}_admin`,
    name: `Load Test Admin ${RUN_ID}`,
    password,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await pool.query(
    `INSERT INTO admins (
      id, username, name, is_super_admin, password_hash, password_salt, created_at, updated_at
    ) VALUES ($1::uuid, $2, $3, FALSE, $4, $5, $6::timestamptz, $7::timestamptz)`,
    [admin.id, admin.username, admin.name, hash, salt, admin.createdAt, admin.updatedAt]
  );

  return admin;
}

function buildStudents(count) {
  return Array.from({ length: count }, (_, index) => {
    const studentNumber = index + 1;
    return {
      registerNumber: `${REGISTER_PREFIX}${String(studentNumber).padStart(4, "0")}`,
      name: `Load Student ${studentNumber}`,
      password: `${PREFIX}!${studentNumber}`,
      accessDays: 30
    };
  });
}

function buildRosterCsv(students) {
  return [
    "registerNumber,name,accessDays",
    ...students.map((student) => `${student.registerNumber},${student.name},${student.accessDays}`)
  ].join("\n");
}

async function loginAdmin(admin) {
  const response = await request("/api/auth/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: admin.username,
      password: admin.password
    })
  });

  assert(response.status === 200, `Admin login failed: ${response.text}`);
  const cookie = (response.cookies[0] || "").split(";")[0];
  assert(cookie.startsWith("jet_session="), "Admin session cookie was not returned.");
  return cookie;
}

async function fetchAdminDashboard(cookie) {
  const response = await request("/api/admin/dashboard", { cookie });
  assert(response.status === 200, `Admin dashboard failed: ${response.text}`);
  return response.data;
}

async function seedQuestionsIfNeeded(pool, dashboard) {
  const levelCounts = new Map((dashboard.questionSummary?.levels ?? []).map((entry) => [entry.level, Number(entry.count ?? 0)]));
  const requiredCount = Number(dashboard.settings?.questionsPerQuiz ?? 20);
  const createdQuestionIds = [];

  await withTransaction(pool, async (client) => {
    for (const level of LEVELS) {
      const missing = Math.max(0, requiredCount - (levelCounts.get(level) ?? 0));

      for (let index = 0; index < missing; index += 1) {
        const questionId = `${PREFIX}-${level}-${String(index + 1).padStart(3, "0")}`;
        const rowId = `${questionId}-row-1`;
        const importedAt = new Date().toISOString();
        const sourceQuestionNo = `${PREFIX}-${level}-${index + 1}`;

        await client.query(
          `INSERT INTO questions (id, level, source_question_no, prompt, sheet_name, imported_at)
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
          [questionId, level, sourceQuestionNo, `Load-test ${level} prompt ${index + 1}`, `Load Test ${RUN_ID}`, importedAt]
        );
        await client.query(
          "INSERT INTO question_options (question_id, option_index, option_text) VALUES ($1, $2, $3)",
          [questionId, 0, `Option ${index + 1}`]
        );
        await client.query(
          "INSERT INTO answer_rows (id, question_id, row_index, account, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)",
          [rowId, questionId, 0, `Cash ${index + 1}`, 100 + index, null]
        );

        createdQuestionIds.push(questionId);
      }
    }
  });

  return createdQuestionIds;
}

async function cleanupTempData(pool, tempAdmin, questionIds) {
  await withTransaction(pool, async (client) => {
    const studentRows = await client.query(
      "SELECT id::text AS id FROM students WHERE register_number::text LIKE $1",
      [`${REGISTER_PREFIX}%`]
    );
    const studentIds = studentRows.rows.map((row) => row.id);

    if (studentIds.length > 0) {
      await client.query("DELETE FROM session_activity WHERE role = 'student' AND user_id = ANY($1::uuid[])", [studentIds]);
      await client.query("DELETE FROM sessions WHERE role = 'student' AND user_id = ANY($1::uuid[])", [studentIds]);
      await client.query("DELETE FROM students WHERE id = ANY($1::uuid[])", [studentIds]);
    }

    if (tempAdmin?.id) {
      await client.query("DELETE FROM session_activity WHERE role = 'admin' AND user_id = $1::uuid", [tempAdmin.id]);
      await client.query("DELETE FROM sessions WHERE role = 'admin' AND user_id = $1::uuid", [tempAdmin.id]);
      await client.query("DELETE FROM admins WHERE id = $1::uuid", [tempAdmin.id]);
    }

    if (questionIds.length > 0) {
      await client.query("DELETE FROM questions WHERE id = ANY($1::text[])", [questionIds]);
    }
  });
}

async function main() {
  const pool = createPool();
  const students = buildStudents(USERS);
  let tempAdmin = null;
  let createdQuestionIds = [];
  let serverLog = "";
  let server;

  try {
    tempAdmin = await createTempAdmin(pool);

    server = spawn(process.execPath, ["dist/server/server/index.js"], {
      cwd: root,
      env: {
        ...process.env,
        ...envFromFiles,
        DATABASE_URL,
        HOST: "127.0.0.1",
        PORT: String(PORT)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    server.stdout.on("data", (chunk) => {
      serverLog += chunk.toString();
    });
    server.stderr.on("data", (chunk) => {
      serverLog += chunk.toString();
    });

    await waitForServer(server);

    const adminLogin = await timedSingle("admin-login", async () => loginAdmin(tempAdmin));
    const adminCookie = adminLogin.result;

    const adminDashboard = await timedSingle("admin-dashboard", async () => fetchAdminDashboard(adminCookie));
    createdQuestionIds = await seedQuestionsIfNeeded(pool, adminDashboard.result);

    const apiQuestionCreate = await timedSingle("admin-question-create", async () => {
      const response = await request("/api/admin/questions", {
        method: "POST",
        cookie: adminCookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: "basic",
          sourceQuestionNo: `${PREFIX}-api-basic`,
          prompt: `API load-test prompt ${RUN_ID}`,
          options: ["Cash"],
          answerRows: [{ account: "Cash", debit: 500, credit: null }]
        })
      });

      assert(response.status === 200, `Admin question create failed: ${response.text}`);
      return response.data.question.id;
    });
    createdQuestionIds.push(apiQuestionCreate.result);

    const adminQuestionList = await timedPhase(
      "admin-questions-list",
      Array.from({ length: ADMIN_FETCH_SAMPLES }, (_, index) => index),
      Math.min(4, ADMIN_FETCH_SAMPLES),
      async () => {
        const response = await request(`/api/admin/questions?page=1&pageSize=20&search=${encodeURIComponent(PREFIX)}`, {
          cookie: adminCookie
        });
        assert(response.status === 200, `Admin question list failed: ${response.text}`);
        return response.data;
      }
    );

    const studentImport = await timedSingle("admin-students-import", async () => {
      const form = new FormData();
      form.append("file", new Blob([Buffer.from(buildRosterCsv(students), "utf8")]), "load-roster.csv");
      const response = await request("/api/admin/students/import", {
        method: "POST",
        cookie: adminCookie,
        body: form
      });

      assert(response.status === 200, `Student import failed: ${response.text}`);
      assert(Number(response.data.created) === USERS, `Expected ${USERS} created students, received ${response.data.created}.`);
      return response.data;
    });

    const adminStudentList = await timedPhase(
      "admin-students-list",
      Array.from({ length: ADMIN_FETCH_SAMPLES }, (_, index) => index),
      Math.min(4, ADMIN_FETCH_SAMPLES),
      async () => {
        const response = await request(`/api/admin/students?page=1&pageSize=25&search=${encodeURIComponent(REGISTER_PREFIX)}`, {
          cookie: adminCookie
        });
        assert(response.status === 200, `Admin student list failed: ${response.text}`);
        return response.data;
      }
    );

    const registerPhase = await timedPhase("student-register", students, CONCURRENCY, async (student) => {
      const response = await request("/api/auth/student/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registerNumber: student.registerNumber,
          name: student.name,
          password: student.password
        })
      });

      assert(response.status === 200, `Register failed for ${student.registerNumber}: ${response.text}`);
      return student;
    });

    const loginPhase = await timedPhase("student-login", students, CONCURRENCY, async (student) => {
      const response = await request("/api/auth/student/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          registerNumber: student.registerNumber,
          password: student.password
        })
      });

      assert(response.status === 200, `Login failed for ${student.registerNumber}: ${response.text}`);
      const cookie = (response.cookies[0] || "").split(";")[0];
      assert(cookie.startsWith("jet_session="), `Missing student session cookie for ${student.registerNumber}.`);
      return {
        ...student,
        cookie
      };
    });

    const dashboardPhase = await timedPhase("student-dashboard", loginPhase.results, CONCURRENCY, async (student) => {
      const response = await request("/api/student/dashboard", {
        cookie: student.cookie
      });

      assert(response.status === 200, `Dashboard failed for ${student.registerNumber}: ${response.text}`);
      return student;
    });

    const startPhase = await timedPhase("quiz-start", dashboardPhase.results, CONCURRENCY, async (student, index) => {
      const response = await request("/api/student/quiz/start", {
        method: "POST",
        cookie: student.cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: LEVELS[index % LEVELS.length] })
      });

      assert(response.status === 200, `Quiz start failed for ${student.registerNumber}: ${response.text}`);
      return {
        ...student,
        quizId: response.data.quizId
      };
    });

    const duplicateSubsetCount = Math.min(10, startPhase.results.length);
    const duplicateSubset = startPhase.results.slice(0, duplicateSubsetCount);
    const standardSubset = startPhase.results.slice(duplicateSubsetCount);

    const duplicatePhase = await timedPhase("quiz-submit-duplicate", duplicateSubset, CONCURRENCY, async (student) => {
      const submitPayload = { quizId: student.quizId, submissions: [] };
      const [first, second] = await Promise.all([
        request("/api/student/quiz/submit", {
          method: "POST",
          cookie: student.cookie,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitPayload)
        }),
        request("/api/student/quiz/submit", {
          method: "POST",
          cookie: student.cookie,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitPayload)
        })
      ]);

      assert(first.status === 200, `First duplicate submit failed for ${student.registerNumber}: ${first.text}`);
      assert(second.status === 200, `Second duplicate submit failed for ${student.registerNumber}: ${second.text}`);
      assert(first.data.attempt.attemptId === second.data.attempt.attemptId, `Duplicate submit created multiple attempts for ${student.registerNumber}.`);
      return {
        ...student,
        attemptId: first.data.attempt.attemptId
      };
    });

    const submitPhase = await timedPhase("quiz-submit", standardSubset, CONCURRENCY, async (student) => {
      const response = await request("/api/student/quiz/submit", {
        method: "POST",
        cookie: student.cookie,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quizId: student.quizId,
          submissions: []
        })
      });

      assert(response.status === 200, `Quiz submit failed for ${student.registerNumber}: ${response.text}`);
      return {
        ...student,
        attemptId: response.data.attempt.attemptId
      };
    });

    const submittedStudents = [...duplicatePhase.results, ...submitPhase.results];

    const postSubmitDashboard = await timedPhase("post-submit-dashboard", submittedStudents, CONCURRENCY, async (student) => {
      const response = await request("/api/student/dashboard", {
        cookie: student.cookie
      });

      assert(response.status === 200, `Post-submit dashboard failed for ${student.registerNumber}: ${response.text}`);
      assert(Array.isArray(response.data.pastScores) && response.data.pastScores.length >= 1, `Expected attempts after quiz for ${student.registerNumber}.`);
      return student;
    });

    const attemptDetailPhase = await timedPhase("attempt-detail", submittedStudents, CONCURRENCY, async (student) => {
      const response = await request(`/api/student/attempts/${student.attemptId}`, {
        cookie: student.cookie
      });

      assert(response.status === 200, `Attempt detail failed for ${student.registerNumber}: ${response.text}`);
      return student;
    });

    const adminDashboardPost = await timedPhase(
      "admin-dashboard-post",
      Array.from({ length: ADMIN_FETCH_SAMPLES }, (_, index) => index),
      Math.min(4, ADMIN_FETCH_SAMPLES),
      async () => {
        const response = await request("/api/admin/dashboard", {
          cookie: adminCookie
        });
        assert(response.status === 200, `Admin post dashboard failed: ${response.text}`);
        return response.data;
      }
    );

    const metrics = [
      adminLogin.metrics,
      adminDashboard.metrics,
      apiQuestionCreate.metrics,
      adminQuestionList.metrics,
      studentImport.metrics,
      adminStudentList.metrics,
      registerPhase.metrics,
      loginPhase.metrics,
      dashboardPhase.metrics,
      startPhase.metrics,
      duplicatePhase.metrics,
      submitPhase.metrics,
      postSubmitDashboard.metrics,
      attemptDetailPhase.metrics,
      adminDashboardPost.metrics
    ];

    console.log(JSON.stringify({
      runId: RUN_ID,
      users: USERS,
      concurrency: CONCURRENCY,
      port: PORT,
      database: "postgres",
      seededQuestionCount: createdQuestionIds.length,
      createdStudents: studentImport.result.created,
      metrics
    }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${message}\n\nServer log:\n${serverLog}`);
    process.exitCode = 1;
  } finally {
    if (server) {
      server.kill();
      await sleep(500);
    }

    try {
      await cleanupTempData(pool, tempAdmin, createdQuestionIds);
    } finally {
      await pool.end();
    }
  }
}

await main();
