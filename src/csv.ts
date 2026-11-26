export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 10000;
export const CSV_MAX_COLUMNS = 1000;
export const CSV_MAX_CELLS = 100000;

/** The expected CSV table is data, with no coercion or expression evaluation. */
export function csvExpectedRowsError(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'CSV expected result must be an array of string rows.';
  if (value.length > CSV_MAX_ROWS)
    return `CSV expected result must have at most ${CSV_MAX_ROWS} rows.`;
  let columns: number | undefined;
  let cells = 0;
  let bytes = 0;
  for (const row of value) {
    if (!Array.isArray(row) || !row.length || row.length > CSV_MAX_COLUMNS)
      return `Each expected CSV row must have 1 to ${CSV_MAX_COLUMNS} string fields.`;
    columns ??= row.length;
    if (row.length !== columns) return 'Expected CSV rows must have the same number of fields.';
    cells += row.length;
    if (cells > CSV_MAX_CELLS)
      return `CSV expected result must have at most ${CSV_MAX_CELLS} fields.`;
    for (const cell of row) {
      if (typeof cell !== 'string') return 'Expected CSV fields must be strings.';
      bytes += Buffer.byteLength(cell, 'utf8');
      if (bytes > CSV_MAX_BYTES)
        return `CSV expected field content must not exceed ${CSV_MAX_BYTES} UTF-8 bytes.`;
    }
  }
}

/**
 * Decode comma-separated text without executing a supplied grammar. Only an
 * initial UTF-8 BOM, quoting/escaped quotes, and CRLF/LF record separators are
 * decoded. Field whitespace, embedded line breaks, and numeric formatting stay
 * exact. Malformed or excessive input returns undefined instead of partial rows.
 */
export function parseCsv(text: string): string[][] | undefined {
  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) return undefined;
  let cursor = text.startsWith('\uFEFF') ? 1 : 0;
  if (cursor === text.length) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let columns: number | undefined;
  let cells = 0;
  const addRow = (): boolean => {
    columns ??= row.length;
    if (row.length !== columns || rows.length >= CSV_MAX_ROWS) return false;
    rows.push(row);
    row = [];
    return true;
  };
  while (true) {
    let field: string;
    if (text[cursor] === '"') {
      let start = ++cursor;
      const pieces: string[] = [];
      let closed = false;
      while (cursor < text.length) {
        if (text[cursor] !== '"') {
          cursor++;
          continue;
        }
        pieces.push(text.slice(start, cursor));
        if (text[cursor + 1] === '"') {
          pieces.push('"');
          cursor += 2;
          start = cursor;
        } else {
          cursor++;
          closed = true;
          break;
        }
      }
      if (!closed) return undefined;
      field = pieces.join('');
      if (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor]!)) return undefined;
    } else {
      const start = cursor;
      while (cursor < text.length && ![',', '\r', '\n'].includes(text[cursor]!)) {
        if (text[cursor] === '"') return undefined;
        cursor++;
      }
      field = text.slice(start, cursor);
    }
    row.push(field);
    if (row.length > CSV_MAX_COLUMNS || ++cells > CSV_MAX_CELLS) return undefined;
    if (cursor === text.length) return addRow() ? rows : undefined;
    if (text[cursor] === ',') {
      cursor++;
      continue;
    }
    if (text[cursor] === '\r') {
      if (text[cursor + 1] !== '\n') return undefined;
      cursor += 2;
    } else cursor++;
    if (!addRow()) return undefined;
    if (cursor === text.length) return rows;
  }
}
