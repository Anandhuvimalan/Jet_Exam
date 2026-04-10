export const LEVELS = ["basic", "medium", "hard"] as const;
export const MATRIX_ROW_COUNT = 5;
export const DEFAULT_QUIZ_QUESTION_COUNT = 20;
export const DEFAULT_QUIZ_TIME_LIMIT_MINUTES = 30;

export type Level = (typeof LEVELS)[number];
export type UserRole = "admin" | "student";
export type PerformanceLabel = "Poor" | "Good" | "Very Good" | "Excellent";
export type AdminAccessLevel = "admin" | "super_admin";
export type StudentAccessStatus = "active" | "expired";

export interface AnswerRow {
  id: string;
  account: string;
  debit: number | null;
  credit: number | null;
}

export interface Question {
  id: string;
  level: Level;
  sourceQuestionNo: string;
  prompt: string;
  options: string[];
  answerRows: AnswerRow[];
  sheetName: string;
  importedAt: string;
}

export interface AdminAnswerRowInput {
  account: string;
  debit: number | null;
  credit: number | null;
}

export interface CreateQuestionRequest {
  level: Level;
  sourceQuestionNo?: string;
  prompt: string;
  options: string[];
  answerRows: AdminAnswerRowInput[];
}

export interface UpdateQuestionRequest extends CreateQuestionRequest {}

export interface Dataset {
  version: number;
  importedAt: string | null;
  questions: Question[];
}

export interface LevelSummary {
  level: Level;
  count: number;
}

export interface SummaryResponse {
  totalQuestions: number;
  lastImportedAt: string | null;
  levels: LevelSummary[];
}

export interface StudentQuestion {
  id: string;
  level: Level;
  sourceQuestionNo: string;
  prompt: string;
  options: string[];
  answerSlotCount: number;
}

export interface StudentAnswerRow {
  account: string;
  debit: string;
  credit: string;
}

export interface StudentSubmission {
  questionId: string;
  rows: StudentAnswerRow[];
}

export interface EvaluatedStudentRow {
  id: string;
  account: string;
  debit: number | null;
  credit: number | null;
  matched: boolean;
  referenceRowId: string | null;
  accountMatched: boolean;
  debitMatched: boolean;
  creditMatched: boolean;
}

export interface QuestionResult {
  questionId: string;
  sourceQuestionNo: string;
  prompt: string;
  isCorrect: boolean;
  matchedRows: number;
  expectedRows: number;
  studentRows: EvaluatedStudentRow[];
  missingRows: AnswerRow[];
  correctRows: AnswerRow[];
}

export interface EvaluationResponse {
  level: Level;
  totalQuestions: number;
  correctQuestions: number;
  wrongQuestions: number;
  accuracy: number;
  lineAccuracy: number;
  questionResults: QuestionResult[];
}

export interface ImportResponse {
  importedLevels: Level[];
  importedQuestions: number;
  skippedQuestions: number;
  totalQuestions: number;
}

export interface AuthenticatedAdmin {
  id: string;
  role: "admin";
  email: string;
  name: string;
  isSuperAdmin: boolean;
  accessLevel: AdminAccessLevel;
}

export interface AuthenticatedStudent {
  id: string;
  role: "student";
  email: string;
  name: string;
  accessStartsAt: string;
  accessExpiresAt: string;
  accessStatus: StudentAccessStatus;
  remainingAccessDays: number;
}

export type AuthenticatedUser = AuthenticatedAdmin | AuthenticatedStudent;

export interface AuthStatusResponse {
  user: AuthenticatedUser | null;
  adminSetupRequired: boolean;
}

export interface AuthResponse extends AuthStatusResponse {
  user: AuthenticatedUser;
}

export interface StudentRosterEntry {
  id: string;
  name: string;
  email: string;
  attemptsCount: number;
  accessStartsAt: string;
  accessExpiresAt: string;
  accessStatus: StudentAccessStatus;
  remainingAccessDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateStudentRequest {
  name: string;
  email: string;
  accessDays: number;
}

export interface AdminRosterEntry {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateStudentRequest {
  name: string;
  email: string;
  accessDaysToAdd?: number;
}

export interface UpdateAdminRequest {
  name: string;
  email: string;
}

export interface GoogleAuthRequest {
  credential: string;
  role: UserRole;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface QuizSettings {
  questionsPerQuiz: number;
  timeLimitMinutes: number;
}

export interface StudentImportResponse {
  created: number;
  skipped: number;
  totalStudents: number;
}

export interface AttemptSummary {
  id: string;
  level: Level;
  score: number;
  totalQuestions: number;
  percentage: number;
  performanceLabel: PerformanceLabel;
  completedAt: string;
}

export interface AttemptDetail extends EvaluationResponse {
  attemptId: string;
  score: number;
  performanceLabel: PerformanceLabel;
  completedAt: string;
}

export interface StudentDashboardResponse {
  settings: QuizSettings;
  questionSummary: SummaryResponse;
  student: AuthenticatedStudent;
  pastScores: AttemptSummary[];
}

export interface QuizStartResponse {
  quizId: string;
  level: Level;
  questionCount: number;
  timeLimitMinutes: number;
  expiresAt: string;
  questions: StudentQuestion[];
}

export interface QuizSubmitResponse {
  attempt: AttemptDetail;
  pastScores?: AttemptSummary[];
}

export interface AdminDashboardResponse {
  settings: QuizSettings;
  questionSummary: SummaryResponse;
  studentsCount: number;
  adminsCount: number;
}

export interface AdminQuestionsResponse {
  questions: Question[];
  pagination: PaginationMeta;
}

export interface AdminStudentsResponse {
  students: StudentRosterEntry[];
  pagination: PaginationMeta;
}

export interface AdminListResponse {
  admins: AdminRosterEntry[];
  pagination: PaginationMeta;
}

export interface AdminAssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AdminAssistantResponse {
  reply: string;
}
