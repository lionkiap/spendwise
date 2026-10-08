'use client';

/**
 * Mobile navigation (below 900px): a compact labelled bar under the header
 * with the four view items as text links on 44px touch targets, horizontally
 * scrollable when narrow, the active item underlined in forest green. At the
 * end of the bar a More button opens a bottom sheet (the same accessible
 * Drawer primitive as the profile drawer) holding the profile summary and
 * the data actions that the desktop sidebar carries in its secondary area.
 * The bar itself is hidden from 900px up, where the sidebar takes over.
 */
import { useState } from 'react';

import type { SpaceId, UserProfile, ViewId } from './shared';
import { Drawer } from './drawer';
import { SidebarSecondary, VIEW_NAV_ITEMS } from './sidebar';

interface MobileNavProps {
  view: ViewId;
  onSelectView: (view: ViewId) => void;
  /** Everything the embedded More sheet needs; same shape as the sidebar's secondary area. */
  space: SpaceId;
  profile: UserProfile;
  onEditProfile: () => void;
  onExport: () => void;
  onImport: () => void;
  onTrySample: () => void;
  importReport: string | null;
}

export function MobileNav({
  view,
  onSelectView,
  space,
  profile,
  onEditProfile,
  onExport,
  onImport,
  onTrySample,
  importReport,
}: MobileNavProps) {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      <nav className="mobile-nav" aria-label="SpendWise views">
        {VIEW_NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={view === item.id ? 'page' : undefined}
            className={`mobile-nav-item ${view === item.id ? 'mobile-nav-item-on' : ''}`}
            onClick={() => onSelectView(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="mobile-nav-item mobile-nav-more"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
        >
          More
        </button>
      </nav>
      <Drawer open={moreOpen} onClose={() => setMoreOpen(false)} label="More" variant="bottom">
        <div className="drawer-head">
          <h2 className="drawer-title">More</h2>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setMoreOpen(false)}>
            Close
          </button>
        </div>
        <div className="drawer-body">
          <SidebarSecondary
            space={space}
            profile={profile}
            onEditProfile={onEditProfile}
            onExport={onExport}
            onImport={onImport}
            onTrySample={onTrySample}
            importReport={importReport}
          />
        </div>
      </Drawer>
    </>
  );
}
