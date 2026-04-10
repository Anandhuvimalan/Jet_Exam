import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { createPortal } from "react-dom";
import type {
  AdminAssistantMessage,
  AdminDashboardResponse,
  AdminListResponse,
  AdminQuestionsResponse,
  AdminRosterEntry,
  AdminStudentsResponse,
  AuthenticatedAdmin,
  Level,
  PaginationMeta,
  Question,
  StudentRosterEntry
} from "../../shared/types";
import { LEVELS } from "../../shared/types";
import {
  bulkDeleteAdminStudents,
  bulkDeleteManagedAdmins,
  bulkDeleteQuestions,
  clearAllAdminStudents,
  clearAllQuestions,
  clearLevel,
  createAdminQuestion,
  createAdminStudent,
  createManagedAdmin,
  deleteAdminStudent,
  deleteManagedAdmin,
  deleteQuestion,
  fetchAdminDashboard,
  getCachedAdminDashboard,
  getCachedAdminList,
  getCachedAdminQuestions,
  getCachedAdminStudents,
  fetchAdminList,
  fetchAdminQuestions,
  fetchAdminStudents,
  sendAdminAssistantMessage,
  updateAdminQuestion,
  updateAdminStudent,
  updateManagedAdmin,
  updateAdminSettings,
  uploadQuestionWorkbook,
  uploadStudentRoster
} from "../api";
import { MobileMetaRow } from "../components/MobileMetaRow";
import { SurfaceSelect } from "../components/SurfaceSelect";

export type AdminSection = "overview" | "assistant" | "questions" | "students" | "admins";

interface AdminPageProps {
  user: AuthenticatedAdmin;
  section: AdminSection;
}

interface DraftAnswerRow {
  account: string;
  debit: string;
  credit: string;
}

interface StudentDraft {
  email: string;
  name: string;
  accessDays: string;
}

interface AdminDraft {
  name: string;
  email: string;
}

interface UploadProgressState {
  fileName: string;
  percent: number;
  phase: "uploading" | "processing";
}

interface AdminConfirmState {
  eyebrow: string;
  title: string;
  description: string;
  confirmLabel: string;
  confirmTone?: "danger" | "default";
  onConfirm: () => Promise<void>;
}

interface PickerOption {
  value: string;
  label: string;
}

interface PickerScrollSnapshot {
  container: HTMLElement | null;
  spacerTarget: HTMLElement;
  spacerPaddingBottom: string;
}

const motionEase = [0.22, 1, 0.36, 1] as const;
const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
const ADMIN_SECTION_META: Record<AdminSection, { label: string; eyebrow: string; title: string; copy: string }> = {
  overview: {
    label: "Overview",
    eyebrow: "Admin workspace",
    title: "Admin workspace",
    copy: ""
  },
  assistant: {
    label: "AI Bot",
    eyebrow: "Admin assistant",
    title: "AI bot",
    copy: ""
  },
  questions: {
    label: "Questions",
    eyebrow: "Question bank",
    title: "Question bank",
    copy: ""
  },
  students: {
    label: "Students",
    eyebrow: "Student access",
    title: "Manage students",
    copy: ""
  },
  admins: {
    label: "Admins",
    eyebrow: "Super admin controls",
    title: "Manage admins",
    copy: ""
  }
};

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function emptyDraftAnswerRow(): DraftAnswerRow {
  return { account: "", debit: "", credit: "" };
}

function createEmptyQuestionDraft(level: Level = "basic") {
  return {
    level,
    sourceQuestionNo: "",
    prompt: "",
    options: "",
    answerRows: [emptyDraftAnswerRow(), emptyDraftAnswerRow()]
  };
}

function createEmptyStudentDraft(): StudentDraft {
  return {
    email: "",
    name: "",
    accessDays: ""
  };
}

