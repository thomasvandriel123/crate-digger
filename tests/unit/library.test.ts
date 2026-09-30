import { describe, expect, it } from 'vitest';
import { normaliseLibrary } from '../../src/data/library';
import { filingKey, filingLetter } from '../../src/data/text';
import { library } from './fixtures';

describe('normaliseLibrary', () => {
  it('tolerates missing optional fields and skips albums without an id', () => {
    const lib = normaliseLibrary({
      version: 1,
      albums: [
        { id: 'x' },
        { title: 'no id' },
        null,
        { id: 'y', artists: [], palette: { dominant: 'nope' } },
      ],
    });
    expect(lib.albums.map((a) => a.id)).toEqual(['x', 'y']);
    const x = lib.byId.get('x')!;
    expect(x.title).toBe('Untitled');
    expect(x.artist).toBe('Unknown artist');
    expect(x.year).toBeNull();
    expect(x.addedAt).toBeNull();
    expect(x.tracks).toBeNull();
    expect(x.palette.dominant).toMatch(/^#[0-9a-f]{6}$/);
    expect(x.cover.web).toBe('covers/512/x.webp');
  });

  it('drops the label capability when no album has a label', () => {
    expect(library([{ label: null }, { label: null }]).capabilities.label).toBe(false);
    expect(library([{ label: 'Blue Note' }]).capabilities.label).toBe(true);
  });

  it('dedupes ids and keeps a contiguous index', () => {
    const lib = normaliseLibrary({ version: 1, albums: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] });
    expect(lib.albums.map((a) => [a.id, a.index])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
  });

  it('rejects documents without albums', () => {
    expect(() => normaliseLibrary({ version: 1 })).toThrow();
  });

  it('derives a taxonomy when the file has none', () => {
    const lib = library([
      { genres: ['jazz'], genresRaw: ['hard bop'] },
      { genres: ['jazz', 'soul'], genresRaw: ['jazz funk'] },
    ]);
    const jazz = lib.taxonomy.find((g) => g.id === 'jazz')!;
    expect(jazz.name).toBe('Jazz');
    expect(jazz.micro).toEqual(['hard bop', 'jazz funk']);
  });
});

describe('filing', () => {
  it('files "The" bands under the next word and folds accents', () => {
    expect(filingKey('The Velvet Harbours')).toBe('velvet harbours');
    expect(filingKey('Émile Parisien')).toBe('emile parisien');
    expect(filingKey('The The')).toBe('the');
    expect(filingLetter(filingKey('808 State'))).toBe('#');
    expect(filingLetter(filingKey('Sørensen'))).toBe('S');
  });
});
