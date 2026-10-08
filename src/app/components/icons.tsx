'use client';

/**
 * Inline SVG icons for the sidebar and mobile navigation: hand-rolled paths
 * on a 24px grid, drawn at 20px with a 1.5px stroke in currentColor and
 * rounded caps and joins. No icon library, no runtime fetch; each icon is
 * aria-hidden because the nav items always carry a visible text label.
 */
import type { ViewId } from './shared';

interface ViewIconProps {
  view: ViewId;
  /** Pixel size of the square icon; defaults to 20. */
  size?: number;
}

/** Four rounded squares: the at-a-glance home view. */
function DashboardIcon({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </svg>
  );
}

/** Concentric rings: a target, the goal-planting view. */
function GoalsIcon({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Two stacked cards, the one in front offset: the wallet view. */
function CardsIcon({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="7" width="15" height="12.5" rx="2.5" />
      <path d="M7.5 7V5.5A2 2 0 0 1 9.5 3.5H19a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-1" />
      <path d="M3 11h15" />
    </svg>
  );
}

/** A speech bubble with a spark: the conversational adviser view. */
function AdviserIcon({ size }: { size: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4.2 3.2A.5.5 0 0 1 4 19.8V6.5Z" />
      <path d="M12 7.2l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3 1-2.1Z" />
    </svg>
  );
}

/** The one icon each navigation item shows, keyed by view id. */
export function ViewIcon({ view, size = 20 }: ViewIconProps): React.ReactElement {
  if (view === 'goals') {
    return <GoalsIcon size={size} />;
  }
  if (view === 'cards') {
    return <CardsIcon size={size} />;
  }
  if (view === 'adviser') {
    return <AdviserIcon size={size} />;
  }
  return <DashboardIcon size={size} />;
}
