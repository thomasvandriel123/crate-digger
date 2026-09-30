import { useStore } from '@nanostores/preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { commands } from '../state/commands';
import { $focus, $layout, $library } from '../state/store';

/**
 * A visually hidden, real DOM listbox mirroring the filtered albums, kept in sync with the 3D focus.
 * Screen readers hear "artist, title, year, position of total"; keyboard users can Tab to it and use the
 * same shortcuts as the room. Selecting an option focuses that record in the scene.
 */
export function A11yList() {
  const layout = useStore($layout);
  const library = useStore($library);
  const focus = useStore($focus);
  const list = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');

  const order = layout?.order ?? [];
  const total = order.length;
  const describe = useMemo(() => {
    return (id: string, i: number) => {
      const a = library?.byId.get(id);
      if (!a) return '';
      return `${a.artist}, ${a.title}${a.year ? `, ${a.year}` : ''}, ${i + 1} of ${total}`;
    };
  }, [library, total]);

  // Announce keyboard-driven focus changes politely (debounced, so fast scrolling doesn't chatter).
  useEffect(() => {
    if (!focus.albumId || focus.via !== 'keyboard') return;
    const t = setTimeout(() => setAnnouncement(describe(focus.albumId!, focus.position)), 250);
    return () => clearTimeout(t);
  }, [focus.albumId, focus.via, focus.position, describe]);

  const activeId = focus.albumId ? `rec-${focus.albumId}` : undefined;

  return (
    <div class="sr-only">
      <div
        id="records"
        ref={list}
        role="listbox"
        tabIndex={0}
        aria-label={`Records, ${total} shown`}
        aria-activedescendant={activeId}
        aria-describedby="records-help"
      >
        {order.map((id, i) => (
          <div
            key={id}
            id={`rec-${id}`}
            role="option"
            aria-selected={id === focus.albumId}
            aria-posinset={i + 1}
            aria-setsize={total}
            onClick={() => commands.focusAlbum(id)}
          >
            {describe(id, i)}
          </div>
        ))}
      </div>
      <p id="records-help">
        Up and Down move through the crate, Shift for five, Page Up and Page Down for ten. Left and Right
        switch crate. Enter pulls the record out, F flips it, Space plays it, Escape puts it back. Slash
        searches.
      </p>
      <div role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
