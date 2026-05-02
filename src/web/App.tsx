import { lazy, startTransition, Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "framer-motion";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import type { AuthStatusResponse, AuthenticatedAdmin, AuthenticatedStudent } from "../shared/types";
import { clearClientDataCache, fetchAuthStatus, logout, preloadWorkspaceData } from "./api";
import { AuthFlowFieldBackground } from "./components/AuthFlowFieldBackground";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SkeletonDashboard } from "./components/Skeleton";
import { preloadWorkspaceRoute, loadAdminPageModule, loadStudentPageModule } from "./page-loaders";
import type { AdminSection } from "./pages/AdminPage";
import { AuthPage } from "./pages/AuthPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { TermsPage } from "./pages/TermsPage";
import type { StudentSection } from "./pages/StudentPage";

type Theme = "dark" | "light";
type AuthView = "student-login" | "admin-login" | "admin-setup";
type MenuItem = { to: string; label: string; description: string };

const logoUrl = new URL("../../skillspark2025.svg", import.meta.url).href;
const AUTH_STATUS_CACHE_KEY = "jet-auth-status:v1";
const PUBLIC_AUTH_PATHS = new Set(["/student/login", "/admin/login", "/admin/setup"]);
const ADMIN_SECTIONS = new Set<AdminSection>(["overview", "assistant", "questions", "students", "admins"]);
const STUDENT_SECTIONS = new Set<StudentSection>(["overview"]);
const STUDENT_MENU_ITEMS: MenuItem[] = [
  { to: "/student/overview", label: "Dashboard", description: "Start a mode and review your results." }
];
const AdminPage = lazy(async () => ({ default: (await loadAdminPageModule()).AdminPage }));
const StudentPage = lazy(async () => ({ default: (await loadStudentPageModule()).StudentPage }));

function WorkspaceBoot({
  eyebrow,
  title,
  copy
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <section aria-live="polite" className="page-boot" role="status">
      <div className="page-boot__copy">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="section-copy">{copy}</p>
      </div>
      <div aria-hidden="true" className="page-boot__progress">
        <div className="page-boot__track">
          <span className="page-boot__indicator" />
        </div>
      </div>
    </section>
  );
}

function AdminWorkspaceRoute({ user }: { user: AuthenticatedAdmin }) {
  const { section } = useParams<{ section: string }>();

  if (!section || !ADMIN_SECTIONS.has(section as AdminSection)) {
    return <Navigate replace to="/admin/overview" />;
  }

  if (section === "admins" && !user.isSuperAdmin) {
    return <Navigate replace to="/admin/overview" />;
  }

  return (
    <ErrorBoundary>
      <Suspense
        fallback={<SkeletonDashboard />}
      >
        <AdminPage section={section as AdminSection} user={user} />
      </Suspense>
    </ErrorBoundary>
  );
}

function StudentWorkspaceRoute({ user }: { user: AuthenticatedStudent }) {
  const { section } = useParams<{ section: string }>();

  if (!section || !STUDENT_SECTIONS.has(section as StudentSection)) {
    return <Navigate replace to="/student/overview" />;
  }

  return (
    <ErrorBoundary>
      <Suspense
        fallback={<SkeletonDashboard />}
      >
        <StudentPage />
      </Suspense>
    </ErrorBoundary>
  );
}

function getInitialTheme(): Theme {
  const stored = localStorage.getItem("jet-theme");
  if (stored === "light" || stored === "dark") return stored;
  return "dark";
}

function readCachedAuthStatus(): AuthStatusResponse | null {
  try {
    const rawValue = window.sessionStorage.getItem(AUTH_STATUS_CACHE_KEY);
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as Partial<AuthStatusResponse>;
    if (typeof parsed !== "object" || parsed === null || typeof parsed.adminSetupRequired !== "boolean") {
      return null;
    }

    return {
      user: parsed.user ?? null,
      adminSetupRequired: parsed.adminSetupRequired
    };
  } catch {
    return null;
  }
}