function createEmptyAdminDraft(): AdminDraft {
  return {
    name: "",
    email: ""
  };
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

function parseAmount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function levelPill(level: string) {
  if (level === "basic") return "pill pill--emerald";
  if (level === "medium") return "pill pill--amber";
  return "pill pill--rose";
}

function dashboardSummaryLevels(dashboard: AdminDashboardResponse | null) {
  return dashboard?.questionSummary.levels ?? [];
}

function questionToDraft(question: Question) {
  return {
    level: question.level,
    sourceQuestionNo: question.sourceQuestionNo,
    prompt: question.prompt,
    options: question.options.join("\n"),
    answerRows:
      question.answerRows.length > 0
        ? question.answerRows.map((row) => ({
            account: row.account,
            debit: row.debit === null ? "" : String(row.debit),
            credit: row.credit === null ? "" : String(row.credit)
          }))
        : [emptyDraftAnswerRow(), emptyDraftAnswerRow()]
  };
}

function formatShortDate(value: string) {
  return new Date(value).toLocaleDateString();
}

function formatAccessDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function accessStatusPill(status: "active" | "expired") {
  return status === "active" ? "pill pill--emerald" : "pill pill--rose";
}

function matchesCurrentPageSelection(ids: string[], selectedIds: string[]) {
  return ids.length > 0 && ids.every((id) => selectedIds.includes(id));
}

function PaginationControls({
  pagination,
  label,
  onPageChange,
  onPageSizeChange
}: {
  pagination: PaginationMeta;
  label: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const start = pagination.totalItems === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(pagination.page * pagination.pageSize, pagination.totalItems);
  const pageSizeOptions = PAGE_SIZE_OPTIONS.map((size) => ({ label: String(size), value: String(size) }));

  return (
    <div className="pagination-bar">
      <div className="pagination-bar__summary">
        <strong>{label}</strong>
        <span>
          {start}-{end} of {pagination.totalItems}
        </span>
      </div>

      <div className="pagination-bar__controls">
        <label className="pagination-bar__size">
          <span>Rows</span>
          <SurfaceSelect
            ariaLabel={`${label} rows per page`}
            compact
            onChange={(next) => onPageSizeChange(Number(next))}
            options={pageSizeOptions}
            placeholder="Rows"
            value={String(pagination.pageSize)}
          />
        </label>

        <div className="pagination-bar__buttons">
          <button className="button button--sm" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)} type="button">
            Prev
          </button>
          <span className="pill pill--mono">
            {pagination.page} / {pagination.totalPages}
          </span>
          <button
            className="button button--sm"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => onPageChange(pagination.page + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectionToggle({
  checked,
  compact = false,
  disabled = false,
  label,
  onChange
}: {
  checked: boolean;
  compact?: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label className={`selection-toggle ${compact ? "selection-toggle--compact" : ""} ${checked ? "selection-toggle--checked" : ""} ${disabled ? "selection-toggle--disabled" : ""}`}>
      <input checked={checked} className="selection-toggle__input" disabled={disabled} onChange={onChange} type="checkbox" />
      <span aria-hidden="true" className="selection-toggle__indicator">
        <svg fill="none" height="12" viewBox="0 0 16 16" width="12">
          <path d="m3.5 8 2.8 2.8L12.5 4.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      </span>
      {compact ? <span className="sr-only">{label}</span> : <span className="selection-toggle__label">{checked ? "Selected" : label}</span>}
    </label>
  );
}

function UploadProgress({ state }: { state: UploadProgressState | null }) {
  if (!state) {
    return null;
  }

  const progressLabel = state.phase === "processing" ? "Processing file..." : `Uploading ${state.percent}%`;
  const progressValue = state.phase === "processing" ? "Syncing" : `${state.percent}%`;

  return (
    <div aria-live="polite" className="upload-progress" role="status">
      <div className="upload-progress__meta">
        <div className="upload-progress__copy">
          <strong>{progressLabel}</strong>
          <span>{state.fileName}</span>
        </div>
        <span className="upload-progress__value">{progressValue}</span>
      </div>
      <div aria-hidden="true" className="upload-progress__track">
        <span style={{ width: `${state.phase === "processing" ? 100 : state.percent}%` }} />
      </div>
    </div>
  );
}

function OptionPicker({
  options,
  value,
  onChange,
  placeholder,
  allowClear = true
}: {
  options: PickerOption[];
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  allowClear?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuActive, setMenuActive] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{
    left: number;
    top: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const reduceMotion = Boolean(useReducedMotion());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef<PickerScrollSnapshot | null>(null);
  const menuTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 36, mass: 0.76 };
  const selectedOption = options.find((option) => option.value === value);
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
      y: -10,
      transition: {
        duration: 0.18,
        ease: motionEase
      }
    }
  };
  const optionVariants = {
    open: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
    closed: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6 }
  };
  const menuTargetHeight = Math.min(260, Math.max(1, options.length + (allowClear ? 1 : 0)) * 42 + 20);

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

      setMenuStyle({
        left,
        top: triggerRect.bottom + gap,
        width,
        maxHeight: Math.min(menuTargetHeight, Math.max(96, availableBelow))
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
  }, [allowClear, menuTargetHeight, open, options.length]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setMenuActive(true);
    }
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
  };

  return (
    <div className={`account-picker ${menuActive ? "account-picker--open" : ""}`} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className={`account-picker__trigger ${value ? "" : "account-picker__trigger--placeholder"}`}
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          scrollSnapshotRef.current = capturePickerScrollSnapshot(triggerRef.current);
          setMenuActive(true);
          setOpen(true);
        }}
        ref={triggerRef}
        type="button"
      >
        <span>{selectedOption?.label || value || placeholder}</span>
        <motion.svg
          animate={{ rotate: open ? 180 : 0, y: open ? 1 : 0 }}
          fill="none"
          height="14"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          transition={menuTransition}
          viewBox="0 0 24 24"
          width="14"
        >
          <path d="m6 9 6 6 6-6" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {open && menuStyle ? createPortal(
          <motion.div
            animate="open"
            className="account-picker__menu account-picker__menu--floating"
            exit="closed"
            initial="closed"
            onAnimationComplete={(definition) => {
              if (definition === "closed") {
                restorePickerScrollSpace(scrollSnapshotRef.current);
                scrollSnapshotRef.current = null;
                setMenuActive(false);
                setMenuStyle(null);
              }
            }}
            ref={menuRef}
            role="listbox"
            style={menuStyle}
            variants={menuVariants}
          >
            {allowClear ? (
              <motion.button
                aria-selected={!value}
                className={`account-picker__option ${!value ? "account-picker__option--active" : ""}`}
                onClick={() => { onChange(""); closeMenu(); }}
                role="option"
                type="button"
                variants={optionVariants}
              >
                Clear selection
              </motion.button>
            ) : null}

            {options.length ? (
              options.map((option) => (
                <motion.button
                  aria-selected={value === option.value}
                  className={`account-picker__option ${value === option.value ? "account-picker__option--active" : ""}`}
                  key={option.value}
                  onClick={() => { onChange(option.value); closeMenu(); }}
                  role="option"
                  type="button"
                  variants={optionVariants}
                >
                  {option.label}
                </motion.button>
              ))
            ) : (
              <motion.button
                className="account-picker__option"
                disabled
                type="button"
                variants={optionVariants}
              >
                No options available
              </motion.button>
            )}
          </motion.div>,
          document.body
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function AdminPage({ user, section }: AdminPageProps) {
  const reduceMotion = useReducedMotion();
  const meta = ADMIN_SECTION_META[section];
  const showSectionHero = section !== "assistant";
  const initialQuestionPageSize = PAGE_SIZE_OPTIONS[0];
  const cachedDashboard = getCachedAdminDashboard();
  const cachedQuestions = getCachedAdminQuestions(undefined, "", 1, initialQuestionPageSize);
  const cachedStudents = getCachedAdminStudents({ search: "", page: 1, pageSize: initialQuestionPageSize });
  const cachedAdmins = user.isSuperAdmin
    ? getCachedAdminList({ search: "", page: 1, pageSize: initialQuestionPageSize })
    : null;
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("admin-console-sidebar") !== "hidden";
  });
  const [isCompactViewport, setIsCompactViewport] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 980;
  });
  const [dashboard, setDashboard] = useState<AdminDashboardResponse | null>(cachedDashboard);
  const [questionsResponse, setQuestionsResponse] = useState<AdminQuestionsResponse | null>(cachedQuestions);
  const [studentsResponse, setStudentsResponse] = useState<AdminStudentsResponse | null>(cachedStudents);
  const [adminsResponse, setAdminsResponse] = useState<AdminListResponse | null>(cachedAdmins);
  const [levelFilter, setLevelFilter] = useState<Level | undefined>();
  const [questionSearch, setQuestionSearch] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [adminSearch, setAdminSearch] = useState("");
  const [questionPage, setQuestionPage] = useState(1);
  const [studentPage, setStudentPage] = useState(1);
  const [adminPage, setAdminPage] = useState(1);
  const [questionPageSize, setQuestionPageSize] = useState<number>(initialQuestionPageSize);
  const [studentPageSize, setStudentPageSize] = useState<number>(initialQuestionPageSize);
  const [adminPageSize, setAdminPageSize] = useState<number>(initialQuestionPageSize);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([]);
  const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
  const [selectedAdminIds, setSelectedAdminIds] = useState<string[]>([]);
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [editingStudentId, setEditingStudentId] = useState<string | null>(null);
  const [editingAdminId, setEditingAdminId] = useState<string | null>(null);
  const [qLimitDraft, setQLimitDraft] = useState(() => String(cachedDashboard?.settings.questionsPerQuiz ?? 20));
  const [tLimitDraft, setTLimitDraft] = useState(() => String(cachedDashboard?.settings.timeLimitMinutes ?? 30));
  const [newQuestion, setNewQuestion] = useState(createEmptyQuestionDraft());
  const [newStudent, setNewStudent] = useState(createEmptyStudentDraft());
  const [editingStudentDraft, setEditingStudentDraft] = useState(createEmptyStudentDraft());
  const [newAdmin, setNewAdmin] = useState(createEmptyAdminDraft());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [assistantMessages, setAssistantMessages] = useState<AdminAssistantMessage[]>([]);
  const [assistantDraft, setAssistantDraft] = useState("");
  const [assistantLoading, setAssistantLoading] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [questionUploadState, setQuestionUploadState] = useState<UploadProgressState | null>(null);
  const [studentUploadState, setStudentUploadState] = useState<UploadProgressState | null>(null);
  const [confirmState, setConfirmState] = useState<AdminConfirmState | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [studentEditLoading, setStudentEditLoading] = useState(false);
  const mainScrollRef = useRef<HTMLDivElement | null>(null);
  const assistantLogRef = useRef<HTMLDivElement | null>(null);
  const assistantInputRef = useRef<HTMLTextAreaElement | null>(null);

  const springTransition = { type: "spring" as const, stiffness: 340, damping: 32, mass: 0.84 };
  const pageTransition = reduceMotion ? { duration: 0 } : springTransition;
  const panelTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 360, damping: 34, mass: 0.82 };
  const sectionTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 350, damping: 34, mass: 0.82 };
  const drawerTransition = reduceMotion ? { duration: 0 } : { type: "spring" as const, stiffness: 360, damping: 34, mass: 0.8 };
  const sectionInitial = reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 };
  const sectionAnimate = { opacity: 1, y: 0 };
  const sectionExit = reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 };
  const questions = questionsResponse?.questions ?? [];
  const students = studentsResponse?.students ?? [];
  const admins = adminsResponse?.admins ?? [];
  const levelOptions = useMemo<PickerOption[]>(
    () => LEVELS.map((level) => ({ value: level, label: titleCase(level) })),
    []
  );
  const particularOptions = useMemo<PickerOption[]>(() => {
    const seen = new Set<string>();
    return [...newQuestion.options.split(/\r?\n|,/), ...newQuestion.answerRows.map((row) => row.account)]
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) {
          return false;
        }

        seen.add(key);
        return true;
      })
      .map((value) => ({ value, label: value }));
  }, [newQuestion.answerRows, newQuestion.options]);
  const selectableAdminIds = admins.filter((adminItem) => adminItem.id !== user.id).map((adminItem) => adminItem.id);
  const totalStudents = dashboard?.studentsCount ?? studentsResponse?.pagination.totalItems ?? 0;
  const totalQuestions = dashboard?.questionSummary.totalQuestions ?? 0;
  const adminsCount = dashboard?.adminsCount ?? (user.isSuperAdmin ? adminsResponse?.pagination.totalItems ?? 1 : 0);
  const levelMax = Math.max(...dashboardSummaryLevels(dashboard).map((entry) => entry.count), 1);
  const allQuestionsSelected = useMemo(
    () => matchesCurrentPageSelection(questions.map((question) => question.id), selectedQuestionIds),
    [questions, selectedQuestionIds]
  );
  const allStudentsSelected = useMemo(
    () => matchesCurrentPageSelection(students.map((student) => student.id), selectedStudentIds),
    [students, selectedStudentIds]
  );
  const allAdminsSelected = useMemo(
    () => matchesCurrentPageSelection(selectableAdminIds, selectedAdminIds),
    [selectableAdminIds, selectedAdminIds]
  );
  const adminNavItems = [
    { key: "overview" as const, to: "/admin/overview", label: "Overview" },
    { key: "questions" as const, to: "/admin/questions", label: "Questions" },
    { key: "students" as const, to: "/admin/students", label: "Students" },
    ...(user.isSuperAdmin ? [{ key: "admins" as const, to: "/admin/admins", label: "Admins" }] : []),
    { key: "assistant" as const, to: "/admin/assistant", label: "AI Bot" }
  ];

  const withPending = async <T,>(action: () => Promise<T>): Promise<T> => action();

  const loadDashboard = async () => {
    const nextDashboard = await withPending(() => fetchAdminDashboard());
    setDashboard(nextDashboard);
    setQLimitDraft(String(nextDashboard.settings.questionsPerQuiz));
    setTLimitDraft(String(nextDashboard.settings.timeLimitMinutes));
  };

  const loadQuestions = async () => {
    const response = await withPending(() => fetchAdminQuestions(levelFilter, questionSearch, questionPage, questionPageSize));
    setQuestionsResponse(response);
  };

  const loadStudents = async () => {
    const response = await withPending(() => fetchAdminStudents({ search: studentSearch, page: studentPage, pageSize: studentPageSize }));
    setStudentsResponse(response);
  };

  const loadAdmins = async () => {
    if (!user.isSuperAdmin) {
      setAdminsResponse(null);
      return;
    }

    const response = await withPending(() => fetchAdminList({ search: adminSearch, page: adminPage, pageSize: adminPageSize }));
    setAdminsResponse(response);
  };

  const refreshVisibleData = async () => {
    const tasks: Array<Promise<unknown>> = [loadDashboard()];
    if (section === "questions") tasks.push(loadQuestions());
    if (section === "students") tasks.push(loadStudents());
    if (section === "admins" && user.isSuperAdmin) tasks.push(loadAdmins());
    await Promise.all(tasks);
  };

  useEffect(() => {
    if (dashboard) {
      return;
    }

    void (async () => {
      try {
        await loadDashboard();
        setError("");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load admin workspace.");
      }
    })();
  }, [dashboard]);

  useEffect(() => {
    if (section !== "questions") {
      return;
    }

    const cachedResponse = getCachedAdminQuestions(levelFilter, questionSearch, questionPage, questionPageSize);
    if (cachedResponse) {
      setQuestionsResponse(cachedResponse);
    }

    void (async () => {
      try {
        await loadQuestions();
        setError("");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load question bank.");
      }
    })();
  }, [section, levelFilter, questionSearch, questionPage, questionPageSize]);

  useEffect(() => {
    if (section !== "students") {
      return;
    }

    const cachedResponse = getCachedAdminStudents({ search: studentSearch, page: studentPage, pageSize: studentPageSize });
    if (cachedResponse) {
      setStudentsResponse(cachedResponse);
    }

    void (async () => {
      try {
        await loadStudents();
        setError("");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load students.");
      }
    })();
  }, [section, studentSearch, studentPage, studentPageSize]);

  useEffect(() => {
    if (section !== "admins" || !user.isSuperAdmin) {
      return;
    }

    const cachedResponse = getCachedAdminList({ search: adminSearch, page: adminPage, pageSize: adminPageSize });
    if (cachedResponse) {
      setAdminsResponse(cachedResponse);
    }

    void (async () => {
      try {
        await loadAdmins();
        setError("");
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to load admin accounts.");
      }
    })();
  }, [section, user.isSuperAdmin, adminSearch, adminPage, adminPageSize]);

  useEffect(() => {
    if (!message) return;
    const timeoutId = setTimeout(() => setMessage(""), 5000);
    return () => clearTimeout(timeoutId);
  }, [message]);

  useEffect(() => {
    const log = assistantLogRef.current;
    if (!log) {
      return;
    }

    log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, [assistantMessages, assistantLoading, reduceMotion]);

  useEffect(() => {
    const input = assistantInputRef.current;
    if (!input) {
      return;
    }

    const maxHeight = isCompactViewport ? 170 : 220;
    const minHeight = isCompactViewport ? 52 : 68;
    input.style.height = "0px";
    const nextHeight = Math.min(input.scrollHeight, maxHeight);
    input.style.height = `${Math.max(nextHeight, minHeight)}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [assistantDraft, isCompactViewport, section]);

  useEffect(() => {
    window.localStorage.setItem("admin-console-sidebar", sidebarOpen ? "visible" : "hidden");
  }, [sidebarOpen]);

  useEffect(() => {
    if (!confirmState) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmLoading) {
        setConfirmState(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmLoading, confirmState]);

  useEffect(() => {
    if (!editingStudentId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !studentEditLoading) {
        cancelStudentEdit();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editingStudentId, studentEditLoading]);

  useEffect(() => {
    const handleResize = () => setIsCompactViewport(window.innerWidth <= 980);
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const main = mainScrollRef.current;
    if (!main) {
      return;
    }

    main.scrollTo({ top: 0, behavior: "auto" });
  }, [section]);

  useEffect(() => {
    if (section !== "students" && editingStudentId && !studentEditLoading) {
      setEditingStudentId(null);
      setEditingStudentDraft(createEmptyStudentDraft());
    }
  }, [editingStudentId, section, studentEditLoading]);

  useEffect(() => {
    setQuestionPage(1);
  }, [levelFilter, questionSearch]);

  useEffect(() => {
    setStudentPage(1);
  }, [studentSearch]);

  useEffect(() => {
    setAdminPage(1);
  }, [adminSearch]);

  const run = async (action: () => Promise<void>, successMessage: string) => {
    try {
      await withPending(action);
      setMessage(successMessage);
      setError("");
      await refreshVisibleData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Action failed.");
    }
  };

  const openConfirmation = (nextState: AdminConfirmState) => {
    setConfirmLoading(false);
    setConfirmState(nextState);
  };

  const closeConfirmation = () => {
    if (confirmLoading) {
      return;
    }

    setConfirmState(null);
  };

  const handleConfirmation = async () => {
    if (!confirmState || confirmLoading) {
      return;
    }

    setConfirmLoading(true);
    try {
      await confirmState.onConfirm();
      setConfirmState(null);
    } finally {
      setConfirmLoading(false);
    }
  };

  const submitAssistantPrompt = async (presetMessage?: string) => {
    const nextMessage = (presetMessage ?? assistantDraft).trim();
    if (!nextMessage || assistantLoading) {
      return;
    }

    const userMessage: AdminAssistantMessage = { role: "user", content: nextMessage };
    const history = assistantMessages.slice(-8);

    setAssistantMessages((current) => [...current, userMessage]);
    setAssistantDraft("");
    setAssistantLoading(true);
    setAssistantError("");

    try {
      const response = await withPending(() => sendAdminAssistantMessage(nextMessage, history));
      setAssistantMessages((current) => [...current, { role: "assistant", content: response.reply }]);
    } catch (nextError) {
      const nextMessageText = nextError instanceof Error ? nextError.message : "Assistant request failed.";
      setAssistantError(nextMessageText);
      setAssistantMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: `I couldn't complete that request right now. ${nextMessageText}`
        }
      ]);
    } finally {
      setAssistantLoading(false);
    }
  };

  const updateDraftRow = (index: number, field: keyof DraftAnswerRow, value: string) => {
    setNewQuestion((current) => ({
      ...current,
      answerRows: current.answerRows.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row)
    }));
  };

  const addDraftRow = () => {
    setNewQuestion((current) => ({ ...current, answerRows: [...current.answerRows, emptyDraftAnswerRow()] }));
  };

  const removeDraftRow = (index: number) => {
    setNewQuestion((current) => ({
      ...current,
      answerRows:
        current.answerRows.length === 1
          ? [emptyDraftAnswerRow()]
          : current.answerRows.filter((_, rowIndex) => rowIndex !== index)
    }));
  };

  const buildQuestionPayload = () => {
    const parsedRows = newQuestion.answerRows
      .map((row) => {
        const debit = parseAmount(row.debit);
        const credit = parseAmount(row.credit);

        if ((row.debit.trim() && debit === null) || (row.credit.trim() && credit === null)) {
          throw new Error("Use valid debit and credit amounts.");
        }

        return {
          account: row.account.trim(),
          debit,
          credit
        };
      })
      .filter((row) => row.account || row.debit !== null || row.credit !== null);

    return {
      level: newQuestion.level,
      sourceQuestionNo: newQuestion.sourceQuestionNo.trim() || undefined,
      prompt: newQuestion.prompt,
      options: newQuestion.options
        .split(/\r?\n|,/)
        .map((option) => option.trim())
        .filter(Boolean),
      answerRows: parsedRows
    };
  };

  const submitQuestionDraft = async () => {
    try {
      const payload = buildQuestionPayload();

      await run(async () => {
        if (editingQuestionId) {
          await updateAdminQuestion(editingQuestionId, payload);
        } else {
          await createAdminQuestion(payload);
        }

        setNewQuestion(createEmptyQuestionDraft(payload.level));
        setEditingQuestionId(null);
      }, editingQuestionId ? "Question updated." : "Question added.");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save question.");
    }
  };

  const submitStudentDraft = async () => {
    await run(async () => {
      await createAdminStudent({
        email: newStudent.email,
        name: newStudent.name,
        accessDays: Number(newStudent.accessDays)
      });
      setNewStudent(createEmptyStudentDraft());
    }, "Student added.");
  };

  const submitStudentEdit = async () => {
    if (!editingStudentId || studentEditLoading) {
      return;
    }

    setStudentEditLoading(true);
    try {
      await updateAdminStudent(editingStudentId, {
        email: editingStudentDraft.email,
        name: editingStudentDraft.name,
        accessDaysToAdd: editingStudentDraft.accessDays.trim() ? Number(editingStudentDraft.accessDays) : undefined
      });
      setMessage("Student updated.");
      setError("");
      setEditingStudentId(null);
      setEditingStudentDraft(createEmptyStudentDraft());
      await refreshVisibleData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save student.");
    } finally {
      setStudentEditLoading(false);
    }
  };

  const submitAdminDraft = async () => {
    await run(async () => {
      if (editingAdminId) {
        await updateManagedAdmin(editingAdminId, {
          name: newAdmin.name,
          email: newAdmin.email
        });
      } else {
        await createManagedAdmin(newAdmin.name, newAdmin.email);
      }

      setNewAdmin(createEmptyAdminDraft());
      setEditingAdminId(null);
    }, editingAdminId ? "Admin updated." : "Admin account added.");
  };

  const toggleQuestionSelection = (id: string) => {
    setSelectedQuestionIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const toggleAllQuestions = () => {
    setSelectedQuestionIds((current) => {
      if (allQuestionsSelected) {
        return current.filter((id) => !questions.some((question) => question.id === id));
      }

      return [...new Set([...current, ...questions.map((question) => question.id)])];
    });
  };

  const toggleStudentSelection = (id: string) => {
    setSelectedStudentIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const toggleAllStudents = () => {
    setSelectedStudentIds((current) => {
      if (allStudentsSelected) {
        return current.filter((id) => !students.some((student) => student.id === id));
      }

      return [...new Set([...current, ...students.map((student) => student.id)])];
    });
  };

  const toggleAdminSelection = (id: string) => {
    setSelectedAdminIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const toggleAllAdmins = () => {
    setSelectedAdminIds((current) => {
      if (allAdminsSelected) {
        return current.filter((id) => !selectableAdminIds.includes(id));
      }

      return [...new Set([...current, ...selectableAdminIds])];
    });
  };

  const beginQuestionEdit = (question: Question) => {
    setEditingQuestionId(question.id);
    setNewQuestion(questionToDraft(question));
  };

  const cancelQuestionEdit = () => {
    setEditingQuestionId(null);
    setNewQuestion(createEmptyQuestionDraft(newQuestion.level));
  };

  const beginStudentEdit = (student: { id: string; email: string; name: string }) => {
    setEditingStudentId(student.id);
    setEditingStudentDraft({ email: student.email, name: student.name, accessDays: "" });
  };

  const cancelStudentEdit = () => {
    if (studentEditLoading) {
      return;
    }

    setEditingStudentId(null);
    setEditingStudentDraft(createEmptyStudentDraft());
  };

  const beginAdminEdit = (adminItem: AdminRosterEntry) => {
    setEditingAdminId(adminItem.id);
    setNewAdmin({ name: adminItem.name, email: adminItem.email });
  };

  const cancelAdminEdit = () => {
    setEditingAdminId(null);
    setNewAdmin(createEmptyAdminDraft());
  };

  const importQuestionWorkbook = (file: File | undefined) => {
    if (!file || questionUploadState) return;
    setQuestionUploadState({ fileName: file.name, percent: 0, phase: "uploading" });
    setError("");

    void (async () => {
      try {
        const result = await withPending(() => uploadQuestionWorkbook(file, {
          onProgress: (percent) => {
            setQuestionUploadState((current) => current ? { ...current, percent, phase: "uploading" } : current);
          },
          onUploadComplete: () => {
            setQuestionUploadState((current) => current ? { ...current, percent: 100, phase: "processing" } : current);
          }
        }));
        setMessage(`Workbook processed. ${result.importedQuestions} added, ${result.skippedQuestions} skipped.`);
        setError("");
        await refreshVisibleData();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to import workbook.");
      } finally {
        setQuestionUploadState(null);
      }
    })();
  };

  const importStudentRoster = (file: File | undefined) => {
    if (!file || studentUploadState) return;
    setStudentUploadState({ fileName: file.name, percent: 0, phase: "uploading" });
    setError("");

    void (async () => {
      try {
        const result = await withPending(() => uploadStudentRoster(file, {
          onProgress: (percent) => {
            setStudentUploadState((current) => current ? { ...current, percent, phase: "uploading" } : current);
          },
          onUploadComplete: () => {
            setStudentUploadState((current) => current ? { ...current, percent: 100, phase: "processing" } : current);
          }
        }));
        setMessage(`Student file processed. ${result.created} added, ${result.skipped} skipped.`);
        setError("");
        await refreshVisibleData();
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : "Failed to import student roster.");
      } finally {
        setStudentUploadState(null);
      }
    })();
  };

  const confirmQuestionDelete = (question: Question) => {
    openConfirmation({
      eyebrow: "Delete question",
      title: `Delete question ${question.sourceQuestionNo}?`,
      description: "This removes the prompt, options, and answer rows from the question bank.",
      confirmLabel: "Delete question",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await deleteQuestion(question.id);
          setSelectedQuestionIds((current) => current.filter((id) => id !== question.id));
        }, "Question deleted.");
      }
    });
  };

  const confirmSelectedQuestionsDelete = () => {
    if (!selectedQuestionIds.length) {
      return;
    }

    openConfirmation({
      eyebrow: "Delete selected",
      title: `Delete ${selectedQuestionIds.length} selected question${selectedQuestionIds.length === 1 ? "" : "s"}?`,
      description: "The selected questions and their answer keys will be removed from the bank.",
      confirmLabel: "Delete selected",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await bulkDeleteQuestions(selectedQuestionIds);
          setSelectedQuestionIds([]);
        }, `${selectedQuestionIds.length} questions deleted.`);
      }
    });
  };

  const confirmLevelClear = () => {
    if (!levelFilter) {
      return;
    }

    openConfirmation({
      eyebrow: "Clear level",
      title: `Clear all ${titleCase(levelFilter)} questions?`,
      description: `Every ${levelFilter} question in the bank will be removed.`,
      confirmLabel: "Clear level",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await clearLevel(levelFilter);
          setSelectedQuestionIds([]);
        }, `${titleCase(levelFilter)} level cleared.`);
      }
    });
  };

  const confirmAllQuestionsClear = () => {
    if (!totalQuestions) {
      return;
    }

    openConfirmation({
      eyebrow: "Clear all questions",
      title: `Delete all ${totalQuestions} questions?`,
      description: "This clears the full question bank across Basic, Medium, and Hard.",
      confirmLabel: "Clear all",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await clearAllQuestions();
          setSelectedQuestionIds([]);
        }, "All questions cleared.");
      }
    });
  };

  const confirmStudentDelete = (student: StudentRosterEntry) => {
    openConfirmation({
      eyebrow: "Remove student",
      title: `Remove ${student.name}?`,
      description: "This removes the student account, attempts, quiz sessions, and active sessions.",
      confirmLabel: "Remove student",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await deleteAdminStudent(student.id);
          setSelectedStudentIds((current) => current.filter((id) => id !== student.id));
        }, `${student.name} removed.`);
      }
    });
  };

  const confirmSelectedStudentsDelete = () => {
    if (!selectedStudentIds.length) {
      return;
    }

    openConfirmation({
      eyebrow: "Remove selected",
      title: `Remove ${selectedStudentIds.length} selected student${selectedStudentIds.length === 1 ? "" : "s"}?`,
      description: "This also clears their attempts, quiz sessions, and active sessions.",
      confirmLabel: "Remove selected",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await bulkDeleteAdminStudents(selectedStudentIds);
          setSelectedStudentIds([]);
        }, `${selectedStudentIds.length} students removed.`);
      }
    });
  };

  const confirmAllStudentsDelete = () => {
    if (!totalStudents) {
      return;
    }

    openConfirmation({
      eyebrow: "Clear all students",
      title: `Remove all ${totalStudents} students?`,
      description: "This removes every student record together with attempts, quiz sessions, and access sessions.",
      confirmLabel: "Clear all students",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await clearAllAdminStudents();
          setSelectedStudentIds([]);
        }, "All students removed.");
      }
    });
  };

  const confirmAdminDelete = (admin: AdminRosterEntry) => {
    openConfirmation({
      eyebrow: "Remove admin",
      title: `Remove admin account for ${admin.name}?`,
      description: "This admin will lose access to the panel immediately.",
      confirmLabel: "Remove admin",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await deleteManagedAdmin(admin.id);
          setSelectedAdminIds((current) => current.filter((id) => id !== admin.id));
        }, `${admin.name} removed.`);
      }
    });
  };

  const confirmSelectedAdminsDelete = () => {
    if (!selectedAdminIds.length) {
      return;
    }

    openConfirmation({
      eyebrow: "Remove selected",
      title: `Remove ${selectedAdminIds.length} selected admin account${selectedAdminIds.length === 1 ? "" : "s"}?`,
      description: "Selected admins will lose panel access immediately.",
      confirmLabel: "Remove selected",
      confirmTone: "danger",
      onConfirm: async () => {
        await run(async () => {
          await bulkDeleteManagedAdmins(selectedAdminIds);
          setSelectedAdminIds([]);
        }, `${selectedAdminIds.length} admin accounts removed.`);
      }
    });
  };

  const contentIndent = isCompactViewport ? 0 : 32;
  const desktopRailWidth = isCompactViewport ? "0px" : sidebarOpen ? "286px" : "88px";
  const heroPills = (() => {
    if (section === "overview") {
      return [
        { label: `${totalQuestions} questions`, tone: "amber" as const },
        { label: `${totalStudents} students`, tone: "default" as const },
        ...(user.isSuperAdmin ? [{ label: `${adminsCount} admins`, tone: "default" as const }] : [])
      ];
    }

    if (section === "questions") {
      return [
        { label: `${questionsResponse?.pagination.totalItems ?? totalQuestions} questions`, tone: "amber" as const },
        ...(levelFilter ? [{ label: titleCase(levelFilter), tone: "default" as const }] : []),
        ...(selectedQuestionIds.length ? [{ label: `${selectedQuestionIds.length} selected`, tone: "default" as const }] : [])
      ];
    }

    if (section === "students") {
      return [
        { label: `${studentsResponse?.pagination.totalItems ?? totalStudents} students`, tone: "default" as const },
        ...(selectedStudentIds.length ? [{ label: `${selectedStudentIds.length} selected`, tone: "default" as const }] : [])
      ];
    }

    if (section === "admins") {
      return [
        { label: `${adminsResponse?.pagination.totalItems ?? adminsCount} admins`, tone: "default" as const },
        ...(selectedAdminIds.length ? [{ label: `${selectedAdminIds.length} selected`, tone: "default" as const }] : [])
      ];
    }

    return [] as Array<{ label: string; tone: "amber" | "default" }>;
  })();
  const heroFacts = (() => {
    if (section === "overview") {
      return [
        { label: "Questions", value: String(totalQuestions) },
        { label: "Students", value: String(totalStudents) },
        ...(user.isSuperAdmin ? [{ label: "Admins", value: String(adminsCount) }] : [])
      ];
    }

    return [] as Array<{ label: string; value: string }>;
  })();

  const sectionBody = (() => {
    if (section === "overview") {
      return (
        <motion.section
          animate={sectionAnimate}
          className="admin-stage admin-stage--overview"
          exit={sectionExit}
          initial={sectionInitial}
          key={section}
          transition={sectionTransition}
        >
          <div className="admin-stage__grid admin-stage__grid--three">
            <section className="admin-stage__section">
              <span className="eyebrow">Exam settings</span>
              <h4>Exam configuration</h4>

              <div className="admin-settings-stack">
                <label className="form-field">
                  <span className="form-label">Questions per exam</span>
                  <input className="search-input" inputMode="numeric" onChange={(event) => setQLimitDraft(event.target.value)} value={qLimitDraft} />
                </label>

                <label className="form-field">
                  <span className="form-label">Time limit (min)</span>
                  <input className="search-input" inputMode="numeric" onChange={(event) => setTLimitDraft(event.target.value)} value={tLimitDraft} />
                </label>

                <button
                  className="button button--primary"
                  onClick={() => void run(async () => { await updateAdminSettings(Number(qLimitDraft), Number(tLimitDraft)); }, "Settings saved.")}
                  type="button"
                >
                  Save settings
                </button>
              </div>
            </section>

            <section className="admin-stage__section admin-stage__section--accent">
              <span className="eyebrow">Quick access</span>
              <h4>Jump to the next action.</h4>
              <p className="section-copy">Open the section you need and work there directly.</p>

              <div className="admin-quick-list">
                <Link className="admin-quick-link" to="/admin/questions">
                  <span>Questions</span>
                  <strong>Question bank</strong>
                </Link>
                <Link className="admin-quick-link" to="/admin/students">
                  <span>Students</span>
                  <strong>Student management</strong>
                </Link>
                {user.isSuperAdmin ? (
                  <Link className="admin-quick-link" to="/admin/admins">
                    <span>Admins</span>
                    <strong>Admin accounts</strong>
                  </Link>
                ) : null}
              </div>
            </section>

            <section className="admin-stage__section">
              <span className="eyebrow">Inventory</span>
              <h4>Question distribution</h4>
              <p className="section-copy">Keep an eye on balance across Basic, Medium, and Hard before importing or clearing levels.</p>

              <div className="admin-summary-list">
                {dashboardSummaryLevels(dashboard).map((entry) => (
                  <div className="admin-summary-item" key={entry.level}>
                    <div className="admin-summary-item__head">
                      <span className={levelPill(entry.level)}>{titleCase(entry.level)}</span>
                      <strong>{entry.count}</strong>
                    </div>
                    <div className="admin-summary-item__bar">
                      <span style={{ width: `${(entry.count / levelMax) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="admin-panel-note">
                Total inventory: <strong>{totalQuestions}</strong> questions.
              </div>
            </section>
          </div>
        </motion.section>
      );
    }

    if (section === "questions") {
      return (
        <motion.section
          animate={sectionAnimate}
          className="admin-stage admin-stage--questions"
          exit={sectionExit}
          initial={sectionInitial}
          key={section}
          transition={sectionTransition}
        >
          <div className="question-workbench">
            <section className="question-workbench__editor admin-stage__section admin-stage__section--soft">
              <div className="question-workbench__head">
                <div className="question-workbench__meta">
                  <span className="eyebrow">{editingQuestionId ? "Edit question" : "Question editor"}</span>
                  <strong>{editingQuestionId ? "Edit question" : "Add question"}</strong>
                </div>

                <div className="filters__actions question-workbench__head-actions">
                  <div className="admin-upload-stack">
                    <label
                      aria-busy={Boolean(questionUploadState)}
                      className={`button button--sm upload-button ${questionUploadState ? "upload-button--busy" : ""}`}
                    >
                      {questionUploadState ? (questionUploadState.phase === "processing" ? "Processing..." : "Uploading...") : "Bulk upload"}
                      <input
                        accept=".xlsx"
                        disabled={Boolean(questionUploadState)}
                        onChange={(event) => {
                          importQuestionWorkbook(event.target.files?.[0]);
                          event.target.value = "";
                        }}
                        type="file"
                      />
                    </label>
                    <UploadProgress state={questionUploadState} />
                  </div>
                  {editingQuestionId ? (
                    <button className="button button--sm" onClick={cancelQuestionEdit} type="button">
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="question-workbench__editor-grid">
                <label className="form-field">
                  <span className="form-label">Level</span>
                  <OptionPicker
                    allowClear={false}
                    onChange={(next) => setNewQuestion((current) => ({ ...current, level: next as Level }))}
                    options={levelOptions}
                    placeholder="Select level"
                    value={newQuestion.level}
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">Question no.</span>
                  <input className="input" onChange={(event) => setNewQuestion((current) => ({ ...current, sourceQuestionNo: event.target.value }))} placeholder="Auto if left empty" value={newQuestion.sourceQuestionNo} />
                </label>

                <label className="form-field question-workbench__field question-workbench__field--wide">
                  <span className="form-label">Question prompt</span>
                  <textarea className="textarea" onChange={(event) => setNewQuestion((current) => ({ ...current, prompt: event.target.value }))} placeholder="Enter the question text" rows={5} value={newQuestion.prompt} />
                </label>

                <label className="form-field question-workbench__field question-workbench__field--wide">
                  <span className="form-label">Available particulars</span>
                  <textarea className="textarea" onChange={(event) => setNewQuestion((current) => ({ ...current, options: event.target.value }))} placeholder="One per line or comma separated" rows={5} value={newQuestion.options} />
                </label>
              </div>

              <div className="answer-editor question-workbench__answers">
                <div className="review-table-card__head">
                  <strong>Answer rows</strong>
                  <button className="button button--sm" onClick={addDraftRow} type="button">Add row</button>
                </div>

                <div className="table-wrap table-wrap--mobile-hide question-workbench__answers-table">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th style={{ width: 52 }}>#</th>
                        <th>Account</th>
                        <th style={{ width: 140 }}>Debit</th>
                        <th style={{ width: 140 }}>Credit</th>
                        <th style={{ width: 72 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {newQuestion.answerRows.map((row, index) => (
                        <tr key={`draft-row-${index}`}>
                          <td style={{ fontFamily: "var(--font-mono)" }}>{index + 1}</td>
                          <td>
                            <OptionPicker
                              onChange={(next) => updateDraftRow(index, "account", next)}
                              options={particularOptions}
                              placeholder="Select particular"
                              value={row.account}
                            />
                          </td>
                          <td><input className="input" inputMode="decimal" onChange={(event) => updateDraftRow(index, "debit", event.target.value)} placeholder="0.00" value={row.debit} /></td>
                          <td><input className="input" inputMode="decimal" onChange={(event) => updateDraftRow(index, "credit", event.target.value)} placeholder="0.00" value={row.credit} /></td>
                          <td><button className="button button--sm" onClick={() => removeDraftRow(index)} type="button">Remove</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="question-workbench__answer-cards">
                  {newQuestion.answerRows.length ? (
                    newQuestion.answerRows.map((row, index) => (
                      <article className="question-workbench__answer-card" key={`draft-row-mobile-${index}`}>
                        <div className="question-workbench__answer-card-head">
                          <strong>Row {index + 1}</strong>
                          <button className="button button--sm button--danger" onClick={() => removeDraftRow(index)} type="button">
                            Remove
                          </button>
                        </div>

                        <div className="question-workbench__answer-card-grid">
                          <label className="form-field">
                            <span className="form-label">Account</span>
                            <OptionPicker
                              onChange={(next) => updateDraftRow(index, "account", next)}
                              options={particularOptions}
                              placeholder="Select particular"
                              value={row.account}
                            />
                          </label>

                          <label className="form-field">
                            <span className="form-label">Debit</span>
                            <input className="input" inputMode="decimal" onChange={(event) => updateDraftRow(index, "debit", event.target.value)} placeholder="0.00" value={row.debit} />
                          </label>

                          <label className="form-field">
                            <span className="form-label">Credit</span>
                            <input className="input" inputMode="decimal" onChange={(event) => updateDraftRow(index, "credit", event.target.value)} placeholder="0.00" value={row.credit} />
                          </label>
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="question-workbench__answer-card question-workbench__answer-card--empty">
                      <strong>No answer rows yet</strong>
                      <span>Add a row to start building the answer key.</span>
                    </div>
                  )}
                </div>

                <div className="answer-editor__actions">
                  <button className="button button--primary" onClick={() => void submitQuestionDraft()} type="button">
                    {editingQuestionId ? "Save question" : "Add question"}
                  </button>
                </div>
              </div>
            </section>

            <section className="question-workbench__list admin-stage__section admin-stage__section--soft">
              <div className="question-workbench__head">
                <div className="question-workbench__meta">
                  <span className="eyebrow">Question list</span>
                  <strong>{questionsResponse?.pagination.totalItems ?? 0} questions</strong>
                </div>

                <div className="question-workbench__summary">
                  <span className="pill pill--amber">{questions.length} visible</span>
                  {selectedQuestionIds.length ? <span className="pill">{selectedQuestionIds.length} selected</span> : null}
                  {levelFilter ? <span className={levelPill(levelFilter)}>{titleCase(levelFilter)}</span> : null}
                </div>
              </div>

              <div className="question-workbench__toolbar">
                <div className="filters__search">
                  <svg className="filters__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" x2="16.65" y1="21" y2="16.65" />
                  </svg>
                  <input
                    className="search-input"
                    onChange={(event) => setQuestionSearch(event.target.value)}
                    placeholder="Search all question fields or use level:hard account:cash"
                    value={questionSearch}
                  />
                </div>

                <div className="question-workbench__toolbar-row">
                  <div className="filter-strip">
                    <button className={`filter-chip ${levelFilter === undefined ? "filter-chip--active" : ""}`} onClick={() => setLevelFilter(undefined)} type="button">
                      All levels
                    </button>
                    {LEVELS.map((level) => (
                      <button className={`filter-chip ${levelFilter === level ? "filter-chip--active" : ""}`} key={level} onClick={() => setLevelFilter(level)} type="button">
                        {titleCase(level)}
                      </button>
                    ))}
                  </div>

                  <div className="filters__actions question-workbench__bulk-actions">
                    <button className="button button--sm" onClick={toggleAllQuestions} type="button">
                      {allQuestionsSelected ? "Deselect page" : "Select page"}
                    </button>
                    <button
                      className="button button--sm button--danger"
                      disabled={!selectedQuestionIds.length}
                      onClick={confirmSelectedQuestionsDelete}
                      type="button"
                    >
                      Delete ({selectedQuestionIds.length})
                    </button>
                    <button
                      className="button button--sm button--danger"
                      disabled={!levelFilter}
                      onClick={confirmLevelClear}
                      type="button"
                    >
                      Clear level
                    </button>
                    <button
                      className="button button--sm button--danger"
                      disabled={!totalQuestions}
                      onClick={confirmAllQuestionsClear}
                      type="button"
                    >
                      Clear all
                    </button>
                  </div>
                </div>
              </div>

              <div className="table-wrap table-wrap--mobile-hide admin-scroll-table question-workbench__table">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}></th>
                      <th style={{ width: 56 }}>No</th>
                      <th style={{ width: 78 }}>Level</th>
                      <th>Prompt</th>
                      <th style={{ width: 82 }}>Rows</th>
                      <th style={{ width: 110 }}>Updated</th>
                      <th style={{ width: 152 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((question) => (
                      <tr key={question.id}>
                        <td>
                          <SelectionToggle
                            checked={selectedQuestionIds.includes(question.id)}
                            compact
                            label={`Select question ${question.sourceQuestionNo}`}
                            onChange={() => toggleQuestionSelection(question.id)}
                          />
                        </td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{question.sourceQuestionNo}</td>
                        <td><span className={levelPill(question.level)} style={{ fontSize: 11 }}>{titleCase(question.level)}</span></td>
                        <td className="admin-table__prompt">{question.prompt}</td>
                        <td style={{ fontFamily: "var(--font-mono)", textAlign: "center" }}>{question.answerRows.length}</td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{formatShortDate(question.importedAt)}</td>
                        <td>
                          <div className="admin-table__actions">
                            <button className="button button--sm" onClick={() => beginQuestionEdit(question)} type="button">
                              Edit
                            </button>
                            <button
                              className="button button--sm button--danger"
                              onClick={() => confirmQuestionDelete(question)}
                              type="button"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!questions.length ? <tr><td className="empty-state" colSpan={7}>No questions match the current filter.</td></tr> : null}
                  </tbody>
                </table>
              </div>

              <div className="mobile-table-cards">
                {questions.map((question) => (
                  <article className="mobile-table-card mobile-table-card--question" key={`question-mobile-${question.id}`}>
                    <div className="mobile-table-card__head">
                      <div className="mobile-table-card__title">
                        <strong>Question {question.sourceQuestionNo}</strong>
                        <small>{formatShortDate(question.importedAt)}</small>
                      </div>

                      <div className="mobile-table-card__badges">
                        <span className={levelPill(question.level)} style={{ fontSize: 11 }}>{titleCase(question.level)}</span>
                        <SelectionToggle
                          checked={selectedQuestionIds.includes(question.id)}
                          label="Select question"
                          onChange={() => toggleQuestionSelection(question.id)}
                        />
                      </div>
                    </div>

                    <p className="mobile-table-card__prompt">{question.prompt}</p>

                    <div className="mobile-table-card__meta">
                      <MobileMetaRow icon="rows" label="Answer rows" value={question.answerRows.length} />
                      <MobileMetaRow icon="calendar" label="Updated" value={formatShortDate(question.importedAt)} />
                    </div>

                    <div className="mobile-table-card__actions">
                      <button className="button button--sm" onClick={() => beginQuestionEdit(question)} type="button">
                        Edit
                      </button>
                      <button
                        className="button button--sm button--danger"
                        onClick={() => confirmQuestionDelete(question)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
                {!questions.length ? <div className="mobile-table-empty">No questions match the current filter.</div> : null}
              </div>

              {questionsResponse ? (
                <PaginationControls
                  label={`Questions${levelFilter ? ` / ${titleCase(levelFilter)}` : ""}`}
                  onPageChange={setQuestionPage}
                  onPageSizeChange={(pageSize) => {
                    setQuestionPageSize(pageSize);
                    setQuestionPage(1);
                  }}
                  pagination={questionsResponse.pagination}
                />
              ) : null}
            </section>
          </div>
        </motion.section>
      );
    }

    if (section === "assistant") {
      return (
        <motion.section
          animate={sectionAnimate}
          className="admin-stage admin-stage--assistant"
          exit={sectionExit}
          initial={sectionInitial}
          key={section}
          transition={sectionTransition}
        >
          <section className="admin-assistant admin-assistant--page">
            <div className="admin-assistant__panel">
              <div className="admin-assistant__panel-shell">
                <div className="admin-assistant__log" ref={assistantLogRef}>
                  <div className="admin-assistant__feed">
                    {assistantMessages.map((entry, index) => (
                      <article
                        className={`admin-assistant__message ${entry.role === "assistant" ? "admin-assistant__message--assistant" : "admin-assistant__message--user"}`}
                        key={`${entry.role}-${index}`}
                      >
                        <div className={`admin-assistant__bubble ${entry.role === "assistant" ? "admin-assistant__bubble--assistant" : "admin-assistant__bubble--user"}`}>
                          <span className="admin-assistant__bubble-role">{entry.role === "assistant" ? "AI Bot" : "You"}</span>
                          <p>{entry.content}</p>
                        </div>
                      </article>
                    ))}

                    {assistantLoading ? (
                      <article className="admin-assistant__message admin-assistant__message--assistant">
                        <div className="admin-assistant__bubble admin-assistant__bubble--assistant admin-assistant__bubble--pending">
                          <span className="admin-assistant__bubble-role">AI Bot</span>
                          <p>Checking the current platform data...</p>
                        </div>
                      </article>
                    ) : null}
                  </div>
                </div>

                <div className="admin-assistant__composer admin-assistant__composer--page">
                  <div className="admin-assistant__composer-card">
                    <label className="form-field admin-assistant__input-field">
                      <span className="form-label sr-only">Message AI bot</span>
                      <div className="admin-assistant__composer-shell">
                        <textarea
                          className="textarea admin-assistant__textarea"
                          onChange={(event) => setAssistantDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void submitAssistantPrompt();
                            }
                          }}
                          placeholder="Ask a question"
                          ref={assistantInputRef}
                          rows={1}
                          value={assistantDraft}
                        />

                        <button
                          aria-label={assistantLoading ? "AI bot is thinking" : "Send message"}
                          className="admin-assistant__send"
                          disabled={assistantLoading || !assistantDraft.trim()}
                          onClick={() => void submitAssistantPrompt()}
                          type="button"
                        >
                          {assistantLoading ? (
                            <span aria-hidden="true" className="admin-assistant__send-dots">...</span>
                          ) : (
                            <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18">
                              <path d="M7 11.5 20 4l-3.5 16-4.3-5.2L7 11.5Z" fill="currentColor" />
                              <path d="M20 4 11.9 14.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
                            </svg>
                          )}
                          <span className="sr-only">{assistantLoading ? "Thinking" : "Send"}</span>
                        </button>
                      </div>
                    </label>

                    {assistantError ? <div className="admin-assistant__error">{assistantError}</div> : null}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </motion.section>
      );
    }

    if (section === "students") {
      return (
        <motion.section
          animate={sectionAnimate}
          className="admin-stage"
          exit={sectionExit}
          initial={sectionInitial}
          key={section}
          transition={sectionTransition}
        >
          <div className="admin-student-grid">
              <div className="table-panel__head table-panel__head--compact admin-inline-head">
              <div>
                <span className="eyebrow">Student editor</span>
                <strong>Add student</strong>
              </div>

              <div className="filters__actions">
                <div className="admin-upload-stack">
                  <label
                    aria-busy={Boolean(studentUploadState)}
                    className={`button button--sm upload-button ${studentUploadState ? "upload-button--busy" : ""}`}
                  >
                    {studentUploadState ? (studentUploadState.phase === "processing" ? "Processing..." : "Uploading...") : "Bulk upload"}
                    <input
                      accept=".csv,.txt,.xlsx"
                      disabled={Boolean(studentUploadState)}
                      onChange={(event) => {
                        importStudentRoster(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                      type="file"
                    />
                  </label>
                  <UploadProgress state={studentUploadState} />
                </div>
              </div>
            </div>

            <label className="form-field">
              <span className="form-label">Gmail address</span>
              <input className="input" autoComplete="email" onChange={(event) => setNewStudent((current) => ({ ...current, email: event.target.value }))} placeholder="student@gmail.com" value={newStudent.email} />
            </label>

            <label className="form-field">
              <span className="form-label">Full name</span>
              <input className="input" onChange={(event) => setNewStudent((current) => ({ ...current, name: event.target.value }))} placeholder="Student full name" value={newStudent.name} />
            </label>

            <label className="form-field">
              <span className="form-label">Access days</span>
              <input
                className="input"
                inputMode="numeric"
                onChange={(event) => setNewStudent((current) => ({ ...current, accessDays: event.target.value }))}
                placeholder="30"
                value={newStudent.accessDays}
              />
            </label>

            <div className="admin-form-actions">
              <button className="button button--primary" onClick={() => void submitStudentDraft()} type="button">
                Add student
              </button>
            </div>

          </div>

          <div className="admin-stage__divider" />

          <div className="filters__actions">
            <div className="filters__search">
              <svg className="filters__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" x2="16.65" y1="21" y2="16.65" />
              </svg>
              <input
                className="search-input"
                onChange={(event) => setStudentSearch(event.target.value)}
                placeholder="Search students or use email: / status: / remaining: / attempts:"
                value={studentSearch}
              />
            </div>
            <button className="button button--sm" onClick={toggleAllStudents} type="button">
              {allStudentsSelected ? "Deselect page" : "Select page"}
            </button>
            {user.isSuperAdmin ? (
              <button
                className="button button--sm button--danger"
                disabled={!selectedStudentIds.length}
                onClick={confirmSelectedStudentsDelete}
                type="button"
              >
                Remove selected ({selectedStudentIds.length})
              </button>
            ) : null}
            {user.isSuperAdmin ? (
              <button
                className="button button--sm button--danger"
                disabled={!totalStudents}
                onClick={confirmAllStudentsDelete}
                type="button"
              >
                Clear all students
              </button>
            ) : null}
          </div>

          <div className="admin-stage__divider" />

          <div className="table-wrap table-wrap--mobile-hide admin-scroll-table">
            <table className="admin-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}></th>
                  <th>Gmail</th>
                  <th>Name</th>
                  <th>Access</th>
                  <th>Remaining</th>
                  <th>Attempts</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {students.map((student) => (
                  <tr key={student.id}>
                    <td>
                      <SelectionToggle
                        checked={selectedStudentIds.includes(student.id)}
                        compact
                        label={`Select student ${student.name}`}
                        onChange={() => toggleStudentSelection(student.id)}
                      />
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{student.email}</td>
                    <td>{student.name}</td>
                    <td>
                      <div className="admin-table__stack">
                        <span className={accessStatusPill(student.accessStatus)} style={{ fontSize: 11 }}>
                          {student.accessStatus === "active" ? "Active" : "Expired"}
                        </span>
                        <small>{formatAccessDate(student.accessExpiresAt)}</small>
                      </div>
                    </td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{student.remainingAccessDays}d</td>
                    <td style={{ fontFamily: "var(--font-mono)" }}>{student.attemptsCount}</td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{formatShortDate(student.updatedAt)}</td>
                    <td>
                      <div className="admin-table__actions">
                        <button className="button button--sm" onClick={() => beginStudentEdit(student)} type="button">
                          Edit
                        </button>
                        {user.isSuperAdmin ? (
                          <button
                            className="button button--sm button--danger"
                            onClick={() => confirmStudentDelete(student)}
                            type="button"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
                {!students.length ? <tr><td className="empty-state" colSpan={8}>No students match the current filter.</td></tr> : null}
              </tbody>
            </table>
          </div>

          <div className="mobile-table-cards">
            {students.map((student) => (
              <article className="mobile-table-card" key={`student-mobile-${student.id}`}>
                <div className="mobile-table-card__head">
                  <div className="mobile-table-card__title">
                    <strong>{student.name}</strong>
                    <small>{student.email}</small>
                  </div>

                  <div className="mobile-table-card__badges">
                    <label className="mobile-table-card__select">
                      <input checked={selectedStudentIds.includes(student.id)} onChange={() => toggleStudentSelection(student.id)} type="checkbox" />
                      <span>{selectedStudentIds.includes(student.id) ? "Selected" : "Select"}</span>
                    </label>
                    <span className={accessStatusPill(student.accessStatus)} style={{ fontSize: 11 }}>
                      {student.accessStatus === "active" ? "Active" : "Expired"}
                    </span>
                  </div>
                </div>

                <div className="mobile-table-card__meta">
                  <MobileMetaRow icon="register" label="Gmail" value={student.email} />
                  <MobileMetaRow icon="status" label="Access" value={`Ends ${formatAccessDate(student.accessExpiresAt)}`} />
                  <MobileMetaRow icon="rows" label="Remaining" value={`${student.remainingAccessDays} day${student.remainingAccessDays === 1 ? "" : "s"}`} />
                  <MobileMetaRow icon="attempts" label="Attempts" value={student.attemptsCount} />
                  <MobileMetaRow icon="calendar" label="Updated" value={formatShortDate(student.updatedAt)} />
                </div>

                <div className="mobile-table-card__actions">
                  <button className="button button--sm" onClick={() => beginStudentEdit(student)} type="button">
                    Edit
                  </button>
                  {user.isSuperAdmin ? (
                    <button
                      className="button button--sm button--danger"
                      onClick={() => confirmStudentDelete(student)}
                      type="button"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            {!students.length ? <div className="mobile-table-empty">No students match the current filter.</div> : null}
          </div>

          {studentsResponse ? (
            <PaginationControls
              label="Students"
              onPageChange={setStudentPage}
              onPageSizeChange={(pageSize) => {
                setStudentPageSize(pageSize);
                setStudentPage(1);
              }}
              pagination={studentsResponse.pagination}
            />
          ) : null}
        </motion.section>
      );
    }

    return (
      <motion.section
        animate={sectionAnimate}
        className="admin-stage"
        exit={sectionExit}
        initial={sectionInitial}
        key={section}
        transition={sectionTransition}
      >
        <div className="admin-student-grid">
          <div className="table-panel__head table-panel__head--compact admin-inline-head">
            <div>
              <span className="eyebrow">{editingAdminId ? "Edit admin" : "Admin editor"}</span>
              <strong>{editingAdminId ? "Edit admin" : "Add admin"}</strong>
            </div>

            {editingAdminId ? (
              <button className="button button--sm" onClick={cancelAdminEdit} type="button">
                Cancel
              </button>
            ) : null}
          </div>

          <label className="form-field">
            <span className="form-label">Admin name</span>
            <input className="input" onChange={(event) => setNewAdmin((current) => ({ ...current, name: event.target.value }))} placeholder="Full name" value={newAdmin.name} />
          </label>

          <label className="form-field">
            <span className="form-label">Gmail address</span>
            <input className="input" autoComplete="email" onChange={(event) => setNewAdmin((current) => ({ ...current, email: event.target.value }))} placeholder="admin@gmail.com" value={newAdmin.email} />
          </label>

          <div className="admin-form-actions">
            <button className="button button--primary" onClick={() => void submitAdminDraft()} type="button">
              {editingAdminId ? "Save admin" : "Add admin"}
            </button>
          </div>

        </div>

        <div className="admin-stage__divider" />

        <div className="filters__actions">
          <div className="filters__search">
            <svg className="filters__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" x2="16.65" y1="21" y2="16.65" />
            </svg>
              <input
                className="search-input"
                onChange={(event) => setAdminSearch(event.target.value)}
                placeholder="Search all admin fields or use email: / access:"
                value={adminSearch}
              />
            </div>
          <button className="button button--sm" onClick={toggleAllAdmins} type="button">
            {allAdminsSelected ? "Deselect page" : "Select page"}
          </button>
          <button
            className="button button--sm button--danger"
            disabled={!selectedAdminIds.length}
            onClick={confirmSelectedAdminsDelete}
            type="button"
          >
            Remove selected ({selectedAdminIds.length})
          </button>
        </div>

        <div className="admin-stage__divider" />

        <div className="table-wrap table-wrap--mobile-hide admin-scroll-table">
          <table className="admin-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}></th>
                <th>Name</th>
                <th>Gmail</th>
                <th>Access</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => (
                <tr key={admin.id}>
                  <td>
                    <SelectionToggle
                      checked={selectedAdminIds.includes(admin.id)}
                      compact
                      disabled={admin.id === user.id}
                      label={admin.id === user.id ? `Current admin ${admin.name}` : `Select admin ${admin.name}`}
                      onChange={() => toggleAdminSelection(admin.id)}
                    />
                  </td>
                  <td>{admin.name}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{admin.email}</td>
                  <td><span className={admin.isSuperAdmin ? "pill pill--indigo" : "pill"}>{admin.isSuperAdmin ? "Super admin" : "Admin"}</span></td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{formatShortDate(admin.updatedAt)}</td>
                  <td>
                    <div className="admin-table__actions">
                      <button className="button button--sm" onClick={() => beginAdminEdit(admin)} type="button">
                        Edit
                      </button>
                      {admin.id === user.id ? (
                        <span className="pill">Current</span>
                      ) : (
                        <button
                          className="button button--sm button--danger"
                          onClick={() => confirmAdminDelete(admin)}
                          type="button"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!admins.length ? <tr><td className="empty-state" colSpan={6}>No admin accounts match the current filter.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="mobile-table-cards">
          {admins.map((admin) => (
            <article className="mobile-table-card" key={`admin-mobile-${admin.id}`}>
              <div className="mobile-table-card__head">
                <div className="mobile-table-card__title">
                  <strong>{admin.name}</strong>
                  <small>{admin.email}</small>
                </div>

                <div className="mobile-table-card__badges">
                  <label className="mobile-table-card__select">
                    <input
                      checked={selectedAdminIds.includes(admin.id)}
                      disabled={admin.id === user.id}
                      onChange={() => toggleAdminSelection(admin.id)}
                      type="checkbox"
                    />
                    <span>{admin.id === user.id ? "Current" : selectedAdminIds.includes(admin.id) ? "Selected" : "Select"}</span>
                  </label>
                  <span className={admin.isSuperAdmin ? "pill pill--indigo" : "pill"}>{admin.isSuperAdmin ? "Super admin" : "Admin"}</span>
                </div>
              </div>

              <div className="mobile-table-card__meta">
                <MobileMetaRow icon="user" label="Gmail" value={admin.email} />
                <MobileMetaRow icon="status" label="Access" value={admin.isSuperAdmin ? "Super admin" : "Admin"} />
                <MobileMetaRow icon="calendar" label="Updated" value={formatShortDate(admin.updatedAt)} />
              </div>

              <div className="mobile-table-card__actions">
                <button className="button button--sm" onClick={() => beginAdminEdit(admin)} type="button">
                  Edit
                </button>
                {admin.id === user.id ? (
                  <span className="pill">Current</span>
                ) : (
                  <button
                    className="button button--sm button--danger"
                    onClick={() => confirmAdminDelete(admin)}
                    type="button"
                  >
                    Remove
                  </button>
                )}
              </div>
            </article>
          ))}
          {!admins.length ? <div className="mobile-table-empty">No admin accounts match the current filter.</div> : null}
        </div>

        {adminsResponse ? (
          <PaginationControls
            label="Admins"
            onPageChange={setAdminPage}
            onPageSizeChange={(pageSize) => {
              setAdminPageSize(pageSize);
              setAdminPage(1);
            }}
            pagination={adminsResponse.pagination}
          />
        ) : null}
      </motion.section>
    );
  })();

  return (
    <>
      <motion.section
        animate={{ opacity: 1, y: 0 }}
        className="admin-console"
        initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
        style={{ ["--admin-rail-width" as any]: desktopRailWidth }}
        transition={pageTransition}
      >
        {!isCompactViewport ? (
          <motion.aside
            animate={{ opacity: 1, x: 0 }}
            className="admin-console__rail"
            initial={false}
            transition={drawerTransition}
          >
          <AnimatePresence initial={false} mode="wait">
            {sidebarOpen ? (
              <motion.div
                animate={{ opacity: 1, x: 0 }}
                className="admin-console__rail-inner"
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -18 }}
                initial={reduceMotion ? { opacity: 1 } : { opacity: 0, x: -18 }}
                key="rail-open"
                transition={drawerTransition}
              >
                <div className="admin-console__rail-head">
                  <div className="admin-console__brand">
                    <span className="eyebrow">Admin panel</span>
                    <strong>{user.isSuperAdmin ? "Super admin workspace" : "Admin workspace"}</strong>
                    <p>Journal exam control surface</p>
                  </div>

                  <button
                    aria-label="Close sidebar"
                    className="admin-console__rail-toggle"
                    onClick={() => setSidebarOpen(false)}
                    type="button"
                  >
                    <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
                      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                    </svg>
                  </button>
                </div>

                <div className="admin-console__profile">
                  <span className={user.isSuperAdmin ? "pill pill--indigo" : "pill"}>{user.isSuperAdmin ? "Super admin" : "Admin"}</span>
                  <strong>{user.name}</strong>
                  <span>{user.email}</span>
                </div>

                <nav aria-label="Admin workspace" className="admin-workspace-nav admin-workspace-nav--sidebar">
                  {adminNavItems.map((item) => (
                    <NavLink className={({ isActive }) => `admin-workspace-nav__link ${isActive ? "admin-workspace-nav__link--active" : ""}`} key={item.key} to={item.to}>
                      {item.label}
                    </NavLink>
                  ))}
                </nav>
              </motion.div>
            ) : (
              <motion.div
                animate={{ opacity: 1, x: 0 }}
                className="admin-console__rail-stub"
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -10 }}
                initial={reduceMotion ? { opacity: 1 } : { opacity: 0, x: -10 }}
                key="rail-closed"
                transition={drawerTransition}
              >
                <button
                  aria-expanded={sidebarOpen}
                  aria-label="Open sidebar"
                  className="button button--ghost admin-console__stub-toggle"
                  onClick={() => setSidebarOpen(true)}
                  type="button"
                >
                  <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
                    <path d="M4 7h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                    <path d="M4 12h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                    <path d="M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                  </svg>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.aside>
        ) : null}

        <motion.div
          animate={reduceMotion ? { paddingLeft: contentIndent } : { paddingLeft: contentIndent }}
          className="admin-console__main"
          initial={false}
          ref={mainScrollRef}
          transition={drawerTransition}
        >
          {showSectionHero ? (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="section-head admin-console__hero"
              initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
              transition={panelTransition}
            >
              <div className="section-head__top">
                <div className="admin-console__hero-main">
                  {!sidebarOpen && !isCompactViewport ? (
                    <button
                      aria-expanded={sidebarOpen}
                      aria-label="Open sidebar"
                      className="button button--ghost admin-console__toggle"
                      onClick={() => setSidebarOpen(true)}
                      type="button"
                    >
                      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
                        <path d="M4 7h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                        <path d="M4 12h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                        <path d="M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
                      </svg>
                    </button>
                  ) : null}

                  <AnimatePresence initial={false} mode="wait">
                    <motion.div
                      animate={sectionAnimate}
                      className="section-head__info"
                      exit={sectionExit}
                      initial={sectionInitial}
                      key={`hero-${section}`}
                      transition={sectionTransition}
                    >
                      <span className="eyebrow">{meta.eyebrow}</span>
                      <h2>{meta.title}</h2>
                      {meta.copy ? <p className="section-copy">{meta.copy}</p> : null}
                    </motion.div>
                  </AnimatePresence>
                </div>

                {heroPills.length ? (
                  <div className="section-head__metrics">
                    {heroPills.map((pill) => (
                      <span className={pill.tone === "amber" ? "pill pill--amber" : "pill"} key={pill.label}>
                        {pill.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              {heroFacts.length ? (
                <div className="hero-strip">
                  {heroFacts.map((item) => (
                    <div className="hero-strip__item" key={item.label}>
                      <span className="hero-strip__label">{item.label}</span>
                      <strong>{item.value}</strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </motion.div>
          ) : null}

          <div className={`admin-console__content ${section === "assistant" ? "admin-console__content--assistant" : ""}`}>
            {message ? <div className="banner banner--success">{message}</div> : null}
            {error ? <div className="banner banner--error">{error}</div> : null}
            <AnimatePresence initial={false} mode="wait">
              {sectionBody}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.section>

      <AnimatePresence>
        {editingStudentId ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="student-result-overlay student-result-overlay--dialog admin-editor-overlay"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={pageTransition}
          >
            <button
              aria-label="Close student editor"
              className="student-result-overlay__backdrop"
              disabled={studentEditLoading}
              onClick={cancelStudentEdit}
              type="button"
            />

            <motion.section
              animate={{ opacity: 1, y: 0 }}
              aria-modal="true"
              className="panel student-submit-dialog admin-editor-dialog"
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
              role="dialog"
              transition={pageTransition}
            >
              <span className="eyebrow">Edit student</span>
              <h3>Update student access</h3>
              <p>Update the student details here. Adding days extends active access from the current expiry, or starts from now if access already expired.</p>

              <div className="admin-editor-dialog__fields">
                <label className="form-field">
                  <span className="form-label">Gmail address</span>
                  <input
                    autoComplete="email"
                    className="input"
                    onChange={(event) => setEditingStudentDraft((current) => ({ ...current, email: event.target.value }))}
                    placeholder="student@gmail.com"
                    value={editingStudentDraft.email}
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">Full name</span>
                  <input
                    className="input"
                    onChange={(event) => setEditingStudentDraft((current) => ({ ...current, name: event.target.value }))}
                    placeholder="Student full name"
                    value={editingStudentDraft.name}
                  />
                </label>

                <label className="form-field">
                  <span className="form-label">Add access days</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    onChange={(event) => setEditingStudentDraft((current) => ({ ...current, accessDays: event.target.value }))}
                    placeholder="Add days from active expiry or from now if expired"
                    value={editingStudentDraft.accessDays}
                  />
                </label>
              </div>

              <div className="admin-panel-note admin-panel-note--dialog">
                Leave the access field empty if you only want to update the name or Gmail address.
              </div>

              <div className="student-submit-dialog__actions admin-editor-dialog__actions">
                <button className="button" disabled={studentEditLoading} onClick={cancelStudentEdit} type="button">
                  Cancel
                </button>
                <button className="button button--primary" disabled={studentEditLoading} onClick={() => void submitStudentEdit()} type="button">
                  {studentEditLoading ? "Saving..." : "Save student"}
                </button>
              </div>
            </motion.section>
          </motion.div>
        ) : null}

        {confirmState ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="student-result-overlay student-result-overlay--dialog admin-confirm-overlay"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={pageTransition}
          >
            <button
              aria-label="Close confirmation"
              className="student-result-overlay__backdrop"
              disabled={confirmLoading}
              onClick={closeConfirmation}
              type="button"
            />

            <motion.section
              animate={{ opacity: 1, y: 0 }}
              aria-modal="true"
              className="panel student-submit-dialog admin-confirm-dialog"
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
              role="alertdialog"
              transition={pageTransition}
            >
              <span className="eyebrow">{confirmState.eyebrow}</span>
              <h3>{confirmState.title}</h3>
              <p>{confirmState.description}</p>

              <div className="student-submit-dialog__actions admin-confirm-dialog__actions">
                <button className="button" disabled={confirmLoading} onClick={closeConfirmation} type="button">
                  Cancel
                </button>
                <button
                  className={`button ${confirmState.confirmTone === "danger" ? "button--danger" : "button--primary"}`}
                  disabled={confirmLoading}
                  onClick={() => void handleConfirmation()}
                  type="button"
                >
                  {confirmLoading ? "Working..." : confirmState.confirmLabel}
                </button>
              </div>
            </motion.section>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
