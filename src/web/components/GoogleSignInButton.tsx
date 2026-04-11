import { useEffect, useRef, useState } from "react";

const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";

let googleScriptPromise: Promise<void> | null = null;

function resetGoogleIdentityScript() {
  googleScriptPromise = null;

  const managedScript = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_IDENTITY_SCRIPT_URL}"][data-managed-google-identity="true"]`);
  managedScript?.remove();
}

function waitForGoogleIdentityApi(timeoutMs = 4000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const check = () => {
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error("Failed to load Google sign-in."));
        return;
      }

      window.setTimeout(check, 50);
    };

    check();
  });
}

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.id) {
    return Promise.resolve();
  }

  if (googleScriptPromise) {
    return googleScriptPromise;
  }

  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_IDENTITY_SCRIPT_URL}"]`);
    if (existingScript) {
      const handleLoad = () => {
        void waitForGoogleIdentityApi().then(resolve).catch(reject);
      };
      const handleError = () => reject(new Error("Failed to load Google sign-in."));

      existingScript.addEventListener("load", handleLoad, { once: true });
      existingScript.addEventListener("error", handleError, { once: true });

      window.setTimeout(() => {
        if (window.google?.accounts?.id) {
          resolve();
        } else if (existingScript.dataset.googleIdentityStatus === "loaded") {
          handleLoad();
        }
      }, 0);

      return;
    }

    const script = document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.dataset.managedGoogleIdentity = "true";
    script.dataset.googleIdentityStatus = "loading";
    script.onload = () => {
      script.dataset.googleIdentityStatus = "loaded";
      void waitForGoogleIdentityApi().then(resolve).catch(reject);
    };
    script.onerror = () => {
      script.dataset.googleIdentityStatus = "error";
      reject(new Error("Failed to load Google sign-in."));
    };
    document.head.appendChild(script);
  });

  return googleScriptPromise.catch((nextError) => {
    resetGoogleIdentityScript();
    throw nextError;
  });
}

interface GoogleSignInButtonProps {
  clientId: string;
  disabled?: boolean;
  onCredential: (credential: string) => void;
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  role?: "student" | "admin";
}

function getGoogleButtonLabel(text: GoogleSignInButtonProps["text"]): string {
  switch (text) {
    case "signup_with":
      return "Sign up with Google";
    case "signin":
      return "Sign in";
    case "signin_with":
      return "Sign in with Google";
    case "continue_with":
    default:
      return "Continue with Google";
  }
}

export function GoogleSignInButton({
  clientId,
  disabled = false,
  onCredential,
  text = "signin_with",
  role = "student"
}: GoogleSignInButtonProps) {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const onCredentialRef = useRef(onCredential);
  const disabledRef = useRef(disabled);
  const [error, setError] = useState("");
  const visibleLabel = getGoogleButtonLabel(text);

  useEffect(() => {
    onCredentialRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    if (!clientId) {
      setError("Google sign-in is not configured.");
      return;
    }

    let cancelled = false;

    const renderGoogleButton = async () => {
      const tryRender = async () => {
        await loadGoogleIdentityScript();

        if (cancelled || !buttonRef.current || !window.google?.accounts?.id) {
          return;
        }

        const container = buttonRef.current;
        container.replaceChildren();

        // Use the direct credential callback flow in every environment.
        // This keeps production aligned with local development and only
        // requires the deployed frontend origin to be authorized in Google.
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (disabledRef.current || !response.credential) {
              return;
            }

            onCredentialRef.current(response.credential);
          }
        });

        window.google.accounts.id.renderButton(container, {
          type: "standard",
          theme: "filled_black",
          size: "large",
          text,
          shape: "pill",
          logo_alignment: "left",
          width: Math.max(280, Math.min(360, container.clientWidth || 344))
        });
      };

      try {
        setError("");
        await tryRender();
        if (!cancelled) {
          setError("");
        }
      } catch (nextError) {
        if (cancelled) {
          return;
        }

        try {
          resetGoogleIdentityScript();
          await tryRender();
          if (!cancelled) {
            setError("");
          }
        } catch (retryError) {
          if (cancelled) {
            return;
          }

          setError(retryError instanceof Error ? retryError.message : "Failed to initialize Google sign-in.");
        }
      }
    };

    void renderGoogleButton();

    return () => {
      cancelled = true;
    };
  }, [clientId, text]);

  return (
    <div className="google-signin">
      <div className={`google-signin__shell ${disabled ? "google-signin__shell--disabled" : ""}`}>
        <div aria-hidden="true" className="google-signin__surface">
          <span className="google-signin__mark">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path
                d="M21.805 12.229c0-.682-.061-1.336-.176-1.964H12v3.718h5.503a4.71 4.71 0 0 1-2.042 3.09v2.56h3.296c1.93-1.777 3.048-4.397 3.048-7.404Z"
                fill="#4285F4"
              />
              <path
                d="M12 22c2.76 0 5.075-.915 6.766-2.476l-3.296-2.56c-.914.611-2.08.971-3.47.971-2.667 0-4.927-1.8-5.734-4.22H2.86v2.645A10 10 0 0 0 12 22Z"
                fill="#34A853"
              />
              <path
                d="M6.266 13.715A5.987 5.987 0 0 1 5.945 12c0-.595.115-1.17.321-1.715V7.64H2.86A9.993 9.993 0 0 0 2 12c0 1.613.386 3.141 1.07 4.36l3.196-2.645Z"
                fill="#FBBC04"
              />
              <path
                d="M12 6.065c1.5 0 2.846.516 3.907 1.531l2.93-2.93C17.07 2.976 14.757 2 12 2A10 10 0 0 0 3.07 7.64l3.196 2.645c.807-2.42 3.067-4.22 5.734-4.22Z"
                fill="#EA4335"
              />
            </svg>
          </span>

          <span className="google-signin__label">{visibleLabel}</span>

          <span className="google-signin__orbit">
            <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
              <path d="m6 3 5 5-5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
            </svg>
          </span>
        </div>

        <div aria-disabled={disabled} className={`google-signin__button ${disabled ? "google-signin__button--disabled" : ""}`} ref={buttonRef} />
      </div>

      {error ? <div className="google-signin__error">{error}</div> : null}
    </div>
  );
}
