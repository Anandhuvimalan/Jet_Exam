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

  it("bulk question import skips punctuation and spacing variants of the same prompt", async () => {
    const store = new QuestionStore(createTempStoragePath("jet-question-variant-import"));
    await store.initialize();

    const result = await store.importQuestions([
      buildImportedQuestion("basic", "120", "Cash of Rs. 2500 transferred to pettycash from main cash"),
      buildImportedQuestion("basic", "203", "Cash of Rs 2500 transferred to petty cash from main cash"),
      buildImportedQuestion("basic", "72", "Purchased goods of Rs. 80000 on credit from Mr.A"),
      buildImportedQuestion("basic", "215", "Purchased goods of Rs 80000 on credit from Mr A"),
      buildImportedQuestion("basic", "300", "Cash paid to supplier")
    ]);

    expect(result.addedQuestions).toBe(3);
    expect(result.skippedQuestions).toBe(2);
    expect(store.getSummary().totalQuestions).toBe(3);
  });

  it("bulk question import skips punctuation and spacing variants already stored in the bank", async () => {
    const store = new QuestionStore(createTempStoragePath("jet-question-existing-variant-import"));
    await store.initialize();

    await store.addQuestion({
      level: "medium",
      sourceQuestionNo: "400",
      prompt: "Employers ESI contribution of Rs.950 and Employees ESI contribution of Rs. 350 deposited into bank.",
      options: ["Bank", "ESI"],
      answerRows: []
    });

    const result = await store.importQuestions([
      buildImportedQuestion(
        "hard",
        "2102",
        "Employers ESI contribution of Rs 950 and Employees ESI contribution of Rs 350 deposited into bank"
      ),
      buildImportedQuestion("hard", "2103", "Insurance premium paid from bank")
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
      { registerNumber: " student1@gmail.com ", name: "Student One Again", accessDays: 45 },
      { registerNumber: "Student1@gmail.com", name: "Student One Duplicate", accessDays: 45 },
      { registerNumber: "student2@gmail.com", name: "Student Two", accessDays: 20 }
    ]);

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("bulk student import skips duplicates from later uploads too", async () => {
    const store = new PlatformStore(createTempStoragePath("jet-student-reimport"));
    await store.initialize();

    const firstImport = await store.importStudents([
      { registerNumber: "student2@gmail.com", name: "Student Two", accessDays: 20 },
      { registerNumber: "student3@gmail.com", name: "Student Three", accessDays: 25 }
    ]);
    const secondImport = await store.importStudents([
      { registerNumber: " Student2@gmail.com ", name: "Student Two Again", accessDays: 45 },
      { registerNumber: "student4@gmail.com", name: "Student Four", accessDays: 15 }
    ]);

    expect(firstImport.created).toBe(2);
    expect(firstImport.skipped).toBe(0);
    expect(secondImport.created).toBe(1);
    expect(secondImport.skipped).toBe(1);
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
