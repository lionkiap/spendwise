'use client';

/**
 * Sticky glass header: wordmark with an indigo square dot, a status pill that
 * fetches /api/status once on mount, the segmented tab control and, under the
 * tabs, the space switcher (You, Partner, Us) that decides whose plan the
 * whole page is showing.
 *
 * The pill never guesses: until the fetch resolves it shows the slate Local
 * mode dot, and only upgrades to the emerald "Nemotron connected" state when
 * the server says a key is configured. The title attribute always explains
 * how to enable Nemotron.
 */
import { useEffect, useState } from 'react';

import { isStatusJson, spaceLabel, type SpaceId, type StatusJson, type TabId } from './shared';

interface HeaderProps {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  activeSpace: SpaceId;
  onSelectSpace: (space: SpaceId) => void;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'planner', label: 'Goal Planner' },
  { id: 'progress', label: 'Progress' },
  { id: 'cards', label: 'Card Maximizer' },
];

const SPACES: ReadonlyArray<SpaceId> = ['you', 'partner', 'us'];

const LOCAL_TITLE =
  'Local mode: every number comes from the deterministic engines. Add NEBIUS_API_KEY to .env.local to enable Nemotron.';

export function Header({ activeTab, onSelectTab, activeSpace, onSelectSpace }: HeaderProps) {
  const [status, setStatus] = useState<StatusJson | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status')
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!cancelled && isStatusJson(data)) {
          setStatus(data);
        }
      })
      .catch(() => {
        // Network failure keeps the default Local mode pill.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const configured = status?.nebiusConfigured === true;
  const pillTitle = configured
    ? `Nemotron connected on Nebius Token Factory. ultra: ${status?.models.ultra} · super: ${status?.models.super} · nano: ${status?.models.nano}`
    : LOCAL_TITLE;

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="header-row">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            SpendWise
          </span>
          <span
            className={`status-pill ${configured ? 'status-pill-on' : ''}`}
            title={pillTitle}
          >
            <span
              className={`status-dot ${configured ? 'status-dot-on' : 'status-dot-off'}`}
              aria-hidden="true"
            />
            {configured ? 'Nemotron connected' : 'Local mode'}
          </span>
        </div>
        <nav className="tabs" role="tablist" aria-label="SpendWise tools">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              className={`tab ${activeTab === tab.id ? 'tab-active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="space-row" role="radiogroup" aria-label="Whose plan">
          <span className="space-row-label" aria-hidden="true">
            Whose plan
          </span>
          <div className="space-group">
            {SPACES.map((space) => (
              <button
                key={space}
                type="button"
                role="radio"
                aria-checked={activeSpace === space}
                className={`space-switch ${activeSpace === space ? 'space-switch-on' : ''}`}
                onClick={() => onSelectSpace(space)}
              >
                {spaceLabel(space)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
