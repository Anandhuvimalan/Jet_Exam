import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMemo, useState } from "react";
import type { AuthStatusResponse, GoogleAuthRequest } from "../../shared/types";
import { loginWithGoogle } from "../api";
import { AuthFlowFieldBackground } from "../components/AuthFlowFieldBackground";
import { GoogleSignInButton } from "../components/GoogleSignInButton";

type AuthView = "student-login" | "admin-login" | "admin-setup";
type AuthTone = "student" | "admin";

interface AuthMeta {
  eyebrow: string;
  title: string;
  panelCopy: string;
  tone: AuthTone;
  helper: string;
  footer: string;
  primaryLabel: string;
}

interface AuthPageProps {
  applyAuthStatus: (status: AuthStatusResponse, options?: { warmWorkspace?: boolean }) => Promise<void>;
  authStatus: AuthStatusResponse | null;
  refreshAuth: () => Promise<void>;
  view: AuthView;
}

const motionEase = [0.22, 1, 0.36, 1] as const;

function getViewMeta(view: AuthView): AuthMeta {
  if (view === "admin-setup") {
    return {
      eyebrow: "Admin setup",
      title: "Initialize the admin workspace.",
      panelCopy: "Sign in with the reserved super admin Gmail account.",
      tone: "admin",
      helper: "",
      footer: "After setup, additional admins must be added by a super admin using name and Gmail address.",
      primaryLabel: "Continue with Google"
    };
  }

  if (view === "admin-login") {
    return {
      eyebrow: "Admin access",
      title: "Enter the control panel.",
      panelCopy: "Sign in with your authorized admin Gmail account.",
      tone: "admin",
      helper: "",
      footer: "If your Google account is not authorized, contact the SkillSpark super admin.",
      primaryLabel: "Sign in with Google"
    };
  }

  return {
    eyebrow: "Student access",
    title: "Enter your exam workspace.",
    panelCopy: "Continue with the Gmail account added to your SkillSpark student record.",
    tone: "student",
    helper: "",
    footer: "If you cannot sign in, contact SkillSpark administrator.",
    primaryLabel: "Continue with Google"
  };
}

function StudentBrandScene() {
  const reduceMotion = useReducedMotion();
  const sceneTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 340, damping: 32, mass: 0.84 };

  return (
    <div className="auth-premium-scene auth-premium-scene--login">
      {!reduceMotion ? (
        <AuthFlowFieldBackground
          className="auth-premium-flow"
          colorDark="#67e8f9"
          colorLight="#0f766e"
          particleCount={120}
          speed={0.5}
          trailOpacity={0.08}
        />
      ) : null}
      <div className="auth-premium-backdrop" aria-hidden="true" />

      <div className="auth-premium-grid">
        <div className="auth-premium-intro-shell">
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="auth-premium-intro"
            initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
            transition={sceneTransition}
          >
            <span className="auth-premium-kicker">Student login</span>
            <span className="auth-premium-eyebrow">Google access</span>
            <h3 className="auth-premium-title">Open your journal entry dashboard with one sign-in.</h3>
            <p className="auth-premium-copy">Use the Gmail account already added by your administrator and continue straight into the timed practice workspace.</p>
          </motion.div>
        </div>

        <motion.div className="auth-premium-content" transition={sceneTransition}>
          <div className="auth-premium-guides">
            {[
              { title: "Google login", copy: "Use the same Gmail account every time." },
              { title: "Admin-controlled", copy: "Only approved student accounts can enter." }
            ].map((guide, index) => (
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="auth-premium-guide"
                initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 18 }}
                key={guide.title}
                transition={reduceMotion ? { duration: 0 } : { duration: 0.3, delay: index * 0.05, ease: motionEase }}
              >
                <span className="auth-premium-guide__index">0{index + 1}</span>
                <div className="auth-premium-guide__copy">
                  <strong>{guide.title}</strong>
                  <p>{guide.copy}</p>
                </div>
              </motion.div>
            ))}
          </div>

          <div className="auth-premium-modes" aria-label="Exam modes">
            {["Easy", "Medium", "Hard"].map((mode) => (
              <span className={`auth-premium-mode auth-premium-mode--${mode.toLowerCase()}`} key={mode}>{mode}</span>
            ))}
          </div>

          <p className="auth-premium-note">If your Gmail is not recognized, contact SkillSpark administrator.</p>
        </motion.div>
      </div>
    </div>
  );
}

