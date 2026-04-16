import { animate, type AnimationPlaybackControls } from "framer-motion";

export interface FloatingPickerStyle {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export interface PickerScrollSnapshot {
  container: HTMLElement | null;
  spacerTarget: HTMLElement;
  spacerPaddingBottom: string;
  scrollAnimation?: AnimationPlaybackControls | null;
}

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function canHostPickerScroll(node: HTMLElement | null) {
  if (!node) {
    return false;
  }

  const style = window.getComputedStyle(node);
  return /(auto|scroll|overlay)/.test(style.overflowY);
}

function findScrollableAncestor(node: HTMLElement | null) {
  let current = node?.parentElement ?? null;

  while (current) {
    if (canHostPickerScroll(current)) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function findPageScrollRoot(node: HTMLElement | null) {
  let current = node?.parentElement ?? null;

  while (current) {
    if (
      current.matches(".admin-console__main, .student-result-overlay, .student-result-sheet, .shell--workspace, .shell--public-auth")
      && canHostPickerScroll(current)
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function findPageSpacerTarget(node: HTMLElement | null) {
  return node?.closest(".admin-console__content, .admin-stage, .student-page, .student-home, .page-route, .page") as HTMLElement | null;
}

export function capturePickerScrollSnapshot(node: HTMLElement | null): PickerScrollSnapshot {
  const pageScrollRoot = findPageScrollRoot(node);
  const container = pageScrollRoot ?? findScrollableAncestor(node);
  const pageSpacerTarget = pageScrollRoot ? findPageSpacerTarget(node) : null;
  const spacerTarget = pageSpacerTarget ?? container ?? (
    document.scrollingElement instanceof HTMLElement
      ? document.scrollingElement
      : document.body
  );

  return {
    container,
    spacerTarget,
    spacerPaddingBottom: spacerTarget.style.paddingBottom,
    scrollAnimation: null
  };
}

function ensurePickerScrollSpace(snapshot: PickerScrollSnapshot | null, requiredSpace: number) {
  if (!snapshot || requiredSpace <= 0) {
    return;
  }

  const currentPaddingBottom = Number.parseFloat(window.getComputedStyle(snapshot.spacerTarget).paddingBottom) || 0;
  snapshot.spacerTarget.style.paddingBottom = `${Math.ceil(currentPaddingBottom + requiredSpace)}px`;
}

export function restorePickerScrollSpace(snapshot: PickerScrollSnapshot | null) {
  if (!snapshot) {
    return;
  }

  if (snapshot.scrollAnimation) {
    snapshot.scrollAnimation.stop();
    snapshot.scrollAnimation = null;
  }
  snapshot.spacerTarget.style.paddingBottom = snapshot.spacerPaddingBottom;
}

function animatePickerScroll(snapshot: PickerScrollSnapshot | null, nextTop: number) {
  if (!snapshot) {
    return false;
  }

  const getCurrentTop = () => snapshot.container ? snapshot.container.scrollTop : window.scrollY;
  const setTop = (top: number) => {
    if (snapshot.container) {
      snapshot.container.scrollTo({
        left: snapshot.container.scrollLeft,
        top,
        behavior: "auto"
      });
      return;
    }

    window.scrollTo({
      left: window.scrollX,
      top,
      behavior: "auto"
    });
  };

  const startTop = getCurrentTop();
  if (nextTop <= startTop + 0.5) {
    return false;
  }

  if (snapshot.scrollAnimation) {
    snapshot.scrollAnimation.stop();
    snapshot.scrollAnimation = null;
  }

  if (prefersReducedMotion()) {
    setTop(nextTop);
    return true;
  }

  snapshot.scrollAnimation = animate(startTop, nextTop, {
    duration: 0.24,
    ease: [0.22, 1, 0.36, 1],
    onUpdate: (latest) => {
      setTop(latest);
    },
    onComplete: () => {
      setTop(nextTop);
      snapshot.scrollAnimation = null;
    }
  });
  return true;
}

export function shiftPickerViewportForMenu(
  snapshot: PickerScrollSnapshot | null,
  triggerRect: DOMRect,
  menuHeight: number,
  menuRect?: DOMRect
) {
  const gutter = 12;
  const gap = 8;
  const targetBottom = menuRect?.bottom ?? (triggerRect.bottom + gap + menuHeight);
  const overflow = Math.ceil(targetBottom - (window.innerHeight - gutter));

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

    return animatePickerScroll(snapshot, nextTop);
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

  return animatePickerScroll(snapshot, nextTop);
}

export function getFloatingPickerStyle(triggerRect: DOMRect, menuTargetHeight: number): FloatingPickerStyle {
  const gutter = 12;
  const gap = 8;
  const viewportWidth = window.innerWidth;
  const width = Math.min(triggerRect.width, Math.max(0, viewportWidth - gutter * 2));
  const left = Math.max(gutter, Math.min(triggerRect.left, viewportWidth - gutter - width));

  return {
    left,
    top: triggerRect.bottom + gap,
    width,
    maxHeight: menuTargetHeight
  };
}
