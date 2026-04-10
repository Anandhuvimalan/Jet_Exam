import { join } from "node:path";
import { QuestionStore } from "../storage/question-store";

async function main() {
  const root = process.cwd();
  const store = new QuestionStore(join(root, "data", "questions.json"));
  await store.initialize();
  await store.seedFromWorkbook(join(root, "Jet questions.xlsx"));
  console.log(`Seeded ${store.getSummary().totalQuestions} questions.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
