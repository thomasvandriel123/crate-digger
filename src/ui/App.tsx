import { useStore } from '@nanostores/preact';
import type { Album, Track } from '../data/types';
import { $load, $renderer } from '../state/store';
import { A11yList } from './A11yList';
import { FallbackGrid } from './FallbackGrid';
import { FilterBar, MobileFilters } from './FilterBar';
import { Corner, EmptyActions, LowerThird, NowPlaying, StatsOverlay } from './Stage';
import { BringDialog, Welcome } from './Spotify';

interface Props {
  dataUrl: string;
  loadTracks: (album: Album) => Promise<Track[] | null>;
}

export function App({ dataUrl, loadTracks }: Props) {
  const load = useStore($load);
  const renderer = useStore($renderer);

  if (load.status === 'welcome') return <Welcome />;

  if (load.status === 'error') {
    return (
      <div class="notice" role="alert">
        <div class="panel">
          <h1>The crates are empty</h1>
          <p>{load.message}</p>
          <p>To try the room with a generated library of 300 records, run:</p>
          <p>
            <code>python3 -m ingest.run mock --out data</code>
          </p>
          <p>
            Or connect your Spotify account (see <code>README.md</code>, Connect Spotify).
          </p>
          <div class="welcome-actions">
            <button type="button" class="action" onClick={() => location.reload()}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <FilterBar />
      {renderer === 'fallback' ? (
        <FallbackGrid dataUrl={dataUrl} loadTracks={loadTracks} />
      ) : (
        <>
          <A11yList />
          <LowerThird />
          <NowPlaying />
          <EmptyActions />
          <MobileFilters />
          <StatsOverlay />
        </>
      )}
      <Corner />
      <BringDialog />
    </>
  );
}
