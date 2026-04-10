import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
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
import { applyPostgresSchema, openPostgresPool, queryMany, queryOne, readJsonFile, withPostgresTransaction } from "./postgres";
import { getLegacyJsonPath } from "./sqlite";

const EMPTY_DATASET: Dataset = {
  version: 1,
  importedAt: null,
  questions: []
};
const QUESTION_CACHE_TTL_MS = 30_000;

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
  sourcequestionno: string;
  prompt: string;
  sheetname: string;
  importedat: string;
}

interface QuestionOptionRecord {
  questionid: string;
  optionindex: number;
  optiontext: string;
}

interface AnswerRowRecord {
  id: string;
  questionid: string;
  rowindex: number;
  account: string;
  debit: number | string | null;
  credit: number | string | null;
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

interface QuestionSnapshot {
  importedAt: string | null;
  questions: Question[];
}

interface CachedQuestionSnapshot extends QuestionSnapshot {
  loadedAt: number;
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
  return value.replace(/\s+/g, " ").trim().toLowerCase();
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

  return searchableValues.some((entry) => String(entry).toLowerCase().includes(value));
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

export class PostgresQuestionStore {
  private pool: Pool | null = null;
  private readonly legacyJsonPath: string | null;
  private snapshotCache: CachedQuestionSnapshot | null = null;
  private snapshotPromise: Promise<CachedQuestionSnapshot> | null = null;

  constructor(
    private readonly storagePath: string,
    private readonly connectionString: string
  ) {
    this.legacyJsonPath = getLegacyJsonPath(storagePath);
  }

  async initialize(seedWorkbookPath?: string): Promise<void> {
    if (this.pool) {
      return;
    }

    const pool = openPostgresPool(this.connectionString);
    await applyPostgresSchema(pool);
    this.pool = pool;

    if (await this.getQuestionCount() > 0) {
      await this.getSnapshot(true);
      return;
    }

    const legacyDataset = readJsonFile<Dataset>(this.legacyJsonPath) ?? EMPTY_DATASET;
    if (legacyDataset.questions.length > 0) {
      await this.importLegacyDataset(legacyDataset);
      await this.getSnapshot(true);
      return;
    }

    if (seedWorkbookPath) {
      const parsed = await parseWorkbookFromFile(seedWorkbookPath);
      await this.replaceLevels(parsed.importedLevels, parsed.questions);
      await this.getSnapshot(true);
    }
  }

  async replaceLevels(levels: Level[], questions: Question[]): Promise<void> {
    const importedAt = new Date().toISOString();
    const mergedQuestions = mergeDuplicateQuestions(questions).map((question) => ({
      ...question,
      importedAt
    }));
    const preservedQuestions = (await this.getSnapshot()).questions.filter((question) => !levels.includes(question.level));
    const importConflicts = findQuestionImportConflicts(preservedQuestions, mergedQuestions);

    if (importConflicts.length > 0) {
      throw new Error(buildQuestionImportConflictMessage(importConflicts));
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      if (levels.length > 0) {
        await client.query("DELETE FROM questions WHERE level = ANY($1::text[])", [levels]);
      }

      await this.insertQuestionsBulk(client, mergedQuestions);

      await this.setMeta("imported_at", importedAt, client);
    });

    this.invalidateSnapshotCache();
  }

  async importQuestions(questions: Question[]): Promise<QuestionImportSummary> {
    const importedAt = new Date().toISOString();
    const mergedQuestions = mergeDuplicateQuestions(questions).map((question) => ({
      ...question,
      importedAt
    }));
    const { questionsToInsert, addedQuestions, skippedQuestions: skippedFromDatabase } = selectImportableQuestions(
      (await this.getSnapshot()).questions,
      mergedQuestions
    );
    const skippedQuestions = questions.length - mergedQuestions.length + skippedFromDatabase;

    if (questionsToInsert.length > 0) {
      await withPostgresTransaction(this.requirePool(), async (client) => {
        await this.insertQuestionsBulk(client, questionsToInsert);
        await this.setMeta("imported_at", importedAt, client);
      });

      this.invalidateSnapshotCache();
    }

    return {
      addedQuestions,
      skippedQuestions
    };
  }

  async addQuestion(input: CreateQuestionRequest): Promise<Question> {
    const sourceQuestionNo = input.sourceQuestionNo?.trim() || await this.getNextQuestionNo(input.level);
    const prompt = input.prompt.trim();
    const conflict = await this.findQuestionConflict(input.level, prompt, sourceQuestionNo);
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

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await this.insertQuestion(client, question);
    });

