import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  capturePickerScrollSnapshot,
  getFloatingPickerStyle,
  restorePickerScrollSpace,
  shiftPickerViewportForMenu,
  type FloatingPickerStyle,
  type PickerScrollSnapshot
} from "./floatingPicker";

const motionEase = [0.22, 1, 0.36, 1] as const;
const closeEase = [0.4, 0, 1, 1] as const;

export interface SurfaceSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

interface SurfaceSelectProps {
  allowClear?: boolean;
  ariaLabel?: string;
  compact?: boolean;
  clearLabel?: string;
  emptyLabel?: string;
  options: SurfaceSelectOption[];
  onChange: (next: string) => void;
  placeholder: string;
  value: string;
}

export function SurfaceSelect({
  allowClear = false,
  ariaLabel,
  compact = false,
  clearLabel = "Clear selection",
  emptyLabel = "No options available",
  options,
  onChange,
  placeholder,
  value
}: SurfaceSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuMounted, setMenuMounted] = useState(false);
  const [menuStyle, setMenuStyle] = useState<FloatingPickerStyle | null>(null);
  const reduceMotion = Boolean(useReducedMotion());
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const scrollSnapshotRef = useRef<PickerScrollSnapshot | null>(null);
  const selectedOption = options.find((option) => option.value === value);
  const menuOptionCount = Math.max(options.length + (allowClear ? 1 : 0), 1);
  const menuTargetHeight = Math.max(56, menuOptionCount * 42 + 20);
  const menuTransition = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 320, damping: 30, mass: 0.9 };
  const menuVariants = {
    open: reduceMotion ? { opacity: 1 } : {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: {
        opacity: { duration: 0.2, ease: motionEase },
        scale: { duration: 0.2, ease: motionEase },
        y: menuTransition
      }
    },
    closed: reduceMotion ? { opacity: 0 } : {
      opacity: 0,
      y: -8,
      scale: 0.985,
      transition: {
        duration: 0.18,
        ease: closeEase
      }
    }
  };
  const optionVariants = {
    open: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.2, ease: motionEase } },
    closed: reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, transition: { duration: 0.14, ease: closeEase } }
  };

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

      setMenuStyle(getFloatingPickerStyle(triggerRef.current.getBoundingClientRect(), menuTargetHeight));
    };

    const maybeShiftViewport = () => {
      if (!triggerRef.current) {
        return false;
      }

      return shiftPickerViewportForMenu(
        scrollSnapshotRef.current,
        triggerRef.current.getBoundingClientRect(),
        menuTargetHeight,
        menuRef.current?.getBoundingClientRect()
      );
    };

    const focusTrigger = () => {
      try {
        triggerRef.current?.focus({ preventScroll: true });
      } catch {
        triggerRef.current?.focus();
      }
    };

    const syncMenu = () => {
      updateMenuPosition();
      maybeShiftViewport();
    };
    const handleScroll = () => {
      updateMenuPosition();
    };
    const handleResize = () => {
      syncMenu();
    };

    let nestedAnimationFrame = 0;
    const animationFrame = window.requestAnimationFrame(() => {
      syncMenu();
      nestedAnimationFrame = window.requestAnimationFrame(() => {
        syncMenu();
        focusTrigger();
      });
    });

    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(nestedAnimationFrame);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [menuMounted, menuTargetHeight, open]);

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
          style={{
            left: menuStyle.left,
            top: menuStyle.top,
            width: menuStyle.width,
            maxHeight: menuStyle.maxHeight
          }}
          variants={menuVariants}
        >
          {allowClear ? (
            <motion.button
              aria-selected={!value}
              className={`account-picker__option ${!value ? "account-picker__option--active" : ""}`}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              role="option"
              type="button"
              variants={optionVariants}
            >
              {clearLabel}
            </motion.button>
          ) : null}
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
        </motion.div>,
        document.body
      ) : null}
    </div>
  );
}
