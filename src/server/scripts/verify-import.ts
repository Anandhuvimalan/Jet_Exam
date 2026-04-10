import { join } from "node:path";
import { parseWorkbookFromFile } from "../import/workbook";

async function main() {
  const parsed = await parseWorkbookFromFile(join(process.cwd(), "Jet questions.xlsx"));
  const counts = parsed.importedLevels.map((level) => ({
    level,
    count: parsed.questions.filter((question) => question.level === level).length
  }));

  console.log(JSON.stringify({ total: parsed.questions.length, counts }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
