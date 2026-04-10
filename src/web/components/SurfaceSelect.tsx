import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

const motionEase = [0.22, 1, 0.36, 1] as const;
const closeEase = [0.4, 0, 1, 1] as const;

export interface SurfaceSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface SurfaceSelectProps {
  ariaLabel?: string;
  compact?: boolean;
  emptyLabel?: string;
  options: SurfaceSelectOption[];
  onChange: (next: string) => void;
  placeholder: string;
  value: string;
}

export function SurfaceSelect({
  ariaLabel,
  compact = false,
  emptyLabel = "No options available",
  options,
  onChange,
  placeholder,
  value
}: SurfaceSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === value);
  const menuTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 420, damping: 36, mass: 0.76 };
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

  useEffect(() => {
    if (open) {
      setMenuMounted(true);
    }
  }, [open]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && event.button !== 0) {
        return;
      }

      if (!(event.target instanceof Node)) return;
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  return (
    <div
      className={["account-picker", compact ? "account-picker--compact" : "", menuMounted ? "account-picker--layered" : "", open ? "account-picker--open" : ""]
        .filter(Boolean)
        .join(" ")}
      ref={rootRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={`account-picker__trigger ${value ? "" : "account-picker__trigger--placeholder"}`}
        onClick={() => setOpen((prev) => !prev)}
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

      {menuMounted ? (
        <motion.div
          animate={open ? "open" : "closed"}
          className="account-picker__menu"
          initial="closed"
          onAnimationComplete={() => {
            if (!open) {
              setMenuMounted(false);
            }
          }}
          role="listbox"
          variants={menuVariants}
        >
          {options.length ? (
            options.map((option) => (
              <motion.button
                aria-selected={value === option.value}
                className={`account-picker__option ${value === option.value ? "account-picker__option--active" : ""}`}
                disabled={option.disabled}
                key={option.value}
                onClick={() => {
                  if (option.disabled) {
                    return;
                  }
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
                variants={optionVariants}
              >
                {option.label}
              </motion.button>
            ))
          ) : (
            <motion.button className="account-picker__option" disabled type="button" variants={optionVariants}>
              {emptyLabel}
            </motion.button>
          )}
        </motion.div>
      ) : null}
    </div>
  );
}
