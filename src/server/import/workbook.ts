import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Workbook, type CellValue, type Worksheet } from "exceljs";
import { type Level, type Question } from "../../shared/types";

const SHEET_LEVEL_MAP: Record<string, Level> = {
  Basic: "basic",
  Medium: "medium",
  Hard: "hard"
};
const LEVEL_ORDER: Level[] = ["basic", "medium", "hard"];

interface ParsedWorkbook {
  importedLevels: Level[];
  questions: Question[];
}

type SheetRow = [unknown?, unknown?, unknown?, unknown?, unknown?, unknown?, unknown?, unknown?];
type WorkbookBufferInput = Parameters<Workbook["xlsx"]["load"]>[0];

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function cleanText(value: unknown): string {
  return hasValue(value) ? String(value).replace(/\s+/g, " ").trim() : "";
}

function formatQuestionNo(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
  }

  return cleanText(value).replace(/\.0+$/, "");
}

function parseAmount(value: unknown): number | null {
  if (!hasValue(value)) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCellValue(value: CellValue): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const candidate = value as {
    text?: string;
    result?: CellValue;
    richText?: Array<{ text?: string }>;
    error?: string;
  };

  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  if (candidate.result !== undefined) {
    return normalizeCellValue(candidate.result);
  }

  if (Array.isArray(candidate.richText)) {
    return candidate.richText.map((part) => part.text ?? "").join("");
  }

  if (candidate.error) {
    return candidate.error;
  }

  return null;
}

function worksheetToRows(worksheet: Worksheet): SheetRow[] {
  const rows: SheetRow[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    rows.push([
      normalizeCellValue(row.getCell(1).value),
      normalizeCellValue(row.getCell(2).value),
      normalizeCellValue(row.getCell(3).value),
      normalizeCellValue(row.getCell(4).value),
      normalizeCellValue(row.getCell(5).value),
      normalizeCellValue(row.getCell(6).value),
      normalizeCellValue(row.getCell(7).value),
      normalizeCellValue(row.getCell(8).value)
    ]);
  });

  return rows;
}

function isHeaderRow(row: SheetRow): boolean {
  return /^no$/i.test(cleanText(row[0])) &&
    /particulars/i.test(cleanText(row[1])) &&
    /particulars/i.test(cleanText(row[2]));
}

function hasQuestionContent(row: SheetRow): boolean {
  return [row[1], row[2], row[4], row[5], row[6]].some(hasValue);
}

function detectLevelMarker(row: SheetRow): Level | null {
  for (const value of row) {
    const normalized = cleanText(value).toLowerCase();
    if (normalized === "basic" || normalized === "medium" || normalized === "hard") {
      return normalized as Level;
    }
  }

  return null;
}

function getContiguousContentRanges(rows: SheetRow[]): SheetRow[][] {
  const ranges: SheetRow[][] = [];
  let currentRange: SheetRow[] = [];

  for (const row of rows) {
    if (isHeaderRow(row) || hasQuestionContent(row)) {
      currentRange.push(row);
      continue;
    }

    if (currentRange.length > 0) {
      ranges.push(currentRange);
      currentRange = [];
    }
  }

  if (currentRange.length > 0) {
    ranges.push(currentRange);
  }

  return ranges;
}

function splitRowsByLevelMarkers(rows: SheetRow[]): Array<{ level: Level; rows: SheetRow[] }> {
  const markers = rows
    .map((row, index) => ({ index, level: detectLevelMarker(row) }))
    .filter((entry): entry is { index: number; level: Level } => entry.level !== null);

  if (!markers.length) {
    return [];
  }

  return markers.map((marker, index) => {
    const nextIndex = markers[index + 1]?.index ?? rows.length;
    const sectionRows = rows.slice(marker.index + 1, nextIndex);
    return {
      level: marker.level,
      rows: getContiguousContentRanges(sectionRows).flat()
    };
  }).filter((section) => section.rows.length > 0);
}

