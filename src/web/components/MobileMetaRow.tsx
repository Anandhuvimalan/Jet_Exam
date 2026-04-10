import type { ReactNode } from "react";

type MobileMetaIcon = "calendar" | "mode" | "score" | "rows" | "register" | "attempts" | "status" | "user";

function MobileMetaGlyph({ icon }: { icon: MobileMetaIcon }) {
  if (icon === "calendar") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <rect height="16" rx="3" stroke="currentColor" strokeWidth="1.8" width="18" x="3" y="5" />
        <path d="M16 3v4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M8 3v4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M3 10h18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "mode") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path d="M4 7h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M4 12h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M4 17h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "score") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 4v2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M20 12h-2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "rows") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path d="M5 7h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M5 17h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "register") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <rect height="14" rx="3" stroke="currentColor" strokeWidth="1.8" width="18" x="3" y="5" />
        <circle cx="8" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M13 10h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M13 14h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "attempts") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path d="M6 16V8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M12 16V5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
        <path d="M18 16v-3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
      </svg>
    );
  }

  if (icon === "status") {
    return (
      <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
        <path d="M12 3 6 5.5v5.5c0 4.1 2.4 7.8 6 9 3.6-1.2 6-4.9 6-9V5.5L12 3Z" stroke="currentColor" strokeWidth="1.8" />
        <path d="m9.5 12 1.7 1.7 3.3-3.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      </svg>
    );
  }

  return (
    <svg fill="none" height="16" viewBox="0 0 24 24" width="16">
      <circle cx="12" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5.5 19c1.1-2.9 3.6-4.5 6.5-4.5s5.4 1.6 6.5 4.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </svg>
  );
}

export function MobileMetaRow({
  icon,
  label,
  value
}: {
  icon: MobileMetaIcon;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="mobile-meta-row">
      <span aria-hidden="true" className="mobile-meta-row__icon">
        <MobileMetaGlyph icon={icon} />
      </span>
      <div className="mobile-meta-row__content">
        <small>{label}</small>
        <div className="mobile-meta-row__value">{value}</div>
      </div>
    </div>
  );
}
