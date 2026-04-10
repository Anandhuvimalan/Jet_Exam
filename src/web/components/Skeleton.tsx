/**
 * Loading skeleton components for smooth perceived performance.
 * Consistent shimmer animation across all loading states.
 */

interface SkeletonProps {
  width?: string;
  height?: string;
  borderRadius?: string;
  className?: string;
}

export function Skeleton({ width = "100%", height = "16px", borderRadius = "var(--r-sm)", className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius }}
    />
  );
}

export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton-text ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          width={i === lines - 1 ? "60%" : "100%"}
          height="14px"
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`skeleton-card ${className}`} aria-hidden="true">
      <Skeleton height="20px" width="40%" />
      <SkeletonText lines={2} />
      <Skeleton height="32px" width="30%" borderRadius="var(--r-pill)" />
    </div>
  );
}

export function SkeletonTable({ rows = 5, cols = 4, className = "" }: { rows?: number; cols?: number; className?: string }) {
  return (
    <div className={`skeleton-table ${className}`} aria-hidden="true">
      <div className="skeleton-table__header">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} height="14px" width={`${60 + Math.random() * 40}%`} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div key={rowIndex} className="skeleton-table__row">
          {Array.from({ length: cols }, (_, colIndex) => (
            <Skeleton key={colIndex} height="14px" width={`${40 + Math.random() * 50}%`} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="skeleton-dashboard" aria-hidden="true" aria-label="Loading dashboard">
      <div className="skeleton-dashboard__header">
        <Skeleton height="28px" width="200px" />
        <Skeleton height="14px" width="140px" />
      </div>
      <div className="skeleton-dashboard__cards">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonTable rows={4} cols={5} />
    </div>
  );
}
