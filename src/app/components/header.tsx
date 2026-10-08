'use client';

/**
 * Top bar of the application shell, spanning the main area beside the
 * sidebar: the You / Partner / Us space switcher (whose selection still
 * clears any in-flight plan on the page), the status pill fed by the one
 * /api/status fetch the page owns, and the prominent New goal primary
 * button on the right. The wordmark shows only below 900px, where the
 * sidebar is gone; on desktop the sidebar carries it.
 *
 * The pill never guesses: until the fetch resolves it shows the slate Local
 * mode dot. With a key configured it upgrades only to the ochre "Key set,
 * connection unverified" state, and the emerald "Nemotron connected" state
 * appears exclusively when the server's live health check came back verified.
 * Every state carries a title attribute explaining what it means and how to
 * move to the next one.
 */
import { spaceLabel, type SpaceId, type StatusJson } from './shared';

interface HeaderProps {
  activeSpace: SpaceId;
  onSelectSpace: (space: SpaceId) => void;
  /** Connection truth from the page's single /api/status fetch; null while pending. */
  status: StatusJson | null;
  /** The New goal button: switches to the Goals view and focuses the prompt. */
  onNewGoal: () => void;
}

const SPACES: ReadonlyArray<SpaceId> = ['you', 'partner', 'us'];

const LOCAL_TITLE =
  'Local mode: every number comes from the deterministic engines. Add NEBIUS_API_KEY to .env.local to enable Nemotron.';

const UNVERIFIED_TITLE =
  'A Nebius API key is set but the live health check did not complete, so the connection is unverified. Planning still works and falls back to the local parser whenever the endpoint does not answer.';

export function Header({ activeSpace, onSelectSpace, status, onNewGoal }: HeaderProps) {
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
        <span className="wordmark header-wordmark">
          <span className="wordmark-dot" aria-hidden="true" />
          SpendWise
        </span>
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
        <div className="header-end">
          <span className={`status-pill ${pillClass}`} title={pillTitle}>
            <span className={`status-dot ${dotClass}`} aria-hidden="true" />
            {pillLabel}
          </span>
          <button type="button" className="btn btn-primary header-new-goal" onClick={onNewGoal}>
            + New goal
          </button>
        </div>
      </div>
    </header>
  );
}
