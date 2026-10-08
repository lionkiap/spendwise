'use client';

/**
 * Accessible dialog shell shared by the profile drawer and the mobile More
 * sheet. Contract: rendered only while open, role="dialog" aria-modal="true"
 * with the caller's accessible label, Escape closes, an overlay click closes,
 * focus moves into the panel on open and back to the opener on close, and Tab
 * is contained to the focusable elements inside the panel (wrapping at both
 * ends). No portal and no library: a fixed overlay plus a panel, everything
 * inline SVG / plain DOM.
 */
import { useEffect, useRef, type ReactNode } from 'react';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog, e.g. "Edit profile". */
  label: string;
  /** 'side' slides in from the right; 'bottom' is the mobile bottom sheet. */
  variant?: 'side' | 'bottom';
  children: ReactNode;
}

/** Selector for everything focusable the Tab cycle should visit. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableInside(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetParent !== null || element === document.activeElement
  );
}

export function Drawer({ open, onClose, label, variant = 'side', children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Keep the latest close callback reachable from the stable key listener
  // without re-running the focus effect on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    // Remember the opener so closing can hand focus back where it came from.
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      openerRef.current = active;
    }
    // Move focus in: the first control, or the panel itself when empty.
    const panel = panelRef.current;
    if (panel !== null) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? panel).focus();
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const current = panelRef.current;
      if (current === null) {
        return;
      }
      const focusables = focusableInside(current);
      if (focusables.length === 0) {
        // Nowhere to go: keep focus parked on the panel itself.
        event.preventDefault();
        current.focus();
        return;
      }
      const first = focusables[0] as HTMLElement;
      const last = focusables[focusables.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Hand focus back to the opener, but never steal it if the user already
      // moved on (activeElement is body only after the focused node went
      // away, which is exactly the dialog-unmount case).
      const opener = openerRef.current;
      if (opener !== null && document.body.contains(opener)) {
        opener.focus();
      }
      openerRef.current = null;
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className={`drawer-root drawer-${variant}`}>
      <div className="drawer-overlay" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`drawer-panel drawer-panel-${variant}`}
      >
        {children}
      </div>
    </div>
  );
}
