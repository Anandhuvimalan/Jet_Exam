import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AttemptDetail,
  AttemptSummary,
  Level,
  QuestionResult,
  StudentDashboardResponse,
  StudentAnswerRow,
  StudentQuestion,
  StudentSubmission
} from "../../shared/types";
import { LEVELS } from "../../shared/types";
import { fetchStudentAttempt, fetchStudentDashboard, getCachedStudentDashboard, startStudentQuiz, submitStudentQuiz } from "../api";
import { MobileMetaRow } from "../components/MobileMetaRow";
import { SurfaceSelect } from "../components/SurfaceSelect";

export type StudentSection = "overview";

type DashState = StudentDashboardResponse;

type ReviewTone = "match" | "error" | "empty";

interface StudentReviewRow {
  i: number;
  account: string;
  debit: string;
  credit: string;
  accountTone: ReviewTone;
  debitTone: ReviewTone;
  creditTone: ReviewTone;
}

interface CorrectReviewRow {
  i: number;
  account: string;
  debit: string;
  credit: string;
  state: "matched" | "reference" | "missed" | "empty";
}

const motionEase = [0.22, 1, 0.36, 1] as const;
const STUDENT_RESULTS_PAGE_SIZES = [5, 10, 20];
const STUDENT_RESULTS_PAGE_SIZE_OPTIONS = STUDENT_RESULTS_PAGE_SIZES.map((size) => ({ label: String(size), value: String(size) }));

interface PickerScrollSnapshot {
  container: HTMLElement | null;
  spacerTarget: HTMLElement;
  spacerPaddingBottom: string;
}

