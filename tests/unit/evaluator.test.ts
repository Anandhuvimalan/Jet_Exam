import { describe, it, expect } from "vitest";
import { evaluateSubmissions } from "../../src/server/services/evaluator";
import type { Question, StudentSubmission, Level } from "../../src/shared/types";

function makeQuestion(id: string, level: Level, answerRows: Array<{ account: string; debit: number | null; credit: number | null }>): Question {
  return {
    id,
    level,
    sourceQuestionNo: id,
    prompt: `Test question ${id}`,
    options: ["Cash", "Revenue", "Expense"],
    sheetName: "Test",
    importedAt: new Date().toISOString(),
    answerRows: answerRows.map((row, i) => ({ id: `${id}-row-${i}`, ...row }))
  };
}

describe("evaluateSubmissions", () => {
  it("should score a perfect submission correctly", () => {
    const questions = [
      makeQuestion("q1", "basic", [
        { account: "Cash", debit: 500, credit: null },
        { account: "Revenue", debit: null, credit: 500 }
      ])
    ];

    const submissions: StudentSubmission[] = [{
      questionId: "q1",
      rows: [
        { account: "Cash", debit: "500", credit: "" },
        { account: "Revenue", debit: "", credit: "500" }
      ]
    }];

    const result = evaluateSubmissions("basic", questions, submissions);
    expect(result.correctQuestions).toBe(1);
    expect(result.accuracy).toBe(1);
    expect(result.lineAccuracy).toBe(1);
    expect(result.questionResults[0].isCorrect).toBe(true);
  });

  it("should handle completely wrong answers", () => {
    const questions = [
      makeQuestion("q1", "basic", [
        { account: "Cash", debit: 500, credit: null }
      ])
    ];

    const submissions: StudentSubmission[] = [{
      questionId: "q1",
      rows: [
        { account: "Inventory", debit: "300", credit: "" }
      ]
    }];

    const result = evaluateSubmissions("basic", questions, submissions);
    expect(result.correctQuestions).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.questionResults[0].isCorrect).toBe(false);
  });

  it("should handle empty submissions", () => {
    const questions = [
      makeQuestion("q1", "basic", [
        { account: "Cash", debit: 100, credit: null }
      ])
    ];

    const result = evaluateSubmissions("basic", questions, []);
    expect(result.correctQuestions).toBe(0);
    expect(result.wrongQuestions).toBe(1);
    expect(result.questionResults[0].missingRows.length).toBe(1);
  });

  it("should handle multiple questions with mixed results", () => {
    const questions = [
      makeQuestion("q1", "medium", [
        { account: "Cash", debit: 100, credit: null }
      ]),
      makeQuestion("q2", "medium", [
        { account: "Revenue", debit: null, credit: 200 }
      ])
    ];

    const submissions: StudentSubmission[] = [
      { questionId: "q1", rows: [{ account: "Cash", debit: "100", credit: "" }] },
      { questionId: "q2", rows: [{ account: "Expense", debit: "200", credit: "" }] }
    ];

    const result = evaluateSubmissions("medium", questions, submissions);
    expect(result.correctQuestions).toBe(1);
    expect(result.wrongQuestions).toBe(1);
    expect(result.accuracy).toBe(0.5);
  });

  it("should be case-insensitive on account matching", () => {
    const questions = [
      makeQuestion("q1", "basic", [
        { account: "Cash", debit: 500, credit: null }
      ])
    ];

    const submissions: StudentSubmission[] = [{
      questionId: "q1",
      rows: [{ account: "  CASH  ", debit: "500", credit: "" }]
    }];

    const result = evaluateSubmissions("basic", questions, submissions);
    expect(result.correctQuestions).toBe(1);
  });

  it("should handle comma-formatted numbers", () => {
    const questions = [
      makeQuestion("q1", "hard", [
        { account: "Cash", debit: 1500, credit: null }
      ])
    ];

    const submissions: StudentSubmission[] = [{
      questionId: "q1",
      rows: [{ account: "Cash", debit: "1,500", credit: "" }]
    }];

    const result = evaluateSubmissions("hard", questions, submissions);
    expect(result.correctQuestions).toBe(1);
  });

  it("should handle zero questions gracefully", () => {
    const result = evaluateSubmissions("basic", [], []);
    expect(result.totalQuestions).toBe(0);
    expect(result.accuracy).toBe(0);
    expect(result.lineAccuracy).toBe(0);
  });

  it("should handle partial row matches and track line accuracy", () => {
    const questions = [
      makeQuestion("q1", "basic", [
        { account: "Cash", debit: 100, credit: null },
        { account: "Revenue", debit: null, credit: 100 },
        { account: "Tax", debit: 20, credit: null }
      ])
    ];

    const submissions: StudentSubmission[] = [{
      questionId: "q1",
      rows: [
        { account: "Cash", debit: "100", credit: "" },
        { account: "Revenue", debit: "", credit: "100" },
        { account: "Wrong", debit: "0", credit: "" }
      ]
    }];

    const result = evaluateSubmissions("basic", questions, submissions);
    expect(result.lineAccuracy).toBeCloseTo(2 / 3, 2);
    expect(result.questionResults[0].matchedRows).toBe(2);
  });
});
