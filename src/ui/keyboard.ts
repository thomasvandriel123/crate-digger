/**
 * Global keyboard shortcuts. Ignored while typing in a field (except the ones fields forward), and never
 * hijack keys a focused button or link needs (Space/Enter activate buttons).
 */

import { commands } from '../state/commands';
import { $held, $mobileFiltersOpen, $statsVisible } from '../state/store';
import { $openPopover } from './actions';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function isActivatable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'BUTTON' || target.tagName === 'A' || target.getAttribute('role') === 'button';
}

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
    if (isTyping(e.target)) return;
    if ($mobileFiltersOpen.get()) return;
    const inPopover = e.target instanceof HTMLElement && !!e.target.closest('[role="dialog"]');
    if (inPopover) return;
    const shift = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
      case 's':
      case 'S':
        commands.step(shift ? 5 : 1);
        break;
      case 'ArrowUp':
      case 'w':
      case 'W':
        commands.step(shift ? -5 : -1);
        break;
      case 'PageDown':
        commands.step(10);
        break;
      case 'PageUp':
        commands.step(-10);
        break;
      case 'Home':
        commands.edge('start');
        break;
      case 'End':
        commands.edge('end');
        break;
      case 'ArrowLeft':
      case 'a':
      case 'A':
        commands.switchCrate(-1);
        break;
      case 'ArrowRight':
      case 'd':
      case 'D':
        commands.switchCrate(1);
        break;
      case 'Enter':
        if (isActivatable(e.target)) return;
        commands.toggleHold();
        break;
      case 'f':
      case 'F':
        commands.flip();
        break;
      case ' ':
        if (isActivatable(e.target)) return;
        commands.playOrPause();
        break;
      case 'Escape':
        if ($openPopover.get()) $openPopover.set(null);
        else if ($held.get()) commands.release();
        else handled = false;
        break;
      case '/':
        document.getElementById('search')?.focus();
        break;
      case '`':
        $statsVisible.set(!$statsVisible.get());
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
