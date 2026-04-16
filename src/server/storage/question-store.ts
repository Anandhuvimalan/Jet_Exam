import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  MATRIX_ROW_COUNT,
  LEVELS,
  type CreateQuestionRequest,
  type Dataset,
  type Level,
  type PaginationMeta,
  type Question,
  type SummaryResponse,
  type StudentQuestion
} from "../../shared/types";
import { parseWorkbookFromFile } from "../import/workbook";
import { getLegacyJsonPath, openSqliteDatabase, readJsonFile, withTransaction } from "./sqlite";

const EMPTY_DATASET: Dataset = {
  version: 1,
  importedAt: null,
  questions: []
};

interface SearchToken {
  field: string | null;
  value: string;
}

interface QuestionListOptions {
  level?: Level;
  search?: string;
  page?: number;
  pageSize?: number;
}

interface QuestionRowRecord {
  id: string;
  level: string;
  sourceQuestionNo: string;
  prompt: string;
  sheetName: string;
  importedAt: string;
}

interface QuestionOptionRecord {
  questionId: string;
  optionIndex: number;
  optionText: string;
}

interface AnswerRowRecord {
  id: string;
  questionId: string;
  rowIndex: number;
  account: string;
  debit: number | null;
  credit: number | null;
}

type QuestionConflictReason = "prompt" | "sourceQuestionNo";

interface QuestionConflict {
  question: Question;
  reason: QuestionConflictReason;
}

interface QuestionImportConflict {
  importedQuestion: Question;
  existingQuestion: Question;
}

interface QuestionImportSummary {
  addedQuestions: number;
  skippedQuestions: number;
}

