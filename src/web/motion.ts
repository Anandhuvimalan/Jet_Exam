/**
 * Shared animation constants for consistent motion across the app.
 * All durations, springs, and easings in one place.
 */

export const springs = {
  snappy: { type: "spring" as const, stiffness: 500, damping: 30, mass: 0.8 },
  smooth: { type: "spring" as const, stiffness: 360, damping: 34, mass: 0.82 },
  gentle: { type: "spring" as const, stiffness: 260, damping: 28, mass: 1 },
  bouncy: { type: "spring" as const, stiffness: 420, damping: 22, mass: 0.7 },
  menu: { type: "spring" as const, stiffness: 420, damping: 36, mass: 0.78 }
} as const;

export const easings = {
  standard: [0.22, 1, 0.36, 1] as const,
  decelerate: [0, 0, 0.2, 1] as const,
  accelerate: [0.4, 0, 1, 1] as const,
  sharp: [0.4, 0, 0.6, 1] as const
} as const;

export const durations = {
  instant: 0.1,
  fast: 0.15,
  normal: 0.25,
  slow: 0.45,
  page: 0.35
} as const;

/** Standard page transition variants */
export const pageTransition = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 10 },
  transition: springs.smooth
} as const;

/** Staggered list item variants */
export const staggerContainer = {
  animate: {
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.06
    }
  }
} as const;

export const staggerItem = {
  initial: { opacity: 0, y: 8 },
  animate: {
    opacity: 1,
    y: 0,
    transition: springs.snappy
  }
} as const;

/** Card hover / tap interaction */
export const cardInteraction = {
  whileHover: { y: -2, transition: { duration: durations.fast } },
  whileTap: { scale: 0.985, transition: { duration: durations.instant } }
} as const;

/** Fade in animation */
export const fadeIn = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { duration: durations.normal, ease: easings.standard }
} as const;

/** Scale in for modals/popups */
export const scaleIn = {
  initial: { opacity: 0, scale: 0.95 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
  transition: springs.snappy
} as const;

/** Slide in from bottom for mobile panels */
export const slideUp = {
  initial: { y: "100%" },
  animate: { y: 0, transition: springs.menu },
  exit: { y: "100%", transition: { duration: durations.fast, ease: easings.accelerate } }
} as const;

/** Reduced motion fallbacks - returns identity transforms */
export function withReducedMotion<T extends Record<string, unknown>>(
  variants: T,
  prefersReduced: boolean | null
): T {
  if (!prefersReduced) return variants;

  const reduced = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(variants)) {
    if (typeof value === "object" && value !== null) {
      reduced[key] = { ...value as Record<string, unknown>, opacity: (value as Record<string, unknown>).opacity ?? 1, y: 0, x: 0, scale: 1 };
    } else {
      reduced[key] = value;
    }
  }
  return reduced as T;
}
