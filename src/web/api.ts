import type {
  AdminAssistantMessage,
  AdminAssistantResponse,
  AdminListResponse,
  AdminDashboardResponse,
  AuthenticatedUser,
  CreateQuestionRequest,
  CreateStudentRequest,
  GoogleAuthRequest,
  AdminQuestionsResponse,
  AdminStudentsResponse,
  AttemptDetail,
  AuthResponse,
  AuthStatusResponse,
  ImportResponse,
  Level,
  Question,
  QuizSettings,
  QuizStartResponse,
  QuizSubmitResponse,
  StudentDashboardResponse,
  StudentImportResponse,
  StudentRosterEntry,
  StudentSubmission,
  UpdateAdminRequest,
  UpdateQuestionRequest,
  UpdateStudentRequest
} from "../shared/types";

type CacheEntry<T> = {
  value?: T;
  promise?: Promise<T>;
  expiresAt: number;
};

type PersistedCacheEnvelope<T> = {
  savedAt: number;
  value: T;
};

const responseCache = new Map<string, CacheEntry<unknown>>();
const DASHBOARD_CACHE_TTL_MS = 30_000;
const ADMIN_LIST_CACHE_TTL_MS = 15_000;
const PERSISTED_DASHBOARD_TTL_MS = 15 * 60_000;
const STUDENT_DASHBOARD_CACHE_KEY = "student:dashboard";
const ADMIN_DASHBOARD_CACHE_KEY = "admin:dashboard";
const PERSISTED_CACHE_PREFIX = "jet-response-cache:v1:";

function invalidateCacheEntry(cacheKey: string) {
  responseCache.delete(cacheKey);
  clearPersistedCache(cacheKey);
}

function invalidateCachePrefix(prefix: string) {
  for (const key of responseCache.keys()) {
    if (key.startsWith(prefix)) {
      responseCache.delete(key);
    }
  }
}

function peekCachedValue<T>(cacheKey: string): T | null {
  const entry = responseCache.get(cacheKey) as CacheEntry<T> | undefined;
  if (!entry || entry.value === undefined || entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.value;
}

function getPersistedCacheStorageKey(cacheKey: string): string {
  return `${PERSISTED_CACHE_PREFIX}${cacheKey}`;
}

function readPersistedCacheValue<T>(cacheKey: string, ttlMs: number): T | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.sessionStorage.getItem(getPersistedCacheStorageKey(cacheKey));
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<PersistedCacheEnvelope<T>>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.savedAt !== "number" || !("value" in parsed)) {
      window.sessionStorage.removeItem(getPersistedCacheStorageKey(cacheKey));
      return null;
    }

    if (Date.now() - parsed.savedAt > ttlMs) {
      window.sessionStorage.removeItem(getPersistedCacheStorageKey(cacheKey));
      return null;
    }

    return parsed.value as T;
  } catch {
    return null;
  }
}

function writePersistedCacheValue<T>(cacheKey: string, value: T): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload: PersistedCacheEnvelope<T> = {
      savedAt: Date.now(),
      value
    };
    window.sessionStorage.setItem(getPersistedCacheStorageKey(cacheKey), JSON.stringify(payload));
  } catch {
    // Ignore storage quota and private browsing errors.
  }
}

function clearPersistedCache(cacheKey: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(getPersistedCacheStorageKey(cacheKey));
  } catch {
    // Ignore storage access errors.
  }
}

async function requestCachedJson<T>(
  cacheKey: string,
  loader: () => Promise<T>,
  ttlMs: number
): Promise<T> {
  const now = Date.now();
  const existing = responseCache.get(cacheKey) as CacheEntry<T> | undefined;
  if (existing?.value !== undefined && existing.expiresAt > now) {
    return existing.value;
  }

  if (existing?.promise) {
    return existing.promise;
  }

  const promise = loader()
    .then((value) => {
      responseCache.set(cacheKey, {
        value,
        expiresAt: Date.now() + ttlMs
      });
      return value;
    })
    .catch((error) => {
      responseCache.delete(cacheKey);
      throw error;
    });

  responseCache.set(cacheKey, {
    promise,
    expiresAt: now + ttlMs
  });

  return promise;
}

function adminQuestionsCacheKey(level?: Level, search?: string, page?: number, pageSize?: number) {
  return `admin:questions:${buildAdminListParams({ level, search, page, pageSize })}`;
}

function adminStudentsCacheKey(params: PaginatedAdminQuery = {}) {
  return `admin:students:${buildAdminListParams(params)}`;
}

function adminListCacheKey(params: PaginatedAdminQuery = {}) {
  return `admin:admins:${buildAdminListParams(params)}`;
}

