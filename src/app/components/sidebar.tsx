'use client';

/**
 * Desktop application sidebar: the SpendWise wordmark, the four navigation
 * items (Dashboard, Goals, Cards, Adviser) with inline SVG icons, and a quiet
 * secondary area holding the compact profile summary, the Edit profile
 * button and the data actions (export, import, sample journey) that used to
 * live in the old footer. Fixed at 216px on the left from 900px up, gone
 * below that, where MobileNav takes over. The secondary block is exported
 * separately so the mobile More sheet renders the identical content.
 */
import { spaceLabel, fmtMoney, type SpaceId, type UserProfile, type ViewId } from './shared';
import { ViewIcon } from './icons';

/** The navigation contract shared by the sidebar and the mobile nav bar. */
export const VIEW_NAV_ITEMS: ReadonlyArray<{ id: ViewId; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'goals', label: 'Goals' },
  { id: 'cards', label: 'Cards' },
  { id: 'adviser', label: 'Adviser' },
];

interface SidebarProps extends SidebarSecondaryProps {
  view: ViewId;
  onSelectView: (view: ViewId) => void;
}

interface SidebarSecondaryProps {
  space: SpaceId;
  profile: UserProfile;
  onEditProfile: () => void;
  onExport: () => void;
  onImport: () => void;
  onTrySample: () => void;
  /** Import outcome report, shown under the actions until the next action. */
  importReport: string | null;
}

/**
 * The compact profile summary line plus the quiet data actions. Rendered in
 * the sidebar on desktop and inside the mobile More sheet.
 */
export function SidebarSecondary({
  space,
  profile,
  onEditProfile,
  onExport,
  onImport,
  onTrySample,
  importReport,
}: SidebarSecondaryProps) {
  return (
    <div className="sidebar-secondary">
      <p className="sidebar-summary">
        <span className="sidebar-summary-space">{spaceLabel(space)}</span>{' '}
        <span className="sidebar-summary-detail">
          age {profile.age} · {fmtMoney(profile.grossMonthlyIncome)}/mo
        </span>
      </p>
      <button type="button" className="sidebar-text-action sidebar-edit-profile" onClick={onEditProfile}>
        Edit profile
      </button>
      <div className="sidebar-actions" aria-label="Data actions">
        <button type="button" className="sidebar-text-action" onClick={onExport}>
          Export data
        </button>
        <button type="button" className="sidebar-text-action" onClick={onImport}>
          Import data
        </button>
        <button type="button" className="sidebar-text-action" onClick={onTrySample}>
          Try the sample journey
        </button>
      </div>
      {importReport !== null ? <p className="sidebar-report">{importReport}</p> : null}
    </div>
  );
}

export function Sidebar({
  view,
  onSelectView,
  ...secondary
}: SidebarProps) {
  return (
    <aside className="app-sidebar">
      <span className="wordmark sidebar-wordmark">
        <span className="wordmark-dot" aria-hidden="true" />
        SpendWise
      </span>
      <nav className="side-nav" aria-label="SpendWise views">
        {VIEW_NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? 'page' : undefined}
            className={`side-nav-item ${view === item.id ? 'side-nav-item-on' : ''}`}
            onClick={() => onSelectView(item.id)}
          >
            <ViewIcon view={item.id} />
            <span className="side-nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
      <SidebarSecondary {...secondary} />
    </aside>
  );
}