function tc(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }
function emptyRows(n: number): StudentAnswerRow[] { return Array.from({ length: n }, () => ({ account: "", debit: "", credit: "" })); }
function hasAnswer(rows: StudentAnswerRow[]) { return rows.some((r) => r.account || r.debit || r.credit); }
function fa(v: number | null) { return v === null ? "" : String(v); }
function pa(v: string) { const t = v.trim(); if (!t) return 0; const n = Number(t.replace(/,/g, "")); return Number.isFinite(n) ? n : 0; }
function ft(sec: number) { const s = Math.max(0, sec); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function pc(l: string) { return l === "Excellent" ? "perf-badge perf-badge--excellent" : l === "Very Good" ? "perf-badge perf-badge--very-good" : l === "Good" ? "perf-badge perf-badge--good" : "perf-badge perf-badge--poor"; }
function lp(l: string) { return l === "basic" ? "pill pill--emerald" : l === "medium" ? "pill pill--amber" : "pill pill--rose"; }
function ap(days: number) { return days <= 2 ? "pill pill--rose" : days <= 5 ? "pill pill--amber" : "pill pill--sky"; }
function toAttemptSummary(attempt: AttemptDetail): AttemptSummary {
  return {
    id: attempt.attemptId,
    level: attempt.level,
    score: attempt.score,
    totalQuestions: attempt.totalQuestions,
    percentage: attempt.accuracy,
    performanceLabel: attempt.performanceLabel,
    completedAt: attempt.completedAt
  };
}

function wasAttempted(result: QuestionResult) {
  return result.studentRows.some((r) => r.account || r.debit !== null || r.credit !== null);
}

function findScrollableAncestor(node: HTMLElement | null) {
  let current = node?.parentElement ?? null;

  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY === "visible" ? style.overflow : style.overflowY;
    const scrollable = /(auto|scroll|overlay)/.test(overflowY)
      && current.scrollHeight > current.clientHeight;

    if (scrollable) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function capturePickerScrollSnapshot(node: HTMLElement | null): PickerScrollSnapshot {
  const container = findScrollableAncestor(node);
  const spacerTarget = container ?? document.body;

  return {
    container,
    spacerTarget,
    spacerPaddingBottom: spacerTarget.style.paddingBottom
  };
}

function ensurePickerScrollSpace(snapshot: PickerScrollSnapshot | null, requiredSpace: number) {
  if (!snapshot || requiredSpace <= 0) {
    return;
  }

  const currentPaddingBottom = Number.parseFloat(window.getComputedStyle(snapshot.spacerTarget).paddingBottom) || 0;
  snapshot.spacerTarget.style.paddingBottom = `${Math.ceil(currentPaddingBottom + requiredSpace)}px`;
}

function restorePickerScrollSpace(snapshot: PickerScrollSnapshot | null) {
  if (!snapshot) {
    return;
  }

  snapshot.spacerTarget.style.paddingBottom = snapshot.spacerPaddingBottom;
}

function shiftPickerViewportForMenu(snapshot: PickerScrollSnapshot | null, triggerRect: DOMRect, menuHeight: number) {
  const gutter = 12;
  const gap = 8;
  const availableBelow = Math.max(0, window.innerHeight - triggerRect.bottom - gutter - gap);
  const overflow = Math.ceil(menuHeight - availableBelow);

  if (overflow <= 0) {
    return false;
  }

  const delta = overflow + gap;

  if (snapshot?.container) {
    const availableScroll = Math.max(0, snapshot.container.scrollHeight - snapshot.container.clientHeight - snapshot.container.scrollTop);
    if (availableScroll < delta) {
      ensurePickerScrollSpace(snapshot, delta - availableScroll + gap);
    }

    const nextTop = Math.min(
      snapshot.container.scrollHeight - snapshot.container.clientHeight,
      snapshot.container.scrollTop + delta
    );

    if (nextTop <= snapshot.container.scrollTop) {
      return false;
    }

    snapshot.container.scrollTo({
      left: snapshot.container.scrollLeft,
      top: nextTop,
      behavior: "auto"
    });
    return true;
  }

  const scrollingElement = document.scrollingElement;
  const maxTop = scrollingElement ? scrollingElement.scrollHeight - window.innerHeight : window.scrollY;
  const availableScroll = Math.max(0, maxTop - window.scrollY);
  if (availableScroll < delta) {
    ensurePickerScrollSpace(snapshot, delta - availableScroll + gap);
  }

  const nextMaxTop = Math.max(window.scrollY, (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight);
  const nextTop = Math.min(nextMaxTop, window.scrollY + delta);

  if (nextTop <= window.scrollY) {
    return false;
  }

  window.scrollTo({
    left: window.scrollX,
    top: nextTop,
    behavior: "auto"
  });
  return true;
}

function getReviewSize(result: QuestionResult) {
  return Math.max(5, result.studentRows.length, result.correctRows.length);
}

function studentReviewRows(result: QuestionResult): StudentReviewRow[] {
  const size = getReviewSize(result);

  if (!wasAttempted(result)) {
    return Array.from({ length: size }, (_, i) => ({
      i,
      account: "",
      debit: "",
      credit: "",
      accountTone: "empty",
      debitTone: "empty",
      creditTone: "empty"
    }));
  }

  return Array.from({ length: size }, (_, i) => {
    const row = result.studentRows[i];
    if (!row) {
      return { i, account: "", debit: "", credit: "", accountTone: "empty", debitTone: "empty", creditTone: "empty" };
    }

    return {
      i,
      account: row.account,
      debit: fa(row.debit),
      credit: fa(row.credit),
      accountTone: row.accountMatched ? "match" : "error",
      debitTone: row.debitMatched ? "match" : "error",
      creditTone: row.creditMatched ? "match" : "error"
    };
  });
}

function correctReviewRows(result: QuestionResult): CorrectReviewRow[] {
  const size = getReviewSize(result);
  const matchedIds = new Set(
    result.studentRows
      .filter((row) => row.matched && row.referenceRowId)
      .map((row) => row.referenceRowId as string)
  );
  const referencedIds = new Set(
    result.studentRows
      .filter((row) => !row.matched && row.referenceRowId)
      .map((row) => row.referenceRowId as string)
  );

  return Array.from({ length: size }, (_, i) => {
    const row = result.correctRows[i];
    if (!row) return { i, account: "", debit: "", credit: "", state: "empty" as const };

    if (matchedIds.has(row.id)) {
      return { i, account: row.account, debit: fa(row.debit), credit: fa(row.credit), state: "matched" as const };
    }

    if (referencedIds.has(row.id)) {
      return { i, account: row.account, debit: fa(row.debit), credit: fa(row.credit), state: "reference" as const };
    }

    return { i, account: row.account, debit: fa(row.debit), credit: fa(row.credit), state: "missed" as const };
  });
}

function ScoreRing({ score, total, size = 92 }: { score: number; total: number; size?: number }) {
  const r = (size - 10) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? score / total : 0;
  const color = pct >= 0.8 ? "var(--emerald)" : pct >= 0.5 ? "var(--amber)" : "var(--rose)";

  return (
    <div className="score-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="score-ring__bg" cx={size / 2} cy={size / 2} r={r} />
        <circle className="score-ring__fill" cx={size / 2} cy={size / 2} r={r} stroke={color} strokeDasharray={c} strokeDashoffset={c - pct * c} />
      </svg>
      <div className="score-ring__text">
        <span className="score-ring__value">{score}</span>
        <span className="score-ring__label">of {total}</span>
      </div>
    </div>
  );
}

function AccountPicker({
  options,
  value,
  onChange
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef<PickerScrollSnapshot | null>(null);
  const menuTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 36, mass: 0.76 };
  const closeEase = [0.4, 0, 1, 1] as const;
  const menuVariants = {
    open: reduceMotion ? { opacity: 1 } : {
      opacity: 1,
      y: 0,
      transition: {
        y: menuTransition
      }
    },
    closed: reduceMotion ? { opacity: 0 } : {
      opacity: 0,
      y: -8,
      transition: {
        duration: 0.14,
        ease: closeEase
      }
    }
  };
  const optionVariants = {
    open: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.16, ease: motionEase } },
    closed: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.1, ease: closeEase } }
  };
  const menuTargetHeight = Math.min(260, (options.length + 1) * 42 + 20);

  useEffect(() => {
    if (open) {
      setMenuMounted(true);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const updateMenuPosition = () => {
      if (!triggerRef.current) {
        return;
      }

      const triggerRect = triggerRef.current.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const gutter = 12;
      const gap = 8;
      const width = Math.min(triggerRect.width, viewportWidth - gutter * 2);
      const left = Math.max(gutter, Math.min(triggerRect.left, viewportWidth - gutter - width));
      const availableBelow = Math.max(0, viewportHeight - triggerRect.bottom - gutter - gap);
      const maxHeight = Math.min(menuTargetHeight, Math.max(96, availableBelow));
      const top = triggerRect.bottom + gap;

      setMenuStyle({
        left,
        top,
        width,
        maxHeight
      });
    };

    const maybeShiftViewport = () => {
      if (!triggerRef.current) {
        return false;
      }

      return shiftPickerViewportForMenu(
        scrollSnapshotRef.current,
        triggerRef.current.getBoundingClientRect(),
        menuTargetHeight
      );
    };

    const focusTrigger = () => {
      try {
        triggerRef.current?.focus({ preventScroll: true });
      } catch {
        triggerRef.current?.focus();
      }
    };

    let nestedAnimationFrame = 0;
    const animationFrame = window.requestAnimationFrame(() => {
      updateMenuPosition();
      maybeShiftViewport();
      nestedAnimationFrame = window.requestAnimationFrame(() => {
        updateMenuPosition();
        focusTrigger();
      });
    });
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(nestedAnimationFrame);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [menuTargetHeight, open]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && event.button !== 0) {
        return;
      }

      if (!(event.target instanceof Node)) return;
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <div className={`account-picker ${menuMounted ? "account-picker--layered" : ""} ${open ? "account-picker--open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`account-picker__trigger ${value ? "" : "account-picker__trigger--placeholder"}`}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }

          scrollSnapshotRef.current = capturePickerScrollSnapshot(triggerRef.current);
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span>{value || "Select account"}</span>
        <motion.svg
          animate={{ rotate: open ? 180 : 0, y: open ? 1 : 0 }}
          height="14"
          transition={menuTransition}
          viewBox="0 0 24 24"
          width="14"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
        >
          <path d="m6 9 6 6 6-6" />
        </motion.svg>
      </button>

      {menuMounted && menuStyle ? createPortal(
        <motion.div
          animate={open ? "open" : "closed"}
          className="account-picker__menu account-picker__menu--floating"
          initial="closed"
          onAnimationComplete={() => {
            if (!open) {
              restorePickerScrollSpace(scrollSnapshotRef.current);
              scrollSnapshotRef.current = null;
              setMenuStyle(null);
              setMenuMounted(false);
            }
          }}
          ref={menuRef}
          role="listbox"
          style={menuStyle}
          variants={menuVariants}
        >
          <motion.button
            aria-selected={!value}
            className={`account-picker__option ${!value ? "account-picker__option--active" : ""}`}
            onClick={() => { onChange(""); setOpen(false); }}
            role="option"
            type="button"
            variants={optionVariants}
          >
            Clear selection
          </motion.button>
          {options.map((option) => (
            <motion.button
              aria-selected={value === option}
              className={`account-picker__option ${value === option ? "account-picker__option--active" : ""}`}
              key={option}
              onClick={() => { onChange(option); setOpen(false); }}
              role="option"
              type="button"
              variants={optionVariants}
            >
              {option}
            </motion.button>
          ))}
        </motion.div>,
        document.body
      ) : null}
    </div>
  );
}

const QUIZ_STORAGE_KEY = "jet-active-quiz";

interface PersistedQuizState {
  quizId: string;
  quizLevel: Level;
  questions: StudentQuestion[];
  answers: Record<string, StudentAnswerRow[]>;
  idx: number;
  expiresAt: string;
}

function loadPersistedQuiz(): PersistedQuizState | null {
  try {
    const raw = sessionStorage.getItem(QUIZ_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedQuizState;
    if (!parsed.quizId || !parsed.expiresAt || !parsed.questions?.length) return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      sessionStorage.removeItem(QUIZ_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistQuizState(state: PersistedQuizState | null) {
  if (!state) {
    sessionStorage.removeItem(QUIZ_STORAGE_KEY);
    return;
  }
  try {
    sessionStorage.setItem(QUIZ_STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded — ignore */ }
}

export function StudentPage() {
  const reduceMotion = useReducedMotion();
  const cachedDashboard = getCachedStudentDashboard();
  const persisted = useMemo(loadPersistedQuiz, []);
  const [dash, setDash] = useState<DashState | null>(cachedDashboard);
  const [quizId, setQuizId] = useState<string | null>(persisted?.quizId ?? null);
  const [quizLevel, setQuizLevel] = useState<Level | null>(persisted?.quizLevel ?? null);
  const [questions, setQuestions] = useState<StudentQuestion[]>(persisted?.questions ?? []);
  const [answers, setAnswers] = useState<Record<string, StudentAnswerRow[]>>(persisted?.answers ?? {});
  const [idx, setIdx] = useState(persisted?.idx ?? 0);
  const [expiresAt, setExpiresAt] = useState<string | null>(persisted?.expiresAt ?? null);
  const [secs, setSecs] = useState<number | null>(persisted?.expiresAt ? Math.max(0, Math.floor((new Date(persisted.expiresAt).getTime() - Date.now()) / 1000)) : null);
  const [attempt, setAttempt] = useState<AttemptDetail | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [submitConfirmOpen, setSubmitConfirmOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rIdx, setRIdx] = useState(0);
  const [resultsPage, setResultsPage] = useState(1);
  const [resultsPageSize, setResultsPageSize] = useState(STUDENT_RESULTS_PAGE_SIZES[0]);
  const [loading, setLoading] = useState(!cachedDashboard);
  const [submitting, setSubmitting] = useState(false);
  const [attemptLoadingState, setAttemptLoadingState] = useState<{ id: string; review: boolean } | null>(null);
  const [error, setError] = useState("");

  const reviewRef = useRef<HTMLElement | null>(null);
  const resultSheetRef = useRef<HTMLElement | null>(null);

  const q = questions[idx];
  const activeAnswerRows = q ? answers[q.id] ?? [] : [];
  const rq = attempt?.questionResults[rIdx] ?? null;
  const answered = useMemo(() => questions.filter((x) => hasAnswer(answers[x.id] ?? [])).length, [answers, questions]);
  const bw = useMemo(() => {
    if (!q) return null;
    if (!activeAnswerRows.some((r) => r.account || r.debit || r.credit)) return null;
    const d = activeAnswerRows.reduce((s, r) => s + pa(r.debit), 0);
    const c = activeAnswerRows.reduce((s, r) => s + pa(r.credit), 0);
    return Math.abs(d - c) < 0.0001 ? null : { d, c };
  }, [activeAnswerRows, q]);

  useEffect(() => {
    if (quizId && quizLevel && expiresAt && questions.length) {
      persistQuizState({ quizId, quizLevel, questions, answers, idx, expiresAt });
    } else if (!quizId) {
      persistQuizState(null);
    }
  }, [quizId, quizLevel, questions, answers, idx, expiresAt]);

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        if (!dash) {
          setLoading(true);
        }

        const nextDashboard = await fetchStudentDashboard();
        if (!active) {
          return;
        }

        setDash(nextDashboard);
        setError("");
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : "Load failed.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const submitQuiz = async (auto = false) => {
    if (!quizId || submitting) return;

    try {
      setSubmitting(true);
      const submissions: StudentSubmission[] = questions.map((x) => ({ questionId: x.id, rows: answers[x.id] ?? [] }));
      const result = await submitStudentQuiz(quizId, submissions);
      const nextAttemptSummary = toAttemptSummary(result.attempt);
      setAttempt(result.attempt);
      setResultOpen(true);
      setReviewOpen(false);
      setRIdx(0);
      setDash((current) => current
        ? {
            ...current,
            pastScores: result.pastScores ?? [nextAttemptSummary, ...current.pastScores.filter((entry) => entry.id !== nextAttemptSummary.id)]
          }
        : current);
      setQuizId(null);
      setQuizLevel(null);
      setExpiresAt(null);
      setSecs(null);
      setQuestions([]);
      setAnswers({});
      setSubmitConfirmOpen(false);
      setError("");
      void fetchStudentDashboard()
        .then((nextDashboard) => {
          setDash(nextDashboard);
        })
        .catch(() => {
          // Keep the optimistic score list if the background refresh fails.
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submit failed.");
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!quizId || !expiresAt || submitting) return;
    const iv = window.setInterval(() => {
      const secondsRemaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSecs(secondsRemaining);
      if (secondsRemaining === 0) void submitQuiz(true);
    }, 1000);
    return () => window.clearInterval(iv);
  }, [expiresAt, quizId, submitting, questions, answers]);

  useEffect(() => {
    if (!quizId || !questions.length) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (event.target instanceof HTMLInputElement || event.target.closest(".account-picker")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIdx((current) => Math.max(0, current - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setIdx((current) => Math.min(questions.length - 1, current + 1));
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [quizId, questions.length]);

  useEffect(() => {
    const sheet = resultSheetRef.current;
    if (!resultOpen || !sheet || reviewOpen) return;

    const animationFrame = window.requestAnimationFrame(() => {
      sheet.scrollTo({
        top: 0,
        behavior: "auto"
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [resultOpen, reviewOpen, attempt?.attemptId]);

  useEffect(() => {
    const sheet = resultSheetRef.current;
    const reviewNode = reviewRef.current;
    if (!reviewOpen || !rq || !sheet || !reviewNode) return;

    const animationFrame = window.requestAnimationFrame(() => {
      const sheetRect = sheet.getBoundingClientRect();
      const reviewRect = reviewNode.getBoundingClientRect();
      const top = sheet.scrollTop + reviewRect.top - sheetRect.top - 120;
      sheet.scrollTo({
        top: Math.max(0, top),
        behavior: reduceMotion ? "auto" : "smooth"
      });
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [reduceMotion, reviewOpen, rIdx, rq?.questionId]);

  useEffect(() => {
    if (!resultOpen && !submitConfirmOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [resultOpen, submitConfirmOpen]);

  useEffect(() => {
    setResultsPage((current) => Math.min(current, Math.max(1, Math.ceil((dash?.pastScores.length ?? 0) / resultsPageSize))));
  }, [dash?.pastScores.length, resultsPageSize]);

  const [startingLevel, setStartingLevel] = useState<Level | null>(null);

  const startQuiz = async (level: Level) => {
    try {
      // Use inline spinner per mode card instead of full-page loading state
      setStartingLevel(level);
      setError("");
      const result = await startStudentQuiz(level);
      setQuizId(result.quizId);
      setQuizLevel(result.level);
      setExpiresAt(result.expiresAt);
      setSecs(Math.max(0, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000)));
      setQuestions(result.questions);
      setAnswers(Object.fromEntries(result.questions.map((x) => [x.id, emptyRows(x.answerSlotCount)])));
      setAttempt(null);
      setResultOpen(false);
      setSubmitConfirmOpen(false);
      setReviewOpen(false);
      setRIdx(0);
      setIdx(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Start failed.");
    } finally {
      setStartingLevel(null);
    }
  };

  const updateRow = (qid: string, ri: number, field: keyof StudentAnswerRow, value: string) => {
    setAnswers((current) => {
      const rows = [...(current[qid] ?? [])];
      rows[ri] = { ...rows[ri], [field]: value };
      return { ...current, [qid]: rows };
    });
  };

  const loadAttempt = async (id: string, openReview = false) => {
    if (attemptLoadingState || submitting) {
      return;
    }

    try {
      setAttemptLoadingState({ id, review: openReview });
      const nextAttempt = await fetchStudentAttempt(id);
      setAttempt(nextAttempt);
      setResultOpen(true);
      setReviewOpen(openReview);
      setRIdx(0);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
    } finally {
      setAttemptLoadingState((current) => current?.id === id ? null : current);
    }
  };

  const closeResult = () => {
    setResultOpen(false);
    setReviewOpen(false);
    setRIdx(0);
  };

  const requestSubmit = () => {
    if (submitting) return;
    setSubmitConfirmOpen(true);
  };

  const quizProgress = questions.length ? Math.round((answered / questions.length) * 100) : 0;
  const latestAttempt = dash?.pastScores[0] ?? null;
  const attempts = dash?.pastScores ?? [];
  const attemptsCount = attempts.length;
  const modeInsights = LEVELS.map((level) => {
    const levelAttempts = attempts.filter((attemptItem) => attemptItem.level === level);
    const questionCount = dash?.questionSummary.levels.find((entry) => entry.level === level)?.count ?? 0;
    const latestByMode = levelAttempts[0] ? `${levelAttempts[0].score}/${levelAttempts[0].totalQuestions}` : "--";

    return {
      level,
      questionCount,
      attemptsCount: levelAttempts.length,
      latestLabel: latestByMode
    };
  });
  const modeInsightsByLevel = new Map(modeInsights.map((modeInsight) => [modeInsight.level, modeInsight]));
  const averagePercentage = attemptsCount ? attempts.reduce((sum, attemptItem) => sum + attemptItem.percentage, 0) / attemptsCount : null;
  const dashboardTitle = "Overview";
  const dashboardCopy = "Pick a mode, start a timed paper, and review recent results without bouncing around the workspace.";
  const averageLabel = averagePercentage !== null ? `${(averagePercentage * 100).toFixed(1)}%` : "--";
  const accessDaysLeft = dash?.student.remainingAccessDays ?? 0;
  const accessDaysLabel = dash ? `${accessDaysLeft} day${accessDaysLeft === 1 ? "" : "s"} left` : "--";
  const accessExpiryLabel = dash ? new Date(dash.student.accessExpiresAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "--";
  const latestAttemptCompletedLabel = latestAttempt
    ? new Date(latestAttempt.completedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "--";
  const dashboardSummary = [
    {
      label: "Attempts",
      value: String(attemptsCount),
      detail: attemptsCount ? `${attemptsCount === 1 ? "1 paper completed" : `${attemptsCount} papers completed`}` : "No attempts yet"
    },
    {
      label: "Average score",
      value: averageLabel,
      detail: latestAttempt ? `${latestAttempt.performanceLabel} on your latest paper` : "Complete a paper to unlock trends"
    },
    {
      label: "Last result",
      value: latestAttempt ? `${latestAttempt.score}/${latestAttempt.totalQuestions}` : "--",
      detail: latestAttempt ? `${tc(latestAttempt.level)} mode | ${latestAttempt.performanceLabel}` : "Complete a paper to see the last score"
    }
  ];
  const highlightedAttemptId = attempt?.attemptId ?? latestAttempt?.id ?? null;
  const attemptLoadingId = attemptLoadingState?.id ?? null;
  const resultAccuracyLabel = attempt ? `${(attempt.accuracy * 100).toFixed(1)}%` : "--";
  const resultModeLabel = attempt ? tc(attempt.level) : "--";
  const resultsTotalPages = Math.max(1, Math.ceil(attempts.length / resultsPageSize));
  const paginatedAttempts = attempts.slice((resultsPage - 1) * resultsPageSize, resultsPage * resultsPageSize);
  const resultsStart = attempts.length === 0 ? 0 : (resultsPage - 1) * resultsPageSize + 1;
  const resultsEnd = Math.min(resultsPage * resultsPageSize, attempts.length);
  const modeCards = LEVELS.map((level) => {
    const modeInsight = modeInsightsByLevel.get(level);
    const count = modeInsight?.questionCount ?? 0;
    const available = count > 0;
    const isStarting = startingLevel === level;
    const disabled = loading || Boolean(startingLevel) || !available || Boolean(quizId);
    const modeHistoryLabel = modeInsight?.attemptsCount
      ? `${modeInsight.attemptsCount} attempt${modeInsight.attemptsCount === 1 ? "" : "s"} in this mode | Last ${modeInsight.latestLabel}`
      : "No attempts in this mode yet";

    return (
      <motion.article
        aria-disabled={disabled}
        className={`student-mode-card student-mode-card--${level} ${disabled ? "student-mode-card--disabled" : "student-mode-card--active"}`}
        key={level}
        whileHover={reduceMotion || disabled ? undefined : { y: -5, scale: 1.01 }}
      >
        <div className="student-mode-card__head">
          <span className="student-mode-card__tag">{tc(level)}</span>
          <span className={`student-mode-card__state ${quizId || !available ? "student-mode-card__state--muted" : ""}`}>
            {isStarting ? "Starting..." : quizId ? "Active test running" : available ? "Ready" : "Unavailable"}
          </span>
        </div>

        <div className="student-mode-card__metrics">
          <strong className="student-mode-card__count">{count}</strong>
          <span className="student-mode-card__count-label">questions available</span>
        </div>

        <p className="student-mode-card__copy">
          {isStarting
            ? "Setting up your timed paper. This should only take a moment."
            : quizId
            ? "Finish the current paper before starting another mode."
            : available
              ? "Timed paper ready to launch whenever you are."
              : "This mode is currently unavailable."}
        </p>

        <div className="student-mode-card__history">{modeHistoryLabel}</div>

        <div className="student-mode-card__footer">
          <button
            className={`button button--sm ${disabled ? "" : "button--primary"} student-mode-card__cta ${isStarting ? "student-mode-card__launch--busy" : ""}`}
            disabled={disabled}
            onClick={() => void startQuiz(level)}
            type="button"
          >
            {isStarting ? <span aria-hidden="true" className="student-mode-card__spinner" /> : null}
            {isStarting ? "Starting exam" : quizId ? "One live paper at a time" : available ? "Start exam" : "Waiting for upload"}
          </button>
          <span className="student-mode-card__time">{dash?.settings.timeLimitMinutes ?? 0} min</span>
        </div>
      </motion.article>
    );
  });
  const pageTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 340, damping: 32, mass: 0.84 };
  const panelTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 360, damping: 34, mass: 0.82 };
  const overlayTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 380, damping: 36, mass: 0.8 };
  const overlayRoot = typeof document !== "undefined" ? document.body : null;

  return (
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      className="stack student-page"
      initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
      transition={pageTransition}
    >
      {error ? <div className="banner banner--error">{error}</div> : null}
      {loading && !quizId ? <div className="loading-bar" /> : null}

      {!quizId && !dash && loading ? (
        <motion.section
          animate={{ opacity: 1, y: 0 }}
          className="panel student-dashboard student-dashboard--loading"
          initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
          transition={panelTransition}
        >
          <div className="student-dashboard__header student-dashboard__header--loading">
            <div className="student-dashboard__header-copy">
              <span className="eyebrow">Loading workspace</span>
              <h3>Preparing your dashboard.</h3>
              <p className="section-copy">We are loading your access, recent results, and available test modes.</p>
            </div>
          </div>
        </motion.section>
      ) : null}

      <AnimatePresence initial={false} mode="sync">
        {quizId && q ? (
          <motion.section
            animate={{ opacity: 1, y: 0 }}
            className="panel student-console"
            exit={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
            initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
            key="student-active-exam"
            transition={panelTransition}
          >
            <aside className="student-console__rail">
              <div className="student-console__rail-block">
                <span className="eyebrow">Active exam</span>
                <strong>{quizLevel ? `${tc(quizLevel)} level` : "Timed set"}</strong>
                <p>You started this paper from the dashboard. Fill the journal rows and submit before time runs out.</p>
              </div>

              <div className={`timer-display ${secs !== null && secs <= 60 ? "timer-display--urgent" : ""}`}>{secs !== null ? ft(secs) : "--:--"}</div>

              <div className="student-console__stats">
                <div className="student-console__stat">
                  <span>Answered</span>
                  <strong>{answered}/{questions.length}</strong>
                </div>
                <div className="student-console__stat">
                  <span>Progress</span>
                  <strong>{quizProgress}%</strong>
                </div>
              </div>

              <div className="student-console__rail-block">
                <div className="student-console__nav-head">
                  <span>Question map</span>
                  <strong>{idx + 1}/{questions.length}</strong>
                </div>

                <div className="question-dots">
                  {questions.map((item, index) => (
                    <button className={`question-dot ${hasAnswer(answers[item.id] ?? []) ? "question-dot--answered" : ""} ${index === idx ? "question-dot--active" : ""}`} key={item.id} onClick={() => setIdx(index)} type="button">
                      {index + 1}
                    </button>
                  ))}
                </div>
              </div>

              <div className="student-console__rail-foot">
                <div className="pill pill--emerald rail__summary-pill">{answered} / {questions.length} answered</div>
                <p className="student-console__note">The exam submits automatically when the timer reaches zero.</p>
                <button className="button button--primary button--block" disabled={submitting} onClick={requestSubmit} type="button">
                  {submitting ? "Submitting..." : "Submit Exam"}
                </button>
              </div>
            </aside>

            <div className="student-console__main">
                <div className="student-console__head">
                  <div className="student-console__headline">
                    <span className="eyebrow">Question {idx + 1} of {questions.length}</span>
                  <h3>{q.prompt}</h3>
                </div>

                <div className="student-console__badges">
                  {quizLevel ? <span className={lp(quizLevel)}>{tc(quizLevel)}</span> : null}
                  <span className="pill">{questions.length - answered} remaining</span>
                </div>
              </div>

              <div className="student-console__particulars">
                <div className="student-console__particulars-head">
                  <span className="option-bank__label">Available particulars</span>
                  <span className="pill pill--sky">Pick directly from the list</span>
                </div>
                <div className="chip-list">{q.options.map((option) => <span className="chip" key={option}>{option}</span>)}</div>
              </div>

              <div className="student-console__entry">
                <div className="review-table-card__head">
                  <strong>Journal entry</strong>
                  <span className="pill pill--indigo">{hasAnswer(activeAnswerRows) ? "Draft in progress" : "Blank answer"}</span>
                </div>

                <div className="journal-mobile-cards">
                  {activeAnswerRows.map((row, rowIndex) => (
                    <article className="journal-mobile-card" key={`mobile-${q.id}-${rowIndex}`}>
                      <div className="journal-mobile-card__head">
                        <strong>Row {rowIndex + 1}</strong>
                        <span className="pill pill--mono">Entry slot</span>
                      </div>

                      <label className="journal-mobile-field">
                        <span>Particular</span>
                        <AccountPicker
                          onChange={(next) => updateRow(q.id, rowIndex, "account", next)}
                          options={q.options}
                          value={row.account}
                        />
                      </label>

                      <div className="journal-mobile-card__amounts">
                        <label className="journal-mobile-field">
                          <span>Debit</span>
                          <input inputMode="decimal" onChange={(e) => updateRow(q.id, rowIndex, "debit", e.target.value)} placeholder="0.00" value={row.debit} />
                        </label>

                        <label className="journal-mobile-field">
                          <span>Credit</span>
                          <input inputMode="decimal" onChange={(e) => updateRow(q.id, rowIndex, "credit", e.target.value)} placeholder="0.00" value={row.credit} />
                        </label>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="journal-table-wrap journal-table-wrap--desktop student-console__table">
                  <table className="journal-table">
                    <thead><tr><th>#</th><th>Particular</th><th>Debit</th><th>Credit</th></tr></thead>
                    <tbody>
                      {activeAnswerRows.map((row, rowIndex) => (
                        <tr key={`${q.id}-${rowIndex}`}>
                          <td>{rowIndex + 1}</td>
                          <td>
                            <AccountPicker
                              onChange={(next) => updateRow(q.id, rowIndex, "account", next)}
                              options={q.options}
                              value={row.account}
                            />
                          </td>
                          <td><input inputMode="decimal" onChange={(e) => updateRow(q.id, rowIndex, "debit", e.target.value)} placeholder="0.00" value={row.debit} /></td>
                          <td><input inputMode="decimal" onChange={(e) => updateRow(q.id, rowIndex, "credit", e.target.value)} placeholder="0.00" value={row.credit} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {bw ? <div className="journal-warning">Debit ({bw.d.toLocaleString()}) does not equal Credit ({bw.c.toLocaleString()})</div> : null}

                <div className="student-console__pager pager">
                  <button className="button" disabled={idx === 0} onClick={() => setIdx((current) => Math.max(0, current - 1))} type="button">Previous</button>
                  <button className="button button--primary" disabled={idx === questions.length - 1} onClick={() => setIdx((current) => Math.min(questions.length - 1, current + 1))} type="button">Next</button>
                </div>
              </div>
            </div>
          </motion.section>
        ) : !dash && loading ? null : (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="student-home"
            exit={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
            initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
            key="student-dashboard"
            transition={panelTransition}
          >
            <section className="panel student-dashboard">
              <div className="student-dashboard__header">
                <div className="student-dashboard__header-copy">
                  <span className="eyebrow">Student dashboard</span>
                  <h3>{dashboardTitle}</h3>
                  <p className="section-copy">{dashboardCopy}</p>
                </div>

                <div className="student-dashboard__header-meta">
                  <span className={dash ? ap(accessDaysLeft) : "pill"}>{accessDaysLabel}</span>
                  <small>Access until {accessExpiryLabel}</small>
                </div>
              </div>

              <div className="student-dashboard__summary-strip">
                {dashboardSummary.map((item) => (
                  <article className="student-dashboard__summary-card" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.detail}</small>
                  </article>
                ))}
              </div>

              <div className="student-dashboard__layout">
                <section className="student-dashboard__modes">
                  <div className="student-dashboard__section-head">
                    <div>
                      <span className="eyebrow">Start test</span>
                      <h4>Choose your mode</h4>
                    </div>

                    <div className="inline-metrics">
                      <span className="pill pill--amber">{dash?.settings.timeLimitMinutes ?? "--"} min</span>
                    </div>
                  </div>

                  <div className="student-levels student-levels--dashboard">
                    {modeCards}
                  </div>

                </section>

                <aside className="student-dashboard__side">
                  <section className="student-performance-card">
                    <div className="student-performance-card__head">
                      <div>
                        <span className="eyebrow">Performance</span>
                        <h4>Latest test performance</h4>
                      </div>

                      {latestAttempt ? <span className={lp(latestAttempt.level)}>{tc(latestAttempt.level)}</span> : null}
                    </div>

                    {latestAttempt ? (
                      <>
                        <div className="score-display student-performance-card__score">
                          <ScoreRing score={latestAttempt.score} total={latestAttempt.totalQuestions} size={84} />
                          <div className="student-records__focus-meta">
                            <strong>{latestAttempt.score}/{latestAttempt.totalQuestions}</strong>
                            <span>{tc(latestAttempt.level)} mode</span>
                            <small>Completed {latestAttemptCompletedLabel}</small>
                          </div>
                        </div>

                        <div className="student-performance-card__metrics">
                          <div className="student-performance-card__metric">
                            <span>Accuracy</span>
                            <strong>{(latestAttempt.percentage * 100).toFixed(1)}%</strong>
                          </div>
                          <div className="student-performance-card__metric">
                            <span>Result</span>
                            <strong>{latestAttempt.performanceLabel}</strong>
                          </div>
                        </div>
                      </>
                    ) : (
                      <p className="section-copy">Complete a test to see your progress, average, and review history here.</p>
                    )}

                    {latestAttempt ? (
                      <div className="student-performance-card__actions">
                        <button
                          className="button button--sm"
                          disabled={attemptLoadingId === latestAttempt.id && !attemptLoadingState?.review}
                          onClick={() => void loadAttempt(latestAttempt.id)}
                          type="button"
                        >
                          {attemptLoadingId === latestAttempt.id && !attemptLoadingState?.review ? (
                            <>
                              <span aria-hidden="true" className="student-mode-card__spinner" />
                              Opening...
                            </>
                          ) : (
                            "Open last result"
                          )}
                        </button>
                        <button
                          className="button button--sm button--primary"
                          disabled={attemptLoadingId === latestAttempt.id && Boolean(attemptLoadingState?.review)}
                          onClick={() => void loadAttempt(latestAttempt.id, true)}
                          type="button"
                        >
                          {attemptLoadingId === latestAttempt.id && Boolean(attemptLoadingState?.review) ? (
                            <>
                              <span aria-hidden="true" className="student-mode-card__spinner" />
                              Loading review...
                            </>
                          ) : (
                            "Review answers"
                          )}
                        </button>
                      </div>
                    ) : null}
                  </section>
                </aside>
              </div>
            </section>

            <section className="panel student-records">
              <div className="student-records__head">
                <div>
                  <span className="eyebrow">History</span>
                  <h3>Recent results</h3>
                </div>

                <div className="inline-metrics">
                  <span className="pill pill--sky">{attemptsCount} attempts</span>
                </div>
              </div>

              <div className="student-records__table">
                <div className="table-wrap table-wrap--mobile-hide">
                  <table className="admin-table">
                    <thead><tr><th>Date</th><th>Mode</th><th>Score</th><th>Result</th><th></th></tr></thead>
                    <tbody>
                      {paginatedAttempts.map((attemptSummary) => (
                        <tr
                          className={`attempt-row ${highlightedAttemptId === attemptSummary.id ? "attempt-row--active" : ""}`}
                          key={attemptSummary.id}
                          onClick={() => void loadAttempt(attemptSummary.id)}
                        >
                          <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{new Date(attemptSummary.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
                          <td><span className={lp(attemptSummary.level)}>{tc(attemptSummary.level)}</span></td>
                          <td style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{attemptSummary.score}/{attemptSummary.totalQuestions}</td>
                          <td><span className={pc(attemptSummary.performanceLabel)}>{attemptSummary.performanceLabel}</span></td>
                          <td>
                            <button
                              className="button button--sm"
                              disabled={attemptLoadingId === attemptSummary.id && Boolean(attemptLoadingState?.review)}
                              onClick={(event) => { event.stopPropagation(); void loadAttempt(attemptSummary.id, true); }}
                              type="button"
                            >
                              {attemptLoadingId === attemptSummary.id && Boolean(attemptLoadingState?.review) ? (
                                <>
                                  <span aria-hidden="true" className="student-mode-card__spinner" />
                                  Loading...
                                </>
                              ) : (
                                "Review"
                              )}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!dash?.pastScores.length ? <tr><td colSpan={5} className="empty-state">No attempts yet.</td></tr> : null}
                    </tbody>
                  </table>
                </div>

                <div className="mobile-table-cards">
                  {paginatedAttempts.map((attemptSummary) => (
                    <article className={`mobile-table-card ${highlightedAttemptId === attemptSummary.id ? "mobile-table-card--active" : ""}`} key={`student-mobile-${attemptSummary.id}`}>
                      <div className="mobile-table-card__head">
                        <div className="mobile-table-card__title">
                          <strong>{new Date(attemptSummary.completedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</strong>
                          <small>{new Date(attemptSummary.completedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</small>
                        </div>

                        <div className="mobile-table-card__badges">
                          <span className={lp(attemptSummary.level)}>{tc(attemptSummary.level)}</span>
                          <span className={pc(attemptSummary.performanceLabel)}>{attemptSummary.performanceLabel}</span>
                        </div>
                      </div>

                      <div className="mobile-table-card__meta">
                        <MobileMetaRow
                          icon="calendar"
                          label="Completed"
                          value={new Date(attemptSummary.completedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        />
                        <MobileMetaRow icon="score" label="Score" value={`${attemptSummary.score}/${attemptSummary.totalQuestions}`} />
                      </div>

                      <div className="mobile-table-card__actions">
                        <button
                          className="button button--sm"
                          disabled={attemptLoadingId === attemptSummary.id && !attemptLoadingState?.review}
                          onClick={() => void loadAttempt(attemptSummary.id)}
                          type="button"
                        >
                          {attemptLoadingId === attemptSummary.id && !attemptLoadingState?.review ? (
                            <>
                              <span aria-hidden="true" className="student-mode-card__spinner" />
                              Opening...
                            </>
                          ) : (
                            "Open result"
                          )}
                        </button>
                        <button
                          className="button button--sm button--primary"
                          disabled={attemptLoadingId === attemptSummary.id && Boolean(attemptLoadingState?.review)}
                          onClick={() => void loadAttempt(attemptSummary.id, true)}
                          type="button"
                        >
                          {attemptLoadingId === attemptSummary.id && Boolean(attemptLoadingState?.review) ? (
                            <>
                              <span aria-hidden="true" className="student-mode-card__spinner" />
                              Loading...
                            </>
                          ) : (
                            "Review"
                          )}
                        </button>
                      </div>
                    </article>
                  ))}
                  {!dash?.pastScores.length ? <div className="mobile-table-empty">No attempts yet.</div> : null}
                </div>
              </div>

              <div className="pagination-bar">
                <div className="pagination-bar__summary">
                  <strong>Results</strong>
                  <span>
                    {resultsStart}-{resultsEnd} of {attempts.length}
                  </span>
                </div>

                <div className="pagination-bar__controls">
                  <label className="pagination-bar__size">
                    <span>Rows</span>
                    <SurfaceSelect
                      ariaLabel="Student results rows per page"
                      compact
                      onChange={(next) => {
                        setResultsPageSize(Number(next));
                        setResultsPage(1);
                      }}
                      options={STUDENT_RESULTS_PAGE_SIZE_OPTIONS}
                      placeholder="Rows"
                      value={String(resultsPageSize)}
                    />
                  </label>

                  <div className="pagination-bar__buttons">
                    <button className="button button--sm" disabled={resultsPage <= 1} onClick={() => setResultsPage((current) => Math.max(1, current - 1))} type="button">
                      Prev
                    </button>
                    <span className="pill pill--mono">
                      {resultsPage} / {resultsTotalPages}
                    </span>
                    <button className="button button--sm" disabled={resultsPage >= resultsTotalPages} onClick={() => setResultsPage((current) => Math.min(resultsTotalPages, current + 1))} type="button">
                      Next
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </motion.div>
        )}
      </AnimatePresence>

      {overlayRoot ? createPortal(
        <>
          <AnimatePresence>
            {resultOpen && attempt ? (
              <motion.div
                animate={{ opacity: 1 }}
                className="student-result-overlay"
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={overlayTransition}
              >
                <button
                  aria-label="Close result sheet"
                  className="student-result-overlay__backdrop"
                  onClick={closeResult}
                  type="button"
                />

                <motion.div
                  animate={{ opacity: 1, y: 0 }}
                  className="student-result-overlay__frame"
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
                  transition={overlayTransition}
                >
                  <button aria-label="Close result sheet" className="student-result-overlay__close" onClick={closeResult} type="button">
                    <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
                      <path d="M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                      <path d="m6 6 12 12" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                    </svg>
                  </button>

                  <motion.section className="panel student-result-sheet" ref={resultSheetRef}>
                    <div className="student-result-sheet__head">
                      <div>
                        <span className="eyebrow">Result</span>
                        <h3>{attempt.performanceLabel}</h3>
                      </div>

                      <div className="student-result-sheet__head-actions">
                        <span className={lp(attempt.level)}>{tc(attempt.level)} mode</span>
                      </div>
                    </div>

                    <div className="student-result-sheet__body">
                      <div className="student-result-sheet__summary">
                        <div className="score-display">
                          <ScoreRing score={attempt.score} total={attempt.totalQuestions} />
                          <div className="student-records__focus-meta">
                            <strong>{attempt.score}/{attempt.totalQuestions}</strong>
                            <span>{tc(attempt.level)} mode | {new Date(attempt.completedAt).toLocaleString()}</span>
                          </div>
                        </div>

                        <div className="student-result-sheet__metrics">
                          <div className="student-result-sheet__metric">
                            <span>Mode</span>
                            <strong>{resultModeLabel}</strong>
                          </div>
                          <div className="student-result-sheet__metric">
                            <span>Accuracy</span>
                            <strong>{resultAccuracyLabel}</strong>
                          </div>
                          <div className="student-result-sheet__metric">
                            <span>Correct</span>
                            <strong>{attempt.correctQuestions}</strong>
                          </div>
                          <div className="student-result-sheet__metric">
                            <span>Wrong</span>
                            <strong>{attempt.wrongQuestions}</strong>
                          </div>
                        </div>
                      </div>

                      <div className="student-result-sheet__actions">
                        <button className="button button--primary" onClick={() => { setReviewOpen((current) => !current); setRIdx(0); }} type="button">
                          {reviewOpen ? "Hide Review" : "Review Answers"}
                        </button>
                        <button className="button" onClick={closeResult} type="button">Back to dashboard</button>
                      </div>

                      {reviewOpen && rq ? (
                        <motion.article
                          animate={{ opacity: 1, y: 0 }}
                          className={`result-card student-review-shell ${rq.isCorrect ? "result-card--correct" : ""}`}
                          initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
                          ref={reviewRef}
                          transition={panelTransition}
                        >
                          <div className="result-card__head">
                            <div>
                              <span className="eyebrow">Review {rIdx + 1} / {attempt.questionResults.length}</span>
                              <h4>{rq.prompt}</h4>
                            </div>
                            <span className={wasAttempted(rq) ? (rq.isCorrect ? "pill pill--emerald" : "pill pill--rose") : "pill pill--amber"}>
                              {wasAttempted(rq) ? (rq.isCorrect ? "Correct" : "Incorrect") : "Not attempted"}
                            </span>
                          </div>

                          {!wasAttempted(rq) ? (
                            <div className="not-attempted-banner">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                              No answer was submitted for this question.
                            </div>
                          ) : null}

                          <div className="review-grid">
                            <section className="review-table-card">
                              <div className="review-table-card__head">
                                <strong>Your Answer</strong>
                                <span className="pill pill--rose" style={{ fontSize: 11 }}>Cell errors marked</span>
                              </div>

                              <div className="journal-table-wrap">
                                <table className="journal-table">
                                  <thead><tr><th>#</th><th>Particular</th><th>Debit</th><th>Credit</th></tr></thead>
                                  <tbody>
                                    {studentReviewRows(rq).map((row) => (
                                      <tr key={`student-review-${row.i}`}>
                                        <td>{row.i + 1}</td>
                                        <td className={`journal-table__cell journal-table__cell--${row.accountTone}`}>{row.account || "\u2014"}</td>
                                        <td className={`journal-table__cell journal-table__cell--${row.debitTone}`} style={{ fontFamily: "var(--font-mono)" }}>{row.debit || "\u2014"}</td>
                                        <td className={`journal-table__cell journal-table__cell--${row.creditTone}`} style={{ fontFamily: "var(--font-mono)" }}>{row.credit || "\u2014"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </section>

                            <section className="review-table-card">
                              <div className="review-table-card__head">
                                <strong>Expected Answer</strong>
                                <span className="pill pill--emerald" style={{ fontSize: 11 }}>Reference rows</span>
                              </div>

                              <div className="journal-table-wrap">
                                <table className="journal-table">
                                  <thead><tr><th>#</th><th>Particular</th><th>Debit</th><th>Credit</th></tr></thead>
                                  <tbody>
                                    {correctReviewRows(rq).map((row) => (
                                      <tr className={`journal-table__row--${row.state}`} key={`correct-review-${row.i}`}>
                                        <td>{row.i + 1}</td>
                                        <td>{row.account || "\u2014"}</td>
                                        <td style={{ fontFamily: "var(--font-mono)" }}>{row.debit || "\u2014"}</td>
                                        <td style={{ fontFamily: "var(--font-mono)" }}>{row.credit || "\u2014"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </section>
                          </div>

                          <div className="pager">
                            <button className="button" disabled={rIdx === 0} onClick={() => setRIdx((current) => Math.max(0, current - 1))} type="button">Previous</button>
                            <button className="button button--primary" disabled={rIdx === attempt.questionResults.length - 1} onClick={() => setRIdx((current) => Math.min(attempt.questionResults.length - 1, current + 1))} type="button">Next</button>
                          </div>
                        </motion.article>
                      ) : null}
                    </div>
                  </motion.section>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {submitConfirmOpen ? (
              <motion.div
                animate={{ opacity: 1 }}
                className="student-result-overlay student-result-overlay--dialog"
                exit={{ opacity: 0 }}
                initial={{ opacity: 0 }}
                transition={overlayTransition}
              >
                <button
                  aria-label="Close submit confirmation"
                  className="student-result-overlay__backdrop"
                  onClick={() => setSubmitConfirmOpen(false)}
                  type="button"
                />

                <motion.section
                  animate={{ opacity: 1, y: 0 }}
                  className="panel student-submit-dialog"
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
                  transition={overlayTransition}
                >
                  <span className="eyebrow">Confirm submit</span>
                  <h3>Submit this exam now?</h3>
                  <p>Your answers will be locked and the result sheet will open immediately after submission.</p>

                  <div className="student-submit-dialog__actions">
                    <button className="button" onClick={() => setSubmitConfirmOpen(false)} type="button">
                      Continue exam
                    </button>
                    <button
                      className="button button--primary"
                      disabled={submitting}
                      onClick={() => {
                        setSubmitConfirmOpen(false);
                        void submitQuiz(false);
                      }}
                      type="button"
                    >
                      {submitting ? "Submitting..." : "Submit now"}
                    </button>
                  </div>
                </motion.section>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </>,
        overlayRoot
      ) : null}
    </motion.section>
  );
}
