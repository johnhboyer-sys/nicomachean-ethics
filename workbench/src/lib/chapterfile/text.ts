/**
 * Bring raw file text onto the basis every parser in this package and in
 * import/ works from: no byte-order mark, LF line endings.
 *
 * A BOM is not content — an editor that writes one (Notepad, some Windows
 * tools on a shared folder) must not make a chapter file unopenable or make
 * an import file read as "no header". CRLF and bare CR both fold to LF so
 * line-based parsing sees one terminator.
 */
export function normalizeText(raw: string): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
