import { Link } from "react-router-dom";
import { LEVELS, type SummaryResponse } from "../../shared/types";

function titleCase(input: string): string {
  return input.charAt(0).toUpperCase() + input.slice(1);
}

export function HomePage({ summary }: { summary: SummaryResponse | null }) {
  return (
    <section className="stack">
      <div className="hero panel">
        <div className="hero__copy">
          <span className="eyebrow">Structured practice for journal entries</span>
          <h1>Students answer matrix-based accounting questions while admins control the workbook import and bank.</h1>
          <p>
            The platform reads the same Excel format you already use, groups questions by difficulty level, and shows
            full correct versus wrong results after submission.
          </p>
        </div>
        <div className="hero__actions">
          <Link className="button button--primary" to="/student">
            Start Student Flow
          </Link>
          <Link className="button" to="/admin">
            Open Admin Console
          </Link>
        </div>
      </div>

      <div className="stats">
        <article className="panel stat">
          <span className="stat__label">Total question bank</span>
          <strong className="stat__value">{summary?.totalQuestions ?? "--"}</strong>
        </article>
        <article className="panel stat">
          <span className="stat__label">Workbook imported</span>
          <strong className="stat__value stat__value--small">
            {summary?.lastImportedAt ? new Date(summary.lastImportedAt).toLocaleString() : "Waiting for import"}
          </strong>
        </article>
      </div>

      <div className="level-grid">
        {LEVELS.map((level) => (
          <article className="panel level-card" key={level}>
            <span className="level-card__tag">{titleCase(level)}</span>
            <strong className="level-card__count">
              {summary?.levels.find((entry) => entry.level === level)?.count ?? 0}
            </strong>
            <p className="level-card__meta">questions available in the {titleCase(level)} workbook sheet.</p>
          </article>
        ))}
      </div>
    </section>
  );
}