function AdminBrandScene({ setup }: { setup: boolean }) {
  const reduceMotion = useReducedMotion();
  const sceneTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 340, damping: 32, mass: 0.84 };

  return (
    <div className={`auth-admin-scene auth-admin-scene--${setup ? "setup" : "login"}`}>
      {!reduceMotion ? (
        <AuthFlowFieldBackground
          className="auth-admin-flow"
          colorDark={setup ? "#60a5fa" : "#38bdf8"}
          colorLight="#0f766e"
          particleCount={92}
          speed={0.34}
          trailOpacity={0.07}
        />
      ) : null}
      <div className="auth-admin-backdrop" aria-hidden="true" />

      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="auth-admin-visual"
        initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
        transition={sceneTransition}
      >
        <div className="auth-admin-core" aria-hidden="true">
          <div className="auth-admin-core__stack">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="auth-admin-node auth-admin-node--top" aria-hidden="true"><span /><span /><span /></div>
        <div className="auth-admin-node auth-admin-node--left" aria-hidden="true"><span /><span /><span /></div>
        <div className="auth-admin-node auth-admin-node--bottom" aria-hidden="true"><span /><span /><span /></div>
      </motion.div>
    </div>
  );
}

export function AuthPage({ applyAuthStatus, authStatus, refreshAuth, view }: AuthPageProps) {
  const reduceMotion = Boolean(useReducedMotion());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const meta = useMemo(() => getViewMeta(view), [view]);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
  const role: GoogleAuthRequest["role"] = view === "student-login" ? "student" : "admin";
  const stageTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 340, damping: 32, mass: 0.82 };

  const submitGoogleLogin = async (payload: GoogleAuthRequest) => {
    try {
      setLoading(true);
      const result = await loginWithGoogle(payload);
      setError("");
      await applyAuthStatus(result, { warmWorkspace: true });
    } catch (nextError) {
      setLoading(false);
      setError(nextError instanceof Error ? nextError.message : "Google sign-in failed.");
      await refreshAuth();
    }
  };

  return (
    <section className={`auth-shell auth-shell--${meta.tone}`}>
      <div className={`panel auth-frame auth-frame--${meta.tone}`}>
        <div className={`auth-showcase auth-showcase--${meta.tone}`}>
          {meta.tone === "student" ? <StudentBrandScene /> : <AdminBrandScene setup={view === "admin-setup"} />}
        </div>

        <div className="auth-side">
          <AnimatePresence initial={false} mode="sync">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className="auth-side__header"
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              initial={reduceMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
              key={`${view}-header`}
              transition={stageTransition}
            >
              <span className="eyebrow">{meta.eyebrow}</span>
              <h2>{meta.title}</h2>
              <p className="section-copy">{meta.panelCopy}</p>
            </motion.div>
          </AnimatePresence>

          {error ? <div className="banner banner--error">{error}</div> : null}

          <div className="auth-direct-signin">
            <GoogleSignInButton
              clientId={googleClientId}
              disabled={loading}
              onCredential={(credential) => {
                void submitGoogleLogin({ credential, role });
              }}
              text="continue_with"
            />

            {!googleClientId ? (
              <small className="auth-direct-signin__warning">Set `VITE_GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_ID` to enable Google sign-in.</small>
            ) : null}
          </div>

          {meta.helper ? <p className="auth-footnote">{meta.helper}</p> : null}
        </div>
      </div>

      {loading ? (
        <div aria-live="polite" className="auth-progress-overlay" role="status">
          <div className="auth-progress-card">
            <div aria-hidden="true" className="auth-progress-orb" />
            <span className="eyebrow">{meta.tone === "admin" ? "Admin sign-in" : "Student sign-in"}</span>
            <h3>Opening your workspace.</h3>
            <p className="section-copy">
              {meta.tone === "admin"
                ? "Verifying your Google account and preparing the admin workspace."
                : "Verifying your Google account and preparing your exam workspace."}
            </p>
            <div aria-hidden="true" className="auth-progress-track">
              <span />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
