import { extname } from "node:path";
import { Workbook } from "exceljs";

export interface ImportedStudent {
  registerNumber: string;
  name: string;
  accessDays: number;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isHeaderRow(first: string, second: string, third: string): boolean {
  const firstValue = first.toLowerCase();
  const secondValue = second.toLowerCase();
  const thirdValue = third.toLowerCase();
  const firstLooksLikeName = /name/.test(firstValue);
  const secondLooksLikeName = /name/.test(secondValue);
  const firstLooksLikeEmail = /email|gmail|mail|register|id/.test(firstValue);
  const secondLooksLikeEmail = /email|gmail|mail|register|id/.test(secondValue);
  const thirdLooksLikeAccess = /access|day|days|duration|expiry|expire/.test(thirdValue);

  return thirdLooksLikeAccess && ((firstLooksLikeName && secondLooksLikeEmail) || (secondLooksLikeName && firstLooksLikeEmail));
}

function normalizeStudentIdentity(first: string, second: string): { name: string; email: string } {
  if (looksLikeEmail(first) && !looksLikeEmail(second)) {
    return { name: second, email: first };
  }

  return { name: first, email: second };
}

function normalizeValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
}

function parseAccessDays(value: unknown, rowNumber: number): number {
  const normalized = normalizeValue(value);
  const accessDays = Number(normalized);

  if (!normalized || !Number.isInteger(accessDays) || accessDays < 1) {
    throw new Error(`Row ${rowNumber}: access days must be a whole number greater than 0.`);
  }

  return accessDays;
}

function parseCsv(buffer: Buffer): ImportedStudent[] {
  const rows = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const students: ImportedStudent[] = [];

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 1;
    const [rawFirst = "", rawSecond = "", rawAccessDays = ""] = row.split(",").map((value) => value.trim());
    const first = normalizeValue(rawFirst);
    const second = normalizeValue(rawSecond);

    if (index === 0 && isHeaderRow(first, second, normalizeValue(rawAccessDays))) {
      continue;
    }

    const { name, email } = normalizeStudentIdentity(first, second);

    if (email && name) {
      students.push({
        registerNumber: email,
        name,
        accessDays: parseAccessDays(rawAccessDays, rowNumber)
      });
    }
  }

  return students;
}

async function parseWorkbook(buffer: Buffer): Promise<ImportedStudent[]> {
  const workbook = new Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<Workbook["xlsx"]["load"]>[0]);
  const worksheet = workbook.worksheets[0];

  if (!worksheet) {
    return [];
  }

  const students: ImportedStudent[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const first = normalizeValue(row.getCell(1).text);
    const second = normalizeValue(row.getCell(2).text);
    const accessDaysValue = row.getCell(3).text || row.getCell(3).value;

    if (rowNumber === 1 && isHeaderRow(first, second, normalizeValue(accessDaysValue))) {
      return;
    }

    const { name, email } = normalizeStudentIdentity(first, second);

    if (email && name) {
      students.push({
        registerNumber: email,
        name,
        accessDays: parseAccessDays(accessDaysValue, rowNumber)
      });
    }
  });

  return students;
}

export async function parseStudentRosterFromBuffer(fileName: string, buffer: Buffer): Promise<ImportedStudent[]> {
  const extension = extname(fileName).toLowerCase();

  if (extension === ".csv" || extension === ".txt") {
    return parseCsv(buffer);
  }

  if (extension === ".xlsx") {
    return parseWorkbook(buffer);
  }

  throw new Error("Student upload must be a CSV or XLSX file with name, Gmail/email, and access days columns.");
}
