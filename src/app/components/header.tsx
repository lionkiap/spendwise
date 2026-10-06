'use client';

/**
 * Sticky masthead: wordmark with a leaf square dot, the status pill fed by the
 * one /api/status fetch the page owns, the segmented tab control and, under
 * the tabs, the space switcher (You, Partner, Us) that decides whose plan the
 * whole page is showing.
 *
 * The pill never guesses: until the fetch resolves it shows the slate Local
 * mode dot. With a key configured it upgrades only to the ochre "Key set,
 * connection unverified" state, and the emerald "Nemotron connected" state
 * appears exclusively when the server's live health check came back verified.
 * Every state carries a title attribute explaining what it means and how to
 * move to the next one.
 */
import { spaceLabel, type SpaceId, type StatusJson, type TabId } from './shared';

interface HeaderProps {
  activeTab: TabId;
  onSelectTab: (tab: TabId) => void;
  activeSpace: SpaceId;
  onSelectSpace: (space: SpaceId) => void;
  /** Connection truth from the page's single /api/status fetch; null while pending. */
  status: StatusJson | null;
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'planner', label: 'Goal Planner' },
  { id: 'progress', label: 'Progress' },
  { id: 'cards', label: 'Card Maximizer' },
];

const SPACES: ReadonlyArray<SpaceId> = ['you', 'partner', 'us'];

const LOCAL_TITLE =
  'Local mode: every number comes from the deterministic engines. Add NEBIUS_API_KEY to .env.local to enable Nemotron.';

const UNVERIFIED_TITLE =
  'A Nebius API key is set but the live health check did not complete, so the connection is unverified. Planning still works and falls back to the local parser whenever the endpoint does not answer.';

export function Header({ activeTab, onSelectTab, activeSpace, onSelectSpace, status }: HeaderProps) {
  const verified = status !== null && status.nebiusConfigured && status.connection === 'verified';
  const keySetOnly = status !== null && status.nebiusConfigured && status.connection !== 'verified';
  const pillClass = verified ? 'status-pill-on' : keySetOnly ? 'status-pill-warn' : '';
  const dotClass = verified ? 'status-dot-on' : keySetOnly ? 'status-dot-warn' : 'status-dot-off';
  const pillLabel = verified ? 'Nemotron connected' : keySetOnly ? 'Key set, connection unverified' : 'Local mode';
  const pillTitle = verified
    ? `Nemotron connected on Nebius Token Factory: the live health check succeeded. ultra: ${status.models.ultra} · super: ${status.models.super} · nano: ${status.models.nano}`
    : keySetOnly
      ? UNVERIFIED_TITLE
      : LOCAL_TITLE;

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <div className="header-row">
          <span className="wordmark">
            <span className="wordmark-dot" aria-hidden="true" />
            SpendWise
          </span>
          <span className={`status-pill ${pillClass}`} title={pillTitle}>
            <span className={`status-dot ${dotClass}`} aria-hidden="true" />
            {pillLabel}
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
