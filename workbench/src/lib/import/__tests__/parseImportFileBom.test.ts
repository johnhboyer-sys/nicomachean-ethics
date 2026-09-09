import { describe, expect, it } from 'vitest';
import { parseImportFile } from '../parseImportFile';

const FILE = `---
work: metaphysics
book: 7
chapter: 17
---
[GREEK]
τὸ τί ἦν εἶναι
[ENGLISH]
the essence
`;

describe('parseImportFile and a byte-order mark', () => {
  it('a file that starts with a BOM is the same file', () => {
    const plain = parseImportFile(FILE);
    const bom = parseImportFile('﻿' + FILE);
    expect(bom.ok).toBe(true);
    expect(bom).toEqual(plain);
  });
});