function compareQuestionNo(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function normalizeQuestionPrompt(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeQuestionNumber(value: string): string {
  return value.trim().toLowerCase();
}

function formatLevelLabel(level: Level): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function sortQuestions(questions: Question[]): Question[] {
  const levelOrder = new Map<Level, number>(LEVELS.map((level, index) => [level, index]));

  return [...questions].sort((left, right) => {
    if (left.level !== right.level) {
      return (levelOrder.get(left.level) ?? 0) - (levelOrder.get(right.level) ?? 0);
    }

    return compareQuestionNo(left.sourceQuestionNo, right.sourceQuestionNo);
  });
}

function mergeDuplicateQuestions(questions: Question[]): Question[] {
  const merged = new Map<string, Question>();
  const sourceKeyToQuestionId = new Map<string, string>();
  const promptKeyToQuestionId = new Map<string, string>();

  for (const question of questions) {
    const sourceKey = `${question.level}::${normalizeQuestionNumber(question.sourceQuestionNo)}`;
    const promptKeyValue = normalizeQuestionPrompt(question.prompt);
    const promptKey = promptKeyValue || null;
    const existingId = sourceKeyToQuestionId.get(sourceKey) ?? (promptKey ? promptKeyToQuestionId.get(promptKey) : undefined);
    const existing = existingId ? merged.get(existingId) : undefined;

    if (!existing) {
      merged.set(question.id, {
        ...question,
        options: [...question.options],
        answerRows: question.answerRows.filter((row) => row.account || row.debit !== null || row.credit !== null)
      });
      sourceKeyToQuestionId.set(sourceKey, question.id);
      if (promptKey) {
        promptKeyToQuestionId.set(promptKey, question.id);
      }
      continue;
    }

    sourceKeyToQuestionId.set(sourceKey, existing.id);
    if (promptKey) {
      promptKeyToQuestionId.set(promptKey, existing.id);
    }

    if (question.prompt.length > existing.prompt.length) {
      existing.prompt = question.prompt;
    }

    const optionKeys = new Set(existing.options.map((option) => option.toLowerCase()));
    for (const option of question.options) {
      const normalized = option.toLowerCase();
      if (!optionKeys.has(normalized)) {
        optionKeys.add(normalized);
        existing.options.push(option);
      }
    }

    const answerRowKeys = new Set(
      existing.answerRows.map((row) => `${row.account.toLowerCase()}|${row.debit ?? ""}|${row.credit ?? ""}`)
    );
    for (const row of question.answerRows) {
      if (!row.account && row.debit === null && row.credit === null) {
        continue;
      }

      const rowKey = `${row.account.toLowerCase()}|${row.debit ?? ""}|${row.credit ?? ""}`;
      if (!answerRowKeys.has(rowKey)) {
        answerRowKeys.add(rowKey);
        existing.answerRows.push(row);
      }
    }
  }

  return sortQuestions([...merged.values()]);
}

function buildQuestionConflictMessage(conflict: QuestionConflict, level: Level, sourceQuestionNo: string): string {
  if (conflict.reason === "sourceQuestionNo") {
    return `Question number ${sourceQuestionNo} already exists in ${formatLevelLabel(level)} mode.`;
  }

  const conflictLevelLabel = formatLevelLabel(conflict.question.level);
  if (conflict.question.level === level) {
    return `This question already exists in ${conflictLevelLabel} mode.`;
  }

  return `This question already exists in ${conflictLevelLabel} mode. Questions must be unique across all modes.`;
}

function findQuestionImportConflicts(existingQuestions: Question[], importedQuestions: Question[]): QuestionImportConflict[] {
  const existingByPrompt = new Map<string, Question>();
  const conflicts: QuestionImportConflict[] = [];
  const seenConflictKeys = new Set<string>();

  for (const question of existingQuestions) {
    const promptKey = normalizeQuestionPrompt(question.prompt);
    if (promptKey && !existingByPrompt.has(promptKey)) {
      existingByPrompt.set(promptKey, question);
    }
  }

  for (const importedQuestion of importedQuestions) {
    const promptKey = normalizeQuestionPrompt(importedQuestion.prompt);
    if (!promptKey) {
      continue;
    }

    const existingQuestion = existingByPrompt.get(promptKey);
    if (!existingQuestion) {
      continue;
    }

    const conflictKey = `${promptKey}::${existingQuestion.id}`;
    if (seenConflictKeys.has(conflictKey)) {
      continue;
    }

    seenConflictKeys.add(conflictKey);
    conflicts.push({ importedQuestion, existingQuestion });
  }

  return conflicts;
}

function buildQuestionImportConflictMessage(conflicts: QuestionImportConflict[]): string {
  const samples = conflicts
    .slice(0, 3)
    .map(({ importedQuestion, existingQuestion }) =>
      `"${importedQuestion.prompt}" already exists in ${formatLevelLabel(existingQuestion.level)} mode.`
    );

  const remainingCount = conflicts.length - samples.length;
  const suffix = remainingCount > 0 ? ` ${remainingCount} more conflict${remainingCount === 1 ? "" : "s"} found.` : "";

  return `Question prompts must be unique across all modes. This import conflicts with existing questions in untouched levels. ${samples.join(" ")}${suffix}`;
}

function selectImportableQuestions(existingQuestions: Question[], importedQuestions: Question[]): QuestionImportSummary & { questionsToInsert: Question[] } {
  const knownPromptKeys = new Set(existingQuestions.map((question) => normalizeQuestionPrompt(question.prompt)).filter(Boolean));
  const knownSourceKeys = new Set(existingQuestions.map((question) => `${question.level}::${normalizeQuestionNumber(question.sourceQuestionNo)}`));
  const questionsToInsert: Question[] = [];
  let skippedQuestions = 0;

  for (const question of importedQuestions) {
    const promptKey = normalizeQuestionPrompt(question.prompt);
    const sourceKey = `${question.level}::${normalizeQuestionNumber(question.sourceQuestionNo)}`;

    if ((promptKey && knownPromptKeys.has(promptKey)) || knownSourceKeys.has(sourceKey)) {
      skippedQuestions += 1;
      continue;
    }

    questionsToInsert.push(question);
    if (promptKey) {
      knownPromptKeys.add(promptKey);
    }
    knownSourceKeys.add(sourceKey);
  }

  return {
    questionsToInsert,
    addedQuestions: questionsToInsert.length,
    skippedQuestions
  };
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

function questionIncludesValue(question: Question, value: string): boolean {
  const searchableValues = [
    question.level,
    question.sourceQuestionNo,
    question.prompt,
    question.sheetName,
    question.importedAt,
    ...question.options,
    ...question.answerRows.flatMap((row) => [
      row.account,
      row.debit === null ? "" : String(row.debit),
      row.credit === null ? "" : String(row.credit)
    ])
  ];

  return searchableValues.some((entry) => entry.toLowerCase().includes(value));
}

function matchesQuestionToken(question: Question, token: SearchToken): boolean {
  if (!token.field) {
    return questionIncludesValue(question, token.value);
  }

  if (["level"].includes(token.field)) {
    return question.level.toLowerCase().includes(token.value);
  }

  if (["no", "number", "question", "questionno", "source"].includes(token.field)) {
    return question.sourceQuestionNo.toLowerCase().includes(token.value);
  }

  if (["prompt", "text"].includes(token.field)) {
    return question.prompt.toLowerCase().includes(token.value);
  }

  if (["sheet", "import", "imported"].includes(token.field)) {
    return question.sheetName.toLowerCase().includes(token.value) || question.importedAt.toLowerCase().includes(token.value);
  }

  if (["option", "options", "particular", "particulars"].includes(token.field)) {
    return question.options.some((option) => option.toLowerCase().includes(token.value));
  }

  if (["account", "row"].includes(token.field)) {
    return question.answerRows.some((row) => row.account.toLowerCase().includes(token.value));
  }

  if (["debit"].includes(token.field)) {
    return question.answerRows.some((row) => String(row.debit ?? "").toLowerCase().includes(token.value));
  }

  if (["credit"].includes(token.field)) {
    return question.answerRows.some((row) => String(row.credit ?? "").toLowerCase().includes(token.value));
  }

  if (["amount"].includes(token.field)) {
    return question.answerRows.some((row) =>
      [row.debit, row.credit].some((amount) => String(amount ?? "").toLowerCase().includes(token.value))
    );
  }

  return questionIncludesValue(question, token.value);
}

export class QuestionStore {
  private db: Database.Database | null = null;
  private readonly legacyJsonPath: string | null;

  constructor(private readonly storagePath: string) {
    this.legacyJsonPath = getLegacyJsonPath(storagePath);
  }

  async initialize(seedWorkbookPath?: string): Promise<void> {
    if (this.db) {
      return;
    }

    const db = openSqliteDatabase(this.storagePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS question_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        source_question_no TEXT NOT NULL,
        prompt TEXT NOT NULL,
        sheet_name TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS question_options (
        question_id TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        option_text TEXT NOT NULL,
        PRIMARY KEY (question_id, option_index),
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS answer_rows (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        account TEXT NOT NULL,
        debit REAL,
        credit REAL,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_questions_level ON questions(level);
      CREATE INDEX IF NOT EXISTS idx_question_options_question_id ON question_options(question_id);
      CREATE INDEX IF NOT EXISTS idx_answer_rows_question_id ON answer_rows(question_id);
    `);

    this.db = db;

    if (this.getQuestionCount() > 0) {
      return;
    }

    const legacyDataset = readJsonFile<Dataset>(this.legacyJsonPath) ?? EMPTY_DATASET;
    if (legacyDataset.questions.length > 0) {
      this.importLegacyDataset(legacyDataset);
      return;
    }

    if (seedWorkbookPath) {
      const parsed = await parseWorkbookFromFile(seedWorkbookPath);
      await this.replaceLevels(parsed.importedLevels, parsed.questions);
    }
  }

  async replaceLevels(levels: Level[], questions: Question[]): Promise<void> {
    const db = this.requireDb();
    const importedAt = new Date().toISOString();
    const mergedQuestions = mergeDuplicateQuestions(questions).map((question) => ({
      ...question,
      importedAt
    }));
    const preservedQuestions = this.loadAllQuestions().filter((question) => !levels.includes(question.level));
    const importConflicts = findQuestionImportConflicts(preservedQuestions, mergedQuestions);

    if (importConflicts.length > 0) {
      throw new Error(buildQuestionImportConflictMessage(importConflicts));
    }

    withTransaction(db, () => {
      if (levels.length > 0) {
        const placeholders = levels.map(() => "?").join(", ");
        db.prepare(`DELETE FROM questions WHERE level IN (${placeholders})`).run(...levels);
      }

      for (const question of mergedQuestions) {
        this.insertQuestion(question);
      }

      this.setMeta("imported_at", importedAt);
    });
  }

  async importQuestions(questions: Question[]): Promise<QuestionImportSummary> {
    const importedAt = new Date().toISOString();
    const mergedQuestions = mergeDuplicateQuestions(questions).map((question) => ({
      ...question,
      importedAt
    }));
    const { questionsToInsert, addedQuestions, skippedQuestions: skippedFromDatabase } = selectImportableQuestions(
      this.loadAllQuestions(),
      mergedQuestions
    );
    const skippedQuestions = questions.length - mergedQuestions.length + skippedFromDatabase;

    if (questionsToInsert.length > 0) {
      withTransaction(this.requireDb(), () => {
        for (const question of questionsToInsert) {
          this.insertQuestion(question);
        }

        this.setMeta("imported_at", importedAt);
      });
    }

    return {
      addedQuestions,
      skippedQuestions
    };
  }

  async addQuestion(input: CreateQuestionRequest): Promise<Question> {
    const sourceQuestionNo = input.sourceQuestionNo?.trim() || this.getNextQuestionNo(input.level);
    const prompt = input.prompt.trim();
    const conflict = this.findQuestionConflict(input.level, prompt, sourceQuestionNo);
    if (conflict) {
      throw new Error(buildQuestionConflictMessage(conflict, input.level, sourceQuestionNo));
    }
    const importedAt = new Date().toISOString();
    const options = [...new Set(
      [...input.options, ...input.answerRows.map((row) => row.account)]
        .map((option) => option.trim())
        .filter(Boolean)
    )];
    const answerRows = input.answerRows
      .map((row) => ({
        id: randomUUID(),
        account: row.account.trim(),
        debit: row.debit,
        credit: row.credit
      }))
      .filter((row) => row.account || row.debit !== null || row.credit !== null);

    const question: Question = {
      id: randomUUID(),
      level: input.level,
      sourceQuestionNo,
      prompt,
      options,
      answerRows,
      sheetName: "Manual",
      importedAt
    };

    withTransaction(this.requireDb(), () => {
      this.insertQuestion(question);
    });

    return question;
  }

  async updateQuestion(questionId: string, input: CreateQuestionRequest): Promise<Question> {
    const existing = this.loadQuestionById(questionId);

    if (!existing) {
      throw new Error("Question not found.");
    }

    const options = [...new Set(
      [...input.options, ...input.answerRows.map((row) => row.account)]
        .map((option) => option.trim())
        .filter(Boolean)
    )];
    const answerRows = input.answerRows
      .map((row, index) => ({
        id: existing.answerRows[index]?.id ?? randomUUID(),
        account: row.account.trim(),
        debit: row.debit,
        credit: row.credit
      }))
      .filter((row) => row.account || row.debit !== null || row.credit !== null);

    const updatedQuestion: Question = {
      ...existing,
      level: input.level,
      sourceQuestionNo: input.sourceQuestionNo?.trim() || existing.sourceQuestionNo,
      prompt: input.prompt.trim(),
      options,
      answerRows
    };
    const conflict = this.findQuestionConflict(updatedQuestion.level, updatedQuestion.prompt, updatedQuestion.sourceQuestionNo, updatedQuestion.id);
    if (conflict) {
      throw new Error(buildQuestionConflictMessage(conflict, updatedQuestion.level, updatedQuestion.sourceQuestionNo));
    }

    withTransaction(this.requireDb(), () => {
      const db = this.requireDb();
      db.prepare(`
        UPDATE questions
        SET level = ?, source_question_no = ?, prompt = ?
        WHERE id = ?
      `).run(updatedQuestion.level, updatedQuestion.sourceQuestionNo, updatedQuestion.prompt, updatedQuestion.id);
      db.prepare("DELETE FROM question_options WHERE question_id = ?").run(updatedQuestion.id);
      db.prepare("DELETE FROM answer_rows WHERE question_id = ?").run(updatedQuestion.id);
      this.insertQuestionChildren(updatedQuestion);
    });

    return updatedQuestion;
  }

  async deleteQuestion(questionId: string): Promise<void> {
    this.requireDb().prepare("DELETE FROM questions WHERE id = ?").run(questionId);
  }

  async deleteQuestions(questionIds: string[]): Promise<number> {
    const ids = [...new Set(questionIds)];
    if (ids.length === 0) {
      return 0;
    }

    const before = this.getQuestionCount();
    const placeholders = ids.map(() => "?").join(", ");
    this.requireDb().prepare(`DELETE FROM questions WHERE id IN (${placeholders})`).run(...ids);
    return before - this.getQuestionCount();
  }

  async deleteByLevel(level: Level): Promise<number> {
    const before = this.getQuestionCount();
    this.requireDb().prepare("DELETE FROM questions WHERE level = ?").run(level);
    return before - this.getQuestionCount();
  }

  async deleteAllQuestions(): Promise<number> {
    const deleted = this.getQuestionCount();
    if (deleted === 0) {
      return 0;
    }

    this.requireDb().prepare("DELETE FROM questions").run();
    return deleted;
  }

  getSummary(): SummaryResponse {
    const db = this.requireDb();
    const counts = db.prepare(`
      SELECT level, COUNT(*) AS count
      FROM questions
      GROUP BY level
    `).all() as Array<{ level: string; count: number }>;
    const countByLevel = new Map<Level, number>(
      counts
        .filter((row): row is { level: Level; count: number } => LEVELS.includes(row.level as Level))
        .map((row) => [row.level, Number(row.count)])
    );

    return {
      totalQuestions: this.getQuestionCount(),
      lastImportedAt: this.getMeta("imported_at"),
      levels: LEVELS.map((level) => ({
        level,
        count: countByLevel.get(level) ?? 0
      }))
    };
  }

  getQuestions(level?: Level, search?: string): Question[] {
    const tokens = tokenizeSearch(search);

    return this.loadAllQuestions().filter((question) => {
      if (level && question.level !== level) {
        return false;
      }

      if (!tokens.length) {
        return true;
      }

      return tokens.every((token) => matchesQuestionToken(question, token));
    });
  }

  listQuestions(options: QuestionListOptions): { questions: Question[]; pagination: PaginationMeta } {
    const filtered = this.getQuestions(options.level, options.search);
    const { items, pagination } = paginateItems(filtered, options.page, options.pageSize);
    return { questions: items, pagination };
  }

  getStudentQuestions(level: Level): StudentQuestion[] {
    return this.getQuestions(level).map((question) => ({
      id: question.id,
      level: question.level,
      sourceQuestionNo: question.sourceQuestionNo,
      prompt: question.prompt,
      options: question.options,
      answerSlotCount: MATRIX_ROW_COUNT
    }));
  }

  getQuestionsByIds(questionIds: string[]): Question[] {
    const questionMap = new Map(this.loadAllQuestions().map((question) => [question.id, question]));
    return questionIds.flatMap((questionId) => {
      const question = questionMap.get(questionId);
      return question ? [question] : [];
    });
  }

  getRandomStudentQuestions(level: Level, requestedCount: number): StudentQuestion[] {
    const questions = [...this.getQuestions(level)];

    for (let index = questions.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [questions[index], questions[swapIndex]] = [questions[swapIndex], questions[index]];
    }

    return questions.slice(0, Math.min(requestedCount, questions.length)).map((question) => ({
      id: question.id,
      level: question.level,
      sourceQuestionNo: question.sourceQuestionNo,
      prompt: question.prompt,
      options: question.options,
      answerSlotCount: MATRIX_ROW_COUNT
    }));
  }

  async seedFromWorkbook(workbookPath: string): Promise<void> {
    const parsed = await parseWorkbookFromFile(workbookPath);
    await this.replaceLevels(parsed.importedLevels, parsed.questions);
  }

  private importLegacyDataset(dataset: Dataset): void {
    const mergedQuestions = mergeDuplicateQuestions(dataset.questions);

    withTransaction(this.requireDb(), () => {
      const db = this.requireDb();
      db.exec(`
        DELETE FROM answer_rows;
        DELETE FROM question_options;
        DELETE FROM questions;
      `);

      for (const question of mergedQuestions) {
        this.insertQuestion(question);
      }

      this.setMeta("imported_at", dataset.importedAt);
    });
  }

  private insertQuestion(question: Question): void {
    const db = this.requireDb();
    db.prepare(`
      INSERT INTO questions (
        id,
        level,
        source_question_no,
        prompt,
        sheet_name,
        imported_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      question.id,
      question.level,
      question.sourceQuestionNo,
      question.prompt,
      question.sheetName,
      question.importedAt
    );
    this.insertQuestionChildren(question);
  }

  private insertQuestionChildren(question: Question): void {
    const db = this.requireDb();
    const insertOption = db.prepare(`
      INSERT INTO question_options (question_id, option_index, option_text)
      VALUES (?, ?, ?)
    `);
    const insertAnswerRow = db.prepare(`
      INSERT INTO answer_rows (id, question_id, row_index, account, debit, credit)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    question.options.forEach((option, index) => {
      insertOption.run(question.id, index, option);
    });

    question.answerRows.forEach((row, index) => {
      insertAnswerRow.run(row.id, question.id, index, row.account, row.debit, row.credit);
    });
  }

  private loadAllQuestions(): Question[] {
    const db = this.requireDb();
    const questionRows = db.prepare(`
      SELECT
        id,
        level,
        source_question_no AS sourceQuestionNo,
        prompt,
        sheet_name AS sheetName,
        imported_at AS importedAt
      FROM questions
    `).all() as unknown as QuestionRowRecord[];

    const optionRows = db.prepare(`
      SELECT
        question_id AS questionId,
        option_index AS optionIndex,
        option_text AS optionText
      FROM question_options
      ORDER BY question_id, option_index
    `).all() as unknown as QuestionOptionRecord[];

    const answerRows = db.prepare(`
      SELECT
        id,
        question_id AS questionId,
        row_index AS rowIndex,
        account,
        debit,
        credit
      FROM answer_rows
      ORDER BY question_id, row_index
    `).all() as unknown as AnswerRowRecord[];

    const optionsByQuestion = new Map<string, string[]>();
    for (const optionRow of optionRows) {
      const options = optionsByQuestion.get(optionRow.questionId) ?? [];
      options.push(optionRow.optionText);
      optionsByQuestion.set(optionRow.questionId, options);
    }

    const answerRowsByQuestion = new Map<string, Question["answerRows"]>();
    for (const answerRow of answerRows) {
      const rows = answerRowsByQuestion.get(answerRow.questionId) ?? [];
      rows.push({
        id: answerRow.id,
        account: answerRow.account,
        debit: answerRow.debit === null ? null : Number(answerRow.debit),
        credit: answerRow.credit === null ? null : Number(answerRow.credit)
      });
      answerRowsByQuestion.set(answerRow.questionId, rows);
    }

    return sortQuestions(questionRows.map((row) => ({
      id: row.id,
      level: row.level as Level,
      sourceQuestionNo: row.sourceQuestionNo,
      prompt: row.prompt,
      options: optionsByQuestion.get(row.id) ?? [],
      answerRows: answerRowsByQuestion.get(row.id) ?? [],
      sheetName: row.sheetName,
      importedAt: row.importedAt
    })));
  }

  private loadQuestionById(questionId: string): Question | null {
    return this.loadAllQuestions().find((question) => question.id === questionId) ?? null;
  }

  private findQuestionConflict(level: Level, prompt: string, sourceQuestionNo: string, excludeQuestionId?: string): QuestionConflict | null {
    const normalizedPrompt = normalizeQuestionPrompt(prompt);
    const normalizedSourceQuestionNo = normalizeQuestionNumber(sourceQuestionNo);

    for (const question of this.loadAllQuestions()) {
      if (question.id === excludeQuestionId) {
        continue;
      }

      if (question.level === level && normalizeQuestionNumber(question.sourceQuestionNo) === normalizedSourceQuestionNo) {
        return { question, reason: "sourceQuestionNo" };
      }

      if (normalizedPrompt && normalizeQuestionPrompt(question.prompt) === normalizedPrompt) {
        return { question, reason: "prompt" };
      }
    }

    return null;
  }

  private getNextQuestionNo(level: Level): string {
    const sameLevel = this.loadAllQuestions()
      .filter((question) => question.level === level)
      .map((question) => Number(question.sourceQuestionNo))
      .filter((value) => Number.isFinite(value));

    return String((sameLevel.length ? Math.max(...sameLevel) : 0) + 1);
  }

  private getQuestionCount(): number {
    const row = this.requireDb().prepare("SELECT COUNT(*) AS count FROM questions").get() as { count: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private getMeta(key: string): string | null {
    const row = this.requireDb().prepare("SELECT value FROM question_meta WHERE key = ?").get(key) as { value: string } | undefined;
    if (!row || !row.value) {
      return null;
    }

    return row.value;
  }

  private setMeta(key: string, value: string | null): void {
    this.requireDb().prepare(`
      INSERT INTO question_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value ?? "");
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error("Question store has not been initialized.");
    }

    return this.db;
  }
}