function tryParseJson<T>(value: string): T | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  try {
    return JSON.parse(trimmedValue) as T;
  } catch {
    return null;
  }
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const rawBody = await response.text();
  const parsedBody = tryParseJson<T | { message?: string }>(rawBody);

  if (!response.ok) {
    const payload = parsedBody && typeof parsedBody === "object" ? parsedBody : null;
    const messageFromPayload = payload && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : null;
    const message = messageFromPayload || rawBody.trim() || `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (parsedBody !== null) {
    return parsedBody as T;
  }

  if (!rawBody.trim()) {
    throw new Error("Expected a JSON response body but the server returned an empty response.");
  }

  throw new Error("Expected a JSON response body but received invalid JSON.");
}

interface UploadFileOptions {
  onProgress?: (percent: number) => void;
  onUploadComplete?: () => void;
}

export function fetchAuthStatus(init?: RequestInit) {
  return requestJson<AuthStatusResponse>("/api/auth/status", init);
}

export function loginWithGoogle(payload: GoogleAuthRequest) {
  return requestJson<AuthResponse>("/api/auth/google", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export function logout() {
  clearClientDataCache();
  return requestJson<{ success: true }>("/api/auth/logout", {
    method: "POST"
  });
}

export function fetchStudentDashboard() {
  return requestCachedJson(
    STUDENT_DASHBOARD_CACHE_KEY,
    () => requestJson<StudentDashboardResponse>("/api/student/dashboard").then((value) => {
      writePersistedCacheValue(STUDENT_DASHBOARD_CACHE_KEY, value);
      return value;
    }),
    DASHBOARD_CACHE_TTL_MS
  );
}

export function getCachedStudentDashboard() {
  return peekCachedValue<StudentDashboardResponse>(STUDENT_DASHBOARD_CACHE_KEY)
    ?? readPersistedCacheValue<StudentDashboardResponse>(STUDENT_DASHBOARD_CACHE_KEY, PERSISTED_DASHBOARD_TTL_MS);
}

export function startStudentQuiz(level: Level) {
  return requestJson<QuizStartResponse>("/api/student/quiz/start", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ level })
  });
}

export function submitStudentQuiz(quizId: string, submissions: StudentSubmission[]) {
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  return requestJson<QuizSubmitResponse>("/api/student/quiz/submit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ quizId, submissions })
  });
}

export function fetchStudentAttempt(attemptId: string) {
  return requestJson<AttemptDetail>(`/api/student/attempts/${encodeURIComponent(attemptId)}`);
}

export function fetchAdminDashboard() {
  return requestCachedJson(
    ADMIN_DASHBOARD_CACHE_KEY,
    () => requestJson<AdminDashboardResponse>("/api/admin/dashboard").then((value) => {
      writePersistedCacheValue(ADMIN_DASHBOARD_CACHE_KEY, value);
      return value;
    }),
    DASHBOARD_CACHE_TTL_MS
  );
}

export function getCachedAdminDashboard() {
  return peekCachedValue<AdminDashboardResponse>(ADMIN_DASHBOARD_CACHE_KEY)
    ?? readPersistedCacheValue<AdminDashboardResponse>(ADMIN_DASHBOARD_CACHE_KEY, PERSISTED_DASHBOARD_TTL_MS);
}

export function sendAdminAssistantMessage(message: string, history: AdminAssistantMessage[]) {
  return requestJson<AdminAssistantResponse>("/api/admin/assistant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message, history })
  });
}

interface PaginatedAdminQuery {
  page?: number;
  pageSize?: number;
  search?: string;
}

function buildAdminListParams(params: PaginatedAdminQuery & { level?: Level }) {
  const query = new URLSearchParams();

  if (params.level) {
    query.set("level", params.level);
  }

  if (params.search?.trim()) {
    query.set("search", params.search.trim());
  }

  if (params.page && params.page > 0) {
    query.set("page", String(params.page));
  }

  if (params.pageSize && params.pageSize > 0) {
    query.set("pageSize", String(params.pageSize));
  }

  return query.toString();
}

export function fetchAdminList(params: PaginatedAdminQuery = {}) {
  const query = buildAdminListParams(params);
  return requestCachedJson(
    adminListCacheKey(params),
    () => requestJson<AdminListResponse>(`/api/admin/admins${query ? `?${query}` : ""}`),
    ADMIN_LIST_CACHE_TTL_MS
  );
}

export function getCachedAdminList(params: PaginatedAdminQuery = {}) {
  return peekCachedValue<AdminListResponse>(adminListCacheKey(params));
}

export function updateAdminSettings(questionsPerQuiz: number, timeLimitMinutes: number) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  return requestJson<{ settings: QuizSettings }>("/api/admin/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ questionsPerQuiz, timeLimitMinutes })
  });
}

export function fetchAdminQuestions(level?: Level, search?: string, page?: number, pageSize?: number) {
  const query = buildAdminListParams({ level, search, page, pageSize });
  return requestCachedJson(
    adminQuestionsCacheKey(level, search, page, pageSize),
    () => requestJson<AdminQuestionsResponse>(`/api/admin/questions${query ? `?${query}` : ""}`),
    ADMIN_LIST_CACHE_TTL_MS
  );
}

export function getCachedAdminQuestions(level?: Level, search?: string, page?: number, pageSize?: number) {
  return peekCachedValue<AdminQuestionsResponse>(adminQuestionsCacheKey(level, search, page, pageSize));
}

export function updateAdminQuestion(questionId: string, payload: UpdateQuestionRequest) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ question: Question }>(`/api/admin/questions/${encodeURIComponent(questionId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export function createAdminQuestion(payload: CreateQuestionRequest) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ question: Question }>("/api/admin/questions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

function uploadFile<T>(url: string, file: File, options: UploadFileOptions = {}) {
  const formData = new FormData();
  formData.append("file", file);

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "text";

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        return;
      }

      options.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };

    xhr.upload.onload = () => {
      options.onProgress?.(100);
      options.onUploadComplete?.();
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed."));
    };

    xhr.onload = () => {
      const rawResponse = xhr.responseText || "";
      let parsedResponse: { message?: string } | T | null = null;

      if (rawResponse) {
        try {
          parsedResponse = JSON.parse(rawResponse) as T | { message?: string };
        } catch {
          parsedResponse = null;
        }
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        const message = parsedResponse && typeof parsedResponse === "object" && "message" in parsedResponse
          ? parsedResponse.message
          : null;
        reject(new Error(message || rawResponse || `Request failed with status ${xhr.status}`));
        return;
      }

      resolve((parsedResponse ?? {}) as T);
    };

    xhr.send(formData);
  });
}

