// Annotation storage safety: an unreadable file must never be silently
// replaced by the next highlight, and the in-memory list must never claim an
// annotation the disk refused. Browser store (localStorage) is used because
// its read/write path is the same shape as the Tauri one.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAnnotation, annotationsProblem, deleteAnnotation, listAnnotations, updateAnnotation, type Annotation,
} from '../lib/annotations';

const ann = (work: string, id: string, body = ''): Annotation => ({
  id, work, created: '2026-01-01T00:00:00.000Z', body, layer: 'greek', exact: 'logos',
  target: { kind: 'greek', book: 1, start: { column: '1094a', line: 1, word: 0 }, end: { column: '1094a', line: 1, word: 0 } },
});

beforeEach(() => {
  localStorage.clear();
});

describe('annotations store', () => {
  it('a corrupt annotations file is reported in one sentence and never overwritten by a new highlight', async () => {
    localStorage.setItem('annotations:corrupt-work', '[{"id": "ann-1", "work": "corrupt-work"');
    expect(await listAnnotations('corrupt-work')).toEqual([]);
    const problem = annotationsProblem('corrupt-work');
    expect(problem).toMatch(/could not be read/i);
    expect(problem).not.toMatch(/\n\s+at /);

    await expect(addAnnotation(ann('corrupt-work', 'ann-2'))).rejects.toThrow(/could not be read/i);
    await expect(updateAnnotation('corrupt-work', 'ann-1', 'note')).rejects.toThrow(/could not be read/i);
    await expect(deleteAnnotation('corrupt-work', 'ann-1')).rejects.toThrow(/could not be read/i);
    // The bytes on disk are exactly what they were: recoverable by hand.
    expect(localStorage.getItem('annotations:corrupt-work')).toBe('[{"id": "ann-1", "work": "corrupt-work"');
    expect(await listAnnotations('corrupt-work')).toEqual([]);
  });

  it('a file that parses but is not a list is treated the same way', async () => {
    localStorage.setItem('annotations:object-work', '{"id": "ann-1"}');
    expect(await listAnnotations('object-work')).toEqual([]);
    expect(annotationsProblem('object-work')).toMatch(/could not be read/i);
    await expect(addAnnotation(ann('object-work', 'ann-2'))).rejects.toThrow();
    expect(localStorage.getItem('annotations:object-work')).toBe('{"id": "ann-1"}');
  });

  it('a missing file is simply an empty list with no problem, and the first write creates it', async () => {
    expect(await listAnnotations('fresh-work')).toEqual([]);
    expect(annotationsProblem('fresh-work')).toBeNull();
    await addAnnotation(ann('fresh-work', 'ann-1'));
    expect(JSON.parse(localStorage.getItem('annotations:fresh-work')!)).toHaveLength(1);
    expect(await listAnnotations('fresh-work')).toHaveLength(1);
  });

  it('a write that fails does not leave the annotation in the in-memory list as if it were saved', async () => {
    await addAnnotation(ann('flaky-work', 'ann-1'));
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('QuotaExceededError');
    });
    await expect(addAnnotation(ann('flaky-work', 'ann-2'))).rejects.toThrow('QuotaExceededError');
    setItem.mockRestore();
    expect((await listAnnotations('flaky-work')).map(a => a.id)).toEqual(['ann-1']);
    expect(JSON.parse(localStorage.getItem('annotations:flaky-work')!).map((a: Annotation) => a.id)).toEqual(['ann-1']);
  });
});
