import { useStore } from '@nanostores/preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { $openPopover } from './actions';

interface Props {
  id: string;
  label: string;
  /** Accessible name when the visible label is terse. */
  title?: string;
  active?: boolean;
  count?: string | number | null;
  align?: 'left' | 'right';
  children: ComponentChildren;
}

/**
 * A paper-tag button with a non-modal popover: opens with a 160 ms fade and scale, focuses its first
 * control, closes on Escape (returning focus to the tag) or on a click outside.
 */
export function Popover({ id, label, title, active, count, align = 'left', children }: Props) {
  const openId = useStore($openPopover);
  const open = openId === id;
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const first = panel.current?.querySelector<HTMLElement>(
      'input, button, select, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) $openPopover.set(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      $openPopover.set(null);
      button.current?.focus();
    }
  };

  return (
    <div class="popover-anchor">
      <button
        ref={button}
        type="button"
        class={`tag${active ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls={id}
        aria-label={title}
        onClick={() => $openPopover.set(open ? null : id)}
      >
        {label}
        {count !== undefined && count !== null && count !== '' ? <span class="count">{count}</span> : null}
      </button>
      {open ? (
        <div
          id={id}
          ref={panel}
          role="dialog"
          aria-label={title ?? label}
          class={`popover${align === 'right' ? ' align-right' : ''}`}
          onKeyDown={onKeyDown}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