function parseRows(rows: SheetRow[], level: Level, sheetName: string, importedAt: string): Question[] {
  const questions: Question[] = [];
  let current:
    | {
        sourceQuestionNo: string;
        prompt: string;
        options: string[];
        answerRows: Question["answerRows"];
      }
    | undefined;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    const uniqueOptions: string[] = [];
    const seen = new Set<string>();

    for (const option of current.options) {
      const key = option.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniqueOptions.push(option);
      }
    }

    questions.push({
      id: `${level}-${current.sourceQuestionNo}`,
      level,
      sourceQuestionNo: current.sourceQuestionNo,
      prompt: current.prompt,
      options: uniqueOptions,
      answerRows: current.answerRows,
      sheetName,
      importedAt
    });
  };

  const dataRows = isHeaderRow(rows[0] ?? []) ? rows.slice(1) : rows;

  for (const row of dataRows) {
    const [no, particularsB, particularsA, , answerDropdown, debit, credit] = row;

    if (hasValue(no)) {
      const sourceQuestionNo = formatQuestionNo(no);
      const prompt = cleanText(particularsB);

      if (!current || current.sourceQuestionNo !== sourceQuestionNo) {
        pushCurrent();
        current = {
          sourceQuestionNo,
          prompt,
          options: [],
          answerRows: []
        };
      } else if (prompt && !current.prompt) {
        current.prompt = prompt;
      }
    }

    if (!current) {
      continue;
    }

    const optionText = cleanText(particularsA);
    if (optionText) {
      current.options.push(optionText);
    }

    const answerText = cleanText(answerDropdown);
    const debitAmount = parseAmount(debit);
    const creditAmount = parseAmount(credit);

    if (answerText || debitAmount !== null || creditAmount !== null) {
      current.answerRows.push({
        id: randomUUID(),
        account: answerText,
        debit: debitAmount,
        credit: creditAmount
      });
    }
  }

  pushCurrent();
  return questions.filter((question) => question.prompt && question.options.length > 0);
}

function parseSheet(worksheet: Worksheet, level: Level, sheetName: string, importedAt: string): Question[] {
  return parseRows(worksheetToRows(worksheet), level, sheetName, importedAt);
}

function parseWorkbook(workbook: Workbook): ParsedWorkbook {
  const importedAt = new Date().toISOString();
  const importedLevels: Level[] = [];
  const questions: Question[] = [];

  for (const [sheetName, level] of Object.entries(SHEET_LEVEL_MAP)) {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      continue;
    }

    importedLevels.push(level);
    questions.push(...parseSheet(worksheet, level, sheetName, importedAt));
  }

  if (importedLevels.length === 0) {
    const inferredSections: Array<{ level: Level; rows: SheetRow[]; sheetName: string }> = [];

    for (const worksheet of workbook.worksheets) {
      const rows = worksheetToRows(worksheet);
      const markerSections = splitRowsByLevelMarkers(rows);

      if (markerSections.length > 0) {
        for (const section of markerSections) {
          inferredSections.push({
            level: section.level,
            rows: section.rows,
            sheetName: worksheet.name
          });
        }
        continue;
      }

      const ranges = getContiguousContentRanges(rows);
      ranges.forEach((rangeRows, index) => {
        inferredSections.push({
          level: LEVEL_ORDER[inferredSections.length] as Level,
          rows: rangeRows,
          sheetName: `${worksheet.name} block ${index + 1}`
        });
      });
    }

    if (inferredSections.length === 0) {
      throw new Error("Workbook must include Basic, Medium, Hard sheets or a single-sheet layout with separated level blocks.");
    }

    if (inferredSections.length > LEVEL_ORDER.length) {
      throw new Error("Detected more than three unnamed question blocks. Use explicit Basic, Medium, Hard markers or separate sheets.");
    }

    inferredSections.forEach((section, index) => {
      const level = section.level ?? LEVEL_ORDER[index];
      if (!importedLevels.includes(level)) {
        importedLevels.push(level);
      }
      questions.push(...parseRows(section.rows, level, section.sheetName, importedAt));
    });
  }

  if (importedLevels.length === 0) {
    throw new Error("Workbook must include at least one of these sheets: Basic, Medium, Hard.");
  }

  return { importedLevels, questions };
}

export async function parseWorkbookFromFile(filePath: string): Promise<ParsedWorkbook> {
  if (!existsSync(filePath)) {
    throw new Error(`Workbook not found at ${filePath}`);
  }

  const workbook = new Workbook();
  await workbook.xlsx.readFile(filePath);
  return parseWorkbook(workbook);
}

export async function parseWorkbookFromBuffer(buffer: Buffer): Promise<ParsedWorkbook> {
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as unknown as WorkbookBufferInput);
  return parseWorkbook(workbook);
}