    this.invalidateSnapshotCache();
    return question;
  }

  async updateQuestion(questionId: string, input: CreateQuestionRequest): Promise<Question> {
    const existing = await this.loadQuestionById(questionId);

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
    const conflict = await this.findQuestionConflict(
      updatedQuestion.level,
      updatedQuestion.prompt,
      updatedQuestion.sourceQuestionNo,
      updatedQuestion.id
    );
    if (conflict) {
      throw new Error(buildQuestionConflictMessage(conflict, updatedQuestion.level, updatedQuestion.sourceQuestionNo));
    }

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await client.query(
        `
          UPDATE questions
          SET level = $1, source_question_no = $2, prompt = $3
          WHERE id = $4
        `,
        [updatedQuestion.level, updatedQuestion.sourceQuestionNo, updatedQuestion.prompt, updatedQuestion.id]
      );
      await client.query("DELETE FROM question_options WHERE question_id = $1", [updatedQuestion.id]);
      await client.query("DELETE FROM answer_rows WHERE question_id = $1", [updatedQuestion.id]);
      await this.insertQuestionChildren(client, updatedQuestion);
    });

    this.invalidateSnapshotCache();
    return updatedQuestion;
  }

  async deleteQuestion(questionId: string): Promise<void> {
    await this.requirePool().query("DELETE FROM questions WHERE id = $1", [questionId]);
    this.invalidateSnapshotCache();
  }

  async deleteQuestions(questionIds: string[]): Promise<number> {
    const ids = [...new Set(questionIds)];
    if (ids.length === 0) {
      return 0;
    }

    const before = await this.getQuestionCount();
    await this.requirePool().query("DELETE FROM questions WHERE id = ANY($1::text[])", [ids]);
    this.invalidateSnapshotCache();
    return before - await this.getQuestionCount();
  }

  async deleteByLevel(level: Level): Promise<number> {
    const before = await this.getQuestionCount();
    await this.requirePool().query("DELETE FROM questions WHERE level = $1", [level]);
    this.invalidateSnapshotCache();
    return before - await this.getQuestionCount();
  }

  async deleteAllQuestions(): Promise<number> {
    const deleted = await this.getQuestionCount();
    if (deleted === 0) {
      return 0;
    }

    await this.requirePool().query("DELETE FROM questions");
    this.invalidateSnapshotCache();
    return deleted;
  }

  async getSummary(): Promise<SummaryResponse> {
    return this.buildSummary(await this.getSnapshot());
  }

  async getQuestions(level?: Level, search?: string): Promise<Question[]> {
    const tokens = tokenizeSearch(search);
    const snapshot = await this.getSnapshot();

    return snapshot.questions.filter((question) => {
      if (level && question.level !== level) {
        return false;
      }

      if (!tokens.length) {
        return true;
      }

      return tokens.every((token) => matchesQuestionToken(question, token));
    });
  }

  async listQuestions(options: QuestionListOptions): Promise<{ questions: Question[]; pagination: PaginationMeta }> {
    const filtered = await this.getQuestions(options.level, options.search);
    const { items, pagination } = paginateItems(filtered, options.page, options.pageSize);
    return { questions: items, pagination };
  }

  async getStudentQuestions(level: Level): Promise<StudentQuestion[]> {
    return (await this.getQuestions(level)).map((question) => ({
      id: question.id,
      level: question.level,
      sourceQuestionNo: question.sourceQuestionNo,
      prompt: question.prompt,
      options: question.options,
      answerSlotCount: MATRIX_ROW_COUNT
    }));
  }

  async getQuestionsByIds(questionIds: string[]): Promise<Question[]> {
    const questionMap = new Map((await this.getSnapshot()).questions.map((question) => [question.id, question]));
    return questionIds.flatMap((questionId) => {
      const question = questionMap.get(questionId);
      return question ? [question] : [];
    });
  }

  async getRandomStudentQuestions(level: Level, requestedCount: number): Promise<StudentQuestion[]> {
    const questions = [...await this.getQuestions(level)];

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

  private async importLegacyDataset(dataset: Dataset): Promise<void> {
    const mergedQuestions = mergeDuplicateQuestions(dataset.questions);

    await withPostgresTransaction(this.requirePool(), async (client) => {
      await client.query("DELETE FROM answer_rows");
      await client.query("DELETE FROM question_options");
      await client.query("DELETE FROM questions");

      await this.insertQuestionsBulk(client, mergedQuestions);

      await this.setMeta("imported_at", dataset.importedAt, client);
    });

    this.invalidateSnapshotCache();
  }

  private async insertQuestionsBulk(client: PoolClient, questions: Question[]): Promise<void> {
    if (questions.length === 0) {
      return;
    }

    const questionRows = questions.map((question) => ({
      id: question.id,
      level: question.level,
      source_question_no: question.sourceQuestionNo,
      prompt: question.prompt,
      sheet_name: question.sheetName,
      imported_at: question.importedAt
    }));
    const optionRows = questions.flatMap((question) =>
      question.options.map((optionText, optionIndex) => ({
        question_id: question.id,
        option_index: optionIndex,
        option_text: optionText
      }))
    );
    const answerRows = questions.flatMap((question) =>
      question.answerRows.map((row, rowIndex) => ({
        id: row.id,
        question_id: question.id,
        row_index: rowIndex,
        account: row.account,
        debit: row.debit,
        credit: row.credit
      }))
    );

    await client.query(
      `
        INSERT INTO questions (id, level, source_question_no, prompt, sheet_name, imported_at)
        SELECT
          payload.id,
          payload.level,
          payload.source_question_no,
          payload.prompt,
          payload.sheet_name,
          payload.imported_at::timestamptz
        FROM jsonb_to_recordset($1::jsonb) AS payload(
          id text,
          level text,
          source_question_no text,
          prompt text,
          sheet_name text,
          imported_at text
        )
      `,
      [JSON.stringify(questionRows)]
    );

    if (optionRows.length > 0) {
      await client.query(
        `
          INSERT INTO question_options (question_id, option_index, option_text)
          SELECT
            payload.question_id,
            payload.option_index,
            payload.option_text
          FROM jsonb_to_recordset($1::jsonb) AS payload(
            question_id text,
            option_index integer,
            option_text text
          )
        `,
        [JSON.stringify(optionRows)]
      );
    }

    if (answerRows.length > 0) {
      await client.query(
        `
          INSERT INTO answer_rows (id, question_id, row_index, account, debit, credit)
          SELECT
            payload.id,
            payload.question_id,
            payload.row_index,
            payload.account,
            payload.debit,
            payload.credit
          FROM jsonb_to_recordset($1::jsonb) AS payload(
            id text,
            question_id text,
            row_index integer,
            account text,
            debit numeric,
            credit numeric
          )
        `,
        [JSON.stringify(answerRows)]
      );
    }
  }

  private async insertQuestion(client: PoolClient, question: Question): Promise<void> {
    await client.query(
      `
        INSERT INTO questions (
          id,
          level,
          source_question_no,
          prompt,
          sheet_name,
          imported_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        question.id,
        question.level,
        question.sourceQuestionNo,
        question.prompt,
        question.sheetName,
        question.importedAt
      ]
    );
    await this.insertQuestionChildren(client, question);
  }

  private async insertQuestionChildren(client: PoolClient, question: Question): Promise<void> {
    for (const [index, option] of question.options.entries()) {
      await client.query(
        `
          INSERT INTO question_options (question_id, option_index, option_text)
          VALUES ($1, $2, $3)
        `,
        [question.id, index, option]
      );
    }

    for (const [index, row] of question.answerRows.entries()) {
      await client.query(
        `
          INSERT INTO answer_rows (id, question_id, row_index, account, debit, credit)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [row.id, question.id, index, row.account, row.debit, row.credit]
      );
    }
  }

  private async loadAllQuestions(): Promise<Question[]> {
    return (await this.getSnapshot()).questions;
  }

  private async readSnapshotFromPostgres(): Promise<QuestionSnapshot> {
    const [questionRows, optionRows, answerRows, importedAtRow] = await Promise.all([
      queryMany<QuestionRowRecord>(
        this.requirePool(),
        `
          SELECT
            id,
            level,
            source_question_no AS sourceQuestionNo,
            prompt,
            sheet_name AS sheetName,
            imported_at AS importedAt
          FROM questions
        `
      ),
      queryMany<QuestionOptionRecord>(
        this.requirePool(),
        `
          SELECT
            question_id AS questionId,
            option_index AS optionIndex,
            option_text AS optionText
          FROM question_options
          ORDER BY question_id, option_index
        `
      ),
      queryMany<AnswerRowRecord>(
        this.requirePool(),
        `
          SELECT
            id,
            question_id AS questionId,
            row_index AS rowIndex,
            account,
            debit,
            credit
          FROM answer_rows
          ORDER BY question_id, row_index
        `
      ),
      queryOne<{ value: string }>(this.requirePool(), "SELECT value FROM question_meta WHERE key = $1", ["imported_at"])
    ]);

    const optionsByQuestion = new Map<string, string[]>();
    for (const optionRow of optionRows) {
      const options = optionsByQuestion.get(optionRow.questionid) ?? [];
      options.push(optionRow.optiontext);
      optionsByQuestion.set(optionRow.questionid, options);
    }

    const answerRowsByQuestion = new Map<string, Question["answerRows"]>();
    for (const answerRow of answerRows) {
      const rows = answerRowsByQuestion.get(answerRow.questionid) ?? [];
      rows.push({
        id: answerRow.id,
        account: answerRow.account,
        debit: answerRow.debit === null ? null : Number(answerRow.debit),
        credit: answerRow.credit === null ? null : Number(answerRow.credit)
      });
      answerRowsByQuestion.set(answerRow.questionid, rows);
    }

    return {
      importedAt: importedAtRow?.value ?? null,
      questions: sortQuestions(questionRows.map((row) => ({
        id: row.id,
        level: row.level as Level,
        sourceQuestionNo: row.sourcequestionno,
        prompt: row.prompt,
        options: optionsByQuestion.get(row.id) ?? [],
        answerRows: answerRowsByQuestion.get(row.id) ?? [],
        sheetName: row.sheetname,
        importedAt: row.importedat
      })))
    };
  }

  private async loadQuestionById(questionId: string): Promise<Question | null> {
    return (await this.getSnapshot()).questions.find((question) => question.id === questionId) ?? null;
  }

  private async findQuestionConflict(
    level: Level,
    prompt: string,
    sourceQuestionNo: string,
    excludeQuestionId?: string
  ): Promise<QuestionConflict | null> {
    const normalizedPrompt = normalizeQuestionPrompt(prompt);
    const normalizedSourceQuestionNo = normalizeQuestionNumber(sourceQuestionNo);

    for (const question of (await this.getSnapshot()).questions) {
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

  private async getNextQuestionNo(level: Level): Promise<string> {
    const sameLevel = (await this.getSnapshot()).questions
      .filter((question) => question.level === level)
      .map((question) => Number(question.sourceQuestionNo))
      .filter((value) => Number.isFinite(value));

    return String((sameLevel.length ? Math.max(...sameLevel) : 0) + 1);
  }

  private async getQuestionCount(): Promise<number> {
    const row = await queryOne<{ count: string | number }>(this.requirePool(), "SELECT COUNT(*)::int AS count FROM questions");
    return Number(row?.count ?? 0);
  }

  private async getMeta(key: string): Promise<string | null> {
    const row = await queryOne<{ value: string }>(this.requirePool(), "SELECT value FROM question_meta WHERE key = $1", [key]);
    if (!row || !row.value) {
      return null;
    }

    return row.value;
  }

  private async setMeta(key: string, value: string | null, client?: PoolClient): Promise<void> {
    const queryable = client ?? this.requirePool();
    await queryable.query(
      `
        INSERT INTO question_meta (key, value)
        VALUES ($1, $2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
      [key, value ?? ""]
    );
  }

  private buildSummary(snapshot: QuestionSnapshot): SummaryResponse {
    const countByLevel = new Map<Level, number>();
    for (const question of snapshot.questions) {
      countByLevel.set(question.level, (countByLevel.get(question.level) ?? 0) + 1);
    }

    return {
      totalQuestions: snapshot.questions.length,
      lastImportedAt: snapshot.importedAt,
      levels: LEVELS.map((level) => ({
        level,
        count: countByLevel.get(level) ?? 0
      }))
    };
  }

  private invalidateSnapshotCache(): void {
    this.snapshotCache = null;
    this.snapshotPromise = null;
  }

  private async getSnapshot(forceRefresh = false): Promise<CachedQuestionSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.snapshotCache && now - this.snapshotCache.loadedAt <= QUESTION_CACHE_TTL_MS) {
      return this.snapshotCache;
    }

    if (!forceRefresh && this.snapshotPromise) {
      return this.snapshotPromise;
    }

    const loadPromise = this.readSnapshotFromPostgres()
      .then((snapshot) => {
        const cachedSnapshot: CachedQuestionSnapshot = {
          ...snapshot,
          loadedAt: Date.now()
        };
        this.snapshotCache = cachedSnapshot;
        return cachedSnapshot;
      })
      .finally(() => {
        if (this.snapshotPromise === loadPromise) {
          this.snapshotPromise = null;
        }
      });

    this.snapshotPromise = loadPromise;
    return loadPromise;
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new Error("Question store has not been initialized.");
    }

    return this.pool;
  }
}