export function uploadQuestionWorkbook(file: File, options?: UploadFileOptions) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return uploadFile<ImportResponse>("/api/admin/questions/import", file, options);
}

export function uploadStudentRoster(file: File, options?: UploadFileOptions) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return uploadFile<StudentImportResponse>("/api/admin/students/import", file, options);
}

export function createAdminStudent(payload: CreateStudentRequest) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return requestJson<{ student: StudentRosterEntry }>("/api/admin/students", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

export function fetchAdminStudents(params: PaginatedAdminQuery = {}) {
  const query = buildAdminListParams(params);
  return requestCachedJson(
    adminStudentsCacheKey(params),
    () => requestJson<AdminStudentsResponse>(`/api/admin/students${query ? `?${query}` : ""}`),
    ADMIN_LIST_CACHE_TTL_MS
  );
}

export function getCachedAdminStudents(params: PaginatedAdminQuery = {}) {
  return peekCachedValue<AdminStudentsResponse>(adminStudentsCacheKey(params));
}

export function updateAdminStudent(studentId: string, payload: UpdateStudentRequest) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return requestJson<{ student: StudentRosterEntry }>(
    `/api/admin/students/${encodeURIComponent(studentId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
}

export function bulkDeleteAdminStudents(ids: string[]) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return requestJson<{ deleted: number }>("/api/admin/students/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ids })
  });
}

export function clearAllAdminStudents() {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return requestJson<{ deleted: number }>("/api/admin/students/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ all: true })
  });
}

export function createManagedAdmin(name: string, email: string) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:admins:");
  return requestJson<{ admin: { id: string; email: string; name: string; isSuperAdmin: boolean; createdAt: string; updatedAt: string } }>("/api/admin/admins", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, email })
  });
}

export function updateManagedAdmin(adminId: string, payload: UpdateAdminRequest) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:admins:");
  return requestJson<{ admin: { id: string; email: string; name: string; isSuperAdmin: boolean; createdAt: string; updatedAt: string } }>(
    `/api/admin/admins/${encodeURIComponent(adminId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );
}

export function bulkDeleteManagedAdmins(ids: string[]) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:admins:");
  return requestJson<{ deleted: number }>("/api/admin/admins/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ids })
  });
}

export function deleteAdminStudent(studentId: string) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:students:");
  return requestJson<{ success: true }>(`/api/admin/students/${encodeURIComponent(studentId)}`, {
    method: "DELETE"
  });
}

export function deleteManagedAdmin(adminId: string) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:admins:");
  return requestJson<{ success: true }>(`/api/admin/admins/${encodeURIComponent(adminId)}`, {
    method: "DELETE"
  });
}

export function deleteQuestion(questionId: string) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ success: true }>(`/api/admin/questions/${encodeURIComponent(questionId)}`, {
    method: "DELETE"
  });
}

export function bulkDeleteQuestions(ids: string[]) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ deleted: number }>("/api/admin/questions/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ids })
  });
}

export function clearLevel(level: Level) {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ deleted: number }>("/api/admin/questions/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ level })
  });
}

export function clearAllQuestions() {
  invalidateCacheEntry(ADMIN_DASHBOARD_CACHE_KEY);
  invalidateCacheEntry(STUDENT_DASHBOARD_CACHE_KEY);
  invalidateCachePrefix("admin:questions:");
  return requestJson<{ deleted: number }>("/api/admin/questions/bulk-delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ all: true })
  });
}

export function clearClientDataCache() {
  responseCache.clear();
  clearPersistedCache(STUDENT_DASHBOARD_CACHE_KEY);
  clearPersistedCache(ADMIN_DASHBOARD_CACHE_KEY);
}

export function preloadWorkspaceData(user: AuthenticatedUser | null | undefined) {
  if (!user) {
    return Promise.resolve(null);
  }

  if (user.role === "student") {
    return fetchStudentDashboard();
  }

  return fetchAdminDashboard();
}
