// CSV downloads for the Buses and Analytics panels.

// rows: arrays of cells (strings, numbers, null). Quotes what needs quoting; CRLF line ends.
export function toCsv(rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Saves rows as a .csv file. The byte-order mark makes Excel read the text as UTF-8.
export function downloadCsv(filename, rows) {
  const url = URL.createObjectURL(new Blob(['﻿', toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "2026-10-23 14:05" in Broward time, for spreadsheet columns.
const stampFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const csvTime = s => (s == null ? '' : stampFormat.format(new Date(s * 1000)));
