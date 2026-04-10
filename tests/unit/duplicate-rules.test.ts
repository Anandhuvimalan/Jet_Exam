import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Question } from "../../src/shared/types";
import { PlatformStore } from "../../src/server/storage/platform-store";
import { QuestionStore } from "../../src/server/storage/question-store";

function createTempStoragePath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return join(directory, "store.json");
}

function buildImportedQuestion(level: "basic" | "medium" | "hard", sourceQuestionNo: string, prompt: string): Question {
  return {
    id: `${level}-${sourceQuestionNo}`,
    level,
    sourceQuestionNo,
    prompt,
    options: ["Cash", "Sales"],
    answerRows: [],
    sheetName: "Import",
    importedAt: new Date().toISOString()
  };
}

describe("duplicate rules", () => {
  it("blocks duplicate manual questions across different modes", async () => {
    const store = new QuestionStore(createTempStoragePath("jet-question-dup"));
    await store.initialize();

    await store.addQuestion({
      level: "basic",
      sourceQuestionNo: "1",
      prompt: "Cash received from customer",
      options: ["Cash", "Customer"],
      answerRows: []
    });

    await expect(
      store.addQuestion({
        level: "hard",
        sourceQuestionNo: "2100",
        prompt: "Cash received from customer",
        options: ["Cash", "Customer"],
        answerRows: []
      })
    ).rejects.toThrow("Questions must be unique across all modes.");
  });

  it("bulk question import adds only unique prompts and skips duplicates already in the bank", async () => {
    const store = new QuestionStore(createTempStoragePath("jet-question-import"));
    await store.initialize();

    await store.addQuestion({
      level: "hard",
      sourceQuestionNo: "2100",
      prompt: "Provided services to the customers for the amount of Rs 20000, the customers will pay in 30 days",
      options: ["Accounts Receivable", "Service Revenue"],
      answerRows: []
    });

    const result = await store.importQuestions([
      buildImportedQuestion("basic", "1", "Provided services to the customers for the amount of Rs 20000, the customers will pay in 30 days"),
      buildImportedQuestion("basic", "2", "Cash paid to supplier")
    ]);

    expect(result.addedQuestions).toBe(1);
    expect(result.skippedQuestions).toBe(1);
    expect(store.getSummary().totalQuestions).toBe(2);
  });

  it("bulk student import skips duplicate emails inside the upload and existing emails in the system", async () => {
    const store = new PlatformStore(createTempStoragePath("jet-student-import"));
    await store.initialize();

    await store.createStudent("student1@gmail.com", "Student One", 30);
    const result = await store.importStudents([
      { registerNumber: "student1@gmail.com", name: "Student One Again", accessDays: 45 },
      { registerNumber: "Student1@gmail.com", name: "Student One Duplicate", accessDays: 45 },
      { registerNumber: "student2@gmail.com", name: "Student Two", accessDays: 20 }
    ]);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("keeps manual student uniqueness strict", async () => {
    const store = new PlatformStore(createTempStoragePath("jet-student-update"));
    await store.initialize();

    await store.createStudent("student2@gmail.com", "Student Two", 30);

    await expect(store.createStudent("student2@gmail.com", "Duplicate Student", 10)).rejects.toThrow(
      "That student email is already in use."
    );
  });
});