function persistAuthStatus(status: AuthStatusResponse | null): void {
  try {
    if (!status) {
      window.sessionStorage.removeItem(AUTH_STATUS_CACHE_KEY);
      return;
    }

    window.sessionStorage.setItem(AUTH_STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    // Ignore storage quota and private browsing errors.
  }
}

function getPublicLinks(adminSetupRequired: boolean): MenuItem[] {
  if (adminSetupRequired) {
    return [{ to: "/admin/setup", label: "Admin setup", description: "Create the first admin account for this installation." }];
  }

  return [
    { to: "/student/login", label: "Student login", description: "Open the student Google sign-in flow." },
    { to: "/admin/login", label: "Admin login", description: "Enter the admin workspace with Google." }
  ];
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return (parts.map((part) => part.charAt(0)).join("") || "S").toUpperCase();
}

function getAdminLinks(user: AuthenticatedAdmin): MenuItem[] {
  return [
    { to: "/admin/overview", label: "Overview", description: "See the dashboard and platform settings." },
    { to: "/admin/questions", label: "Questions", description: "Manage the journal entry question bank." },
    { to: "/admin/students", label: "Students", description: "Manage approved student Gmail access." },
    ...(user.isSuperAdmin
      ? [{ to: "/admin/admins", label: "Admins", description: "Manage admin accounts and permissions." }]
      : []),
    { to: "/admin/assistant", label: "AI Bot", description: "Ask about students, results, imports, and settings." }
  ];
}

export function App() {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const topbarRef = useRef<HTMLElement | null>(null);
  const [bootstrapState] = useState(() => {
    const cachedAuthStatus = readCachedAuthStatus();
    return {
      cachedAuthStatus,
      loading: cachedAuthStatus === null
    };
  });
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(bootstrapState.cachedAuthStatus);
  const [loading, setLoading] = useState(bootstrapState.loading);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [menuOpen, setMenuOpen] = useState(false);

  const preloadUserWorkspace = (user: AuthenticatedAdmin | AuthenticatedStudent) => Promise.allSettled([
    preloadWorkspaceRoute(user),
    preloadWorkspaceData(user)
  ]).then(() => undefined);

  const commitAuthStatus = (
    nextStatus: AuthStatusResponse | null,
    options: { warmWorkspace?: boolean } = {}
  ): Promise<void> => {
    const applyState = () => {
      persistAuthStatus(nextStatus);
      if (!nextStatus?.user) {
        clearClientDataCache();
      }
      startTransition(() => {
        setAuthStatus(nextStatus);
      });
      setError("");
      setLoading(false);
    };

    if (!nextStatus?.user) {
      applyState();
      return Promise.resolve();
    }

    if (options.warmWorkspace) {
      return preloadUserWorkspace(nextStatus.user)
        .catch(() => {
          // Fall through to the workspace even if warmup requests fail.
        })
        .then(() => {
          applyState();
        });
    }

    persistAuthStatus(nextStatus);
    void preloadUserWorkspace(nextStatus.user);
    startTransition(() => {
      setAuthStatus(nextStatus);
    });
    setError("");
    setLoading(false);
    return Promise.resolve();
  };

  const applyAuthStatus = (
    nextStatus: AuthStatusResponse,
    options?: { warmWorkspace?: boolean }
  ) => commitAuthStatus(nextStatus, options);

  const refreshAuth = async (options: { silent?: boolean; signal?: AbortSignal } = {}) => {
    const showBlockingLoad = !options.silent && authStatus === null;

    try {
      if (showBlockingLoad) {
        setLoading(true);
      }

      const nextStatus = await fetchAuthStatus({ signal: options.signal });
      void commitAuthStatus(nextStatus);
    } catch (nextError) {
      if (nextError instanceof Error && nextError.name === "AbortError") {
        return;
      }

      if (authStatus === null) {
        persistAuthStatus(null);
      }

      setError(nextError instanceof Error ? nextError.message : "Failed to load auth state.");
    } finally {
      if (showBlockingLoad) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("jet-theme", theme);
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshAuth({
      silent: bootstrapState.cachedAuthStatus !== null,
      signal: controller.signal
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, authStatus?.user?.role]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 860) {
        setMenuOpen(false);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [menuOpen]);

  const handleLogout = async () => {
    const nextStatus = authStatus ? { ...authStatus, user: null } : null;
    void commitAuthStatus(nextStatus);

    try {
      await logout();
      window.google?.accounts.id.disableAutoSelect();
      await refreshAuth({ silent: true });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to log out.");
      await refreshAuth({ silent: true });
    }
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  };

  const user = authStatus?.user ?? null;
  const adminSetupRequired = authStatus?.adminSetupRequired ?? false;
  const authBooting = loading && authStatus === null;
  const defaultPublicPath = adminSetupRequired ? "/admin/setup" : "/student/login";
  const adminHomePath = "/admin/overview";
  const studentHomePath = "/student/overview";
  const homePath = user ? (user.role === "admin" ? adminHomePath : studentHomePath) : defaultPublicPath;
  const publicNavItems = user ? [] : getPublicLinks(adminSetupRequired);
  const workspaceNavItems = user?.role === "admin" ? getAdminLinks(user) : user?.role === "student" ? STUDENT_MENU_ITEMS : [];
  const mobileMenuItems = user
    ? workspaceNavItems
    : publicNavItems.filter((item) => item.to !== "/admin/login" && item.to !== location.pathname);
  const workspaceLabel = user ? (user.role === "admin" ? "Admin workspace" : "Student workspace") : "";
  const workspaceKicker = user ? (user.role === "admin" ? "Operations panel" : "Exam panel") : "";
  const mobileMenuTitle = user ? workspaceLabel : "SkillSpark menu";
  const mobileMenuKicker = user ? workspaceKicker : "Quick access";
  const mobileProfileLine = user
    ? user.role === "admin"
      ? `${user.isSuperAdmin ? "Super admin" : "Administrator"} • ${user.email}`
      : user.email
    : "";
  const isPublicAuthPage = !user && PUBLIC_AUTH_PATHS.has(location.pathname);
  const isAdminWorkspaceRoute = location.pathname.startsWith("/admin/");
  const isStudentWorkspaceRoute = location.pathname.startsWith("/student/") && !PUBLIC_AUTH_PATHS.has(location.pathname);
  const isWorkspaceRoute = Boolean(user) && (isAdminWorkspaceRoute || isStudentWorkspaceRoute);
  const isAdminWorkspacePage = Boolean(user?.role === "admin" && isAdminWorkspaceRoute);
  const routeTransitionKey = isPublicAuthPage
    ? "public-auth"
    : isAdminWorkspaceRoute
      ? "admin-workspace"
      : isStudentWorkspaceRoute
        ? "student-workspace"
        : location.pathname;
  const routeMotion = reduceMotion
    ? {
        initial: { opacity: 1, y: 0 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 1, y: 0 },
        transition: { duration: 0 }
      }
    : {
        initial: { opacity: 0, y: 14 },
        animate: { opacity: 1, y: 0 },
        exit: isPublicAuthPage ? { opacity: 1, y: 0, transition: { duration: 0 } } : { opacity: 0, y: 10 },
        transition: {
          type: "spring" as const,
          stiffness: 360,
          damping: 34,
          mass: 0.82
        }
      };

  const renderMobileMenuBody = () => (
    <div className="mobile-menu-screen__body">
      <div className="mobile-menu-screen__top">
        <div className="mobile-menu-screen__top-copy">
          <span>{mobileMenuKicker}</span>
          <strong id="mobile-menu-title">{mobileMenuTitle}</strong>
        </div>
      </div>

      {user ? (
        <div className="mobile-menu-screen__profile">
          <strong>{user.name}</strong>
          <span>{mobileProfileLine}</span>
        </div>
      ) : null}

      {mobileMenuItems.length ? (
        <div className="mobile-menu-screen__section">
          <span className="mobile-menu-screen__section-label">{user ? "Workspace" : "Navigation"}</span>
          <nav aria-label="Mobile menu list" className="mobile-menu-screen__nav">
            {mobileMenuItems.map((item) => (
              <div key={item.to}>
                <NavLink
                  className={({ isActive }) => `mobile-menu-screen__link ${isActive ? "mobile-menu-screen__link--active" : ""}`}
                  onClick={() => setMenuOpen(false)}
                  to={item.to}
                >
                  <div className="mobile-menu-screen__link-copy">
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </div>
                  <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
                    <path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  </svg>
                </NavLink>
              </div>
            ))}
          </nav>
        </div>
      ) : null}

      <div className="mobile-menu-screen__section">
        <span className="mobile-menu-screen__section-label">Quick actions</span>
        <div className="mobile-menu-screen__actions">
          <div>
            <button className="mobile-menu-screen__action" onClick={toggleTheme} type="button">
              <div className="mobile-menu-screen__link-copy">
                <strong>{theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}</strong>
                <small>Current theme: {theme}</small>
              </div>
              {theme === "dark" ? (
                <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
                  <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M12 2.25V4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M12 19.5v2.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M4.93 4.93l1.6 1.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M17.47 17.47l1.6 1.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M2.25 12H4.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M19.5 12h2.25" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M4.93 19.07l1.6-1.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M17.47 6.53l1.6-1.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              ) : (
                <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
                  <path d="M21 12.2a8.8 8.8 0 1 1-9.2-9.2 7 7 0 0 0 9.2 9.2z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              )}
            </button>
          </div>

          {user ? (
            <div>
              <button
                className="mobile-menu-screen__action mobile-menu-screen__action--danger"
                onClick={() => {
                  setMenuOpen(false);
                  void handleLogout();
                }}
                type="button"
              >
                <div className="mobile-menu-screen__link-copy">
                  <strong>Sign out</strong>
                  <small>End the current session and return to login.</small>
                </div>
                <svg fill="none" height="18" viewBox="0 0 24 24" width="18">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="m16 17 5-5-5-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                  <path d="M21 12H9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  const renderMobileMenuPage = () => (
    <section className={`mobile-menu-page ${isWorkspaceRoute ? "mobile-menu-page--workspace" : "mobile-menu-page--public"}`}>
      <div className="panel mobile-menu-page__panel">
        {renderMobileMenuBody()}
      </div>
    </section>
  );

  const renderAuthPage = (view: AuthView) => (
    <AuthPage applyAuthStatus={applyAuthStatus} authStatus={authStatus} refreshAuth={refreshAuth} view={view} />
  );

  const renderThemeToggle = () => (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      type="button"
    >
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
          <circle cx="12" cy="12" r="4.5" />
          <path d="M12 2.25V4.5" />
          <path d="M12 19.5v2.25" />
          <path d="M4.93 4.93l1.6 1.6" />
          <path d="M17.47 17.47l1.6 1.6" />
          <path d="M2.25 12H4.5" />
          <path d="M19.5 12h2.25" />
          <path d="M4.93 19.07l1.6-1.6" />
          <path d="M17.47 6.53l1.6-1.6" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
          <path d="M21 12.2a8.8 8.8 0 1 1-9.2-9.2 7 7 0 0 0 9.2 9.2z" />
        </svg>
      )}
    </button>
  );

  const renderTopbarIdentity = () => {
    if (!user) return null;
    if (user.role === "student") {
      return (
        <div className="topbar__identity">
          <span aria-hidden="true" className="topbar__identity-avatar">{getInitials(user.name)}</span>
          <div className="topbar__identity-copy">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
        </div>
      );
    }

    return <span className="pill pill--indigo">{user.name}</span>;
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className={`shell ${user ? "shell--workspace" : "shell--public"} ${isPublicAuthPage ? "shell--public-auth" : ""} ${isAdminWorkspacePage ? "shell--admin-workspace" : ""}`}>
      {!reduceMotion ? (
        <AuthFlowFieldBackground
          className="shell__flow-field"
          colorDark="#5eead4"
          colorLight="#0f766e"
          particleCount={180}
          speed={0.36}
          trailOpacity={0.05}
        />
      ) : null}

      {isPublicAuthPage ? (
        <header className="topbar topbar--simple topbar--bare" ref={topbarRef}>
          <Link className="brand brand--logo-only" to={homePath}>
            <img alt="SkillSpark" className="brand__logo brand__logo--header" src={logoUrl} />
          </Link>

          <div className="topbar__actions">
            {renderThemeToggle()}
            <button
              aria-controls="mobile-menu-screen"
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              className="menu-toggle"
              onClick={() => setMenuOpen((prev) => !prev)}
              type="button"
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </header>
      ) : (
        <header className={`topbar ${menuOpen ? "topbar--menu-open" : ""} ${user ? "topbar--bare-workspace" : ""}`} ref={topbarRef}>
          <div className="topbar__main">
            <Link className="brand brand--logo-only" to={homePath}>
              <img alt="SkillSpark" className="brand__logo brand__logo--header" src={logoUrl} />
            </Link>

            {user ? (
              <div className={`topbar__context topbar__context--${user.role}`}>
                <span className="topbar__context-kicker">{workspaceKicker}</span>
                <strong className="topbar__context-title">{workspaceLabel}</strong>
              </div>
            ) : (
              <nav className="topbar__nav" aria-label="Primary">
                {publicNavItems.map((item) => (
                  <NavLink
                    className={({ isActive }) => `topbar__link ${isActive ? "topbar__link--active" : ""}`}
                    key={item.to}
                    to={item.to}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            )}
          </div>

          <div className="topbar__actions">
            {renderTopbarIdentity()}

            {renderThemeToggle()}

            {user ? (
              <button className="button button--ghost topbar__signout" onClick={() => void handleLogout()} type="button">
                Sign out
              </button>
            ) : null}

            <button
              aria-controls="mobile-menu-screen"
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              className="menu-toggle"
              onClick={() => setMenuOpen((prev) => !prev)}
              type="button"
            >
              <span />
              <span />
              <span />
            </button>
          </div>
        </header>
      )}

      {error ? (
        <div className="app-banner-wrap">
          <div className="banner banner--error">{error}</div>
        </div>
      ) : null}

      <main className={`page ${isPublicAuthPage ? "page--public-auth" : ""} ${isAdminWorkspacePage ? "page--admin-workspace" : ""}`}>
        <ErrorBoundary>
        {authBooting ? (
          <WorkspaceBoot
            eyebrow="Loading workspace"
            title="Restoring your current page."
            copy="Checking your session and warming the next workspace."
          />
        ) : menuOpen ? (
          renderMobileMenuPage()
        ) : (
          <AnimatePresence initial={false} mode="sync">
            <motion.div
              animate={routeMotion.animate}
              className={`page-route ${isPublicAuthPage ? "page-route--public-auth" : ""} ${isAdminWorkspacePage ? "page-route--admin-workspace" : ""}`}
              exit={routeMotion.exit}
              initial={routeMotion.initial}
              key={routeTransitionKey}
              transition={routeMotion.transition}
            >
              <Routes location={location}>
                <Route path="/" element={<Navigate replace to={homePath} />} />

                <Route
                  path="/student/login"
                  element={
                    user
                      ? <Navigate replace to={user.role === "admin" ? adminHomePath : studentHomePath} />
                      : adminSetupRequired
                        ? <Navigate replace to="/admin/setup" />
                        : renderAuthPage("student-login")
                  }
                />
                <Route
                  path="/student/register"
                  element={<Navigate replace to="/student/login" />}
                />
                <Route
                  path="/admin/login"
                  element={
                    user
                      ? <Navigate replace to={user.role === "admin" ? adminHomePath : studentHomePath} />
                      : adminSetupRequired
                        ? <Navigate replace to="/admin/setup" />
                        : renderAuthPage("admin-login")
                  }
                />
                <Route
                  path="/admin/setup"
                  element={
                    adminSetupRequired
                      ? renderAuthPage("admin-setup")
                      : user?.role === "admin"
                        ? <Navigate replace to={adminHomePath} />
                        : <Navigate replace to="/admin/login" />
                  }
                />

                <Route
                  path="/admin"
                  element={
                    user?.role === "admin"
                      ? <Navigate replace to={adminHomePath} />
                      : <Navigate replace to={adminSetupRequired ? "/admin/setup" : "/admin/login"} />
                  }
                />
                <Route
                  path="/admin/:section"
                  element={
                    user?.role === "admin"
                      ? <AdminWorkspaceRoute user={user} />
                      : <Navigate replace to={adminSetupRequired ? "/admin/setup" : "/admin/login"} />
                  }
                />
                <Route
                  path="/student"
                  element={
                    user?.role === "student"
                      ? <Navigate replace to={studentHomePath} />
                      : <Navigate replace to={adminSetupRequired ? "/admin/setup" : "/student/login"} />
                  }
                />
                <Route
                  path="/student/:section"
                  element={
                    user?.role === "student"
                      ? <StudentWorkspaceRoute user={user} />
                      : <Navigate replace to={adminSetupRequired ? "/admin/setup" : "/student/login"} />
                  }
                />

                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="*" element={<Navigate replace to={homePath} />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        )}
        </ErrorBoundary>
      </main>
      </div>
    </MotionConfig>
  );
}
