// solve.js — a faster drop-in for make.fun's csv-reader 1.0.0.
//
// run({ text, header }) reads `text` once, left to right, with commas and
// double quotes, and returns { columns, rows, errors } exactly as
// csv-reader 1.0.0 does, including every quirk of its handling of broken
// CSV (stray CRs, quote junk, unterminated quotes, short and long rows).
//
// The reading rules, restated:
//   * a U+FEFF at the very start of the text is dropped;
//   * a record ends at LF or CRLF, and a line left with no characters is
//     no record at all;
//   * outside quotes a CR not followed by LF is dropped and reported as
//     { code: 'stray_cr', line, row };
//   * a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF and counts as one line; anything after the closing quote
//     up to the next comma or line break is appended as it stands and, if
//     at least one character was appended, reported as quote_junk;
//   * a quote that never closes is a literal character, the text after it
//     is read again as an unquoted field whose value starts with that
//     quote, and an unterminated_quote error is reported;
//   * a quote inside an unquoted field is a literal character;
//   * fields stay strings, never trimmed or converted;
//   * columns is the first record when header is true, else null; rows are
//     the records after it (every record when header is false), each padded
//     with empty strings (short_row) or cut (long_row) to the first
//     record's width;
//   * errors are reported in the order met, a field's when the field ends
//     and a record's when the record ends, with `line` the 1-based line the
//     record starts on and `row` the index of the record in rows (null for
//     the header record);
//   * a record that is a single empty unquoted field (a line that held only
//     stray CRs) is no record at all, but its stray_cr errors stay;
//   * with header true and no records at all, columns is [].
//
// Speed comes from scanning with indexOf and slicing whole fields at once
// instead of growing strings one character at a time; only the rare broken
// field paths loop character by character.

const QUOTE = 34 // '"'
const COMMA = 44 // ','
const CR = 13 // '\r'
const LF = 10 // '\n'
const BOM = 0xfeff

export function run(input) {
  const text = input.text
  const header = !!input.header
  const n = text.length

  const errors = []
  const rows = []
  let columns = null
  let width = -1
  let accepted = 0 // records kept so far (header record included)
  let line = 1 // 1-based line the next record starts on
  let i = n > 0 && text.charCodeAt(0) === BOM ? 1 : 0

  while (i < n) {
    // A line that starts with its own terminator holds nothing: no record.
    const first = text.charCodeAt(i)
    if (first === LF) {
      i += 1
      line += 1
      continue
    }
    if (first === CR && i + 1 < n && text.charCodeAt(i + 1) === LF) {
      i += 2
      line += 1
      continue
    }

    const recLine = line
    const rowVal = header ? (accepted === 0 ? null : accepted - 1) : accepted

    const fields = []
    let j = i
    let firstQuoted = false

    // ---- fields of this record --------------------------------------
    for (;;) {
      let value
      const openedQuoted = j < n && text.charCodeAt(j) === QUOTE

      if (openedQuoted) {
        // ---- quoted field ------------------------------------------
        const qStart = j
        let p = qStart + 1
        let segStart = p
        let parts = null // built only when a quote/CR needs rewriting
        let lineInc = 0
        let closed = false

        while (p < n) {
          const c = text.charCodeAt(p)
          if (c === QUOTE) {
            if (p + 1 < n && text.charCodeAt(p + 1) === QUOTE) {
              // "" inside a quoted field is one quote
              if (parts === null) parts = []
              parts.push(text.slice(segStart, p), '"')
              p += 2
              segStart = p
              continue
            }
            // closing quote
            if (parts === null) {
              value = text.slice(segStart, p)
            } else {
              parts.push(text.slice(segStart, p))
              value = parts.join('')
            }
            p += 1
            closed = true
            break
          }
          if (c === CR || c === LF) {
            // each CRLF or lone CR inside is read as LF and counts as a line
            lineInc += 1
            if (parts === null) parts = []
            parts.push(text.slice(segStart, p), '\n')
            p += c === CR && p + 1 < n && text.charCodeAt(p + 1) === LF ? 2 : 1
            segStart = p
            continue
          }
          p += 1
        }

        if (!closed) {
          // The quote never closes: it is a literal, and the text after it
          // is read again as an unquoted field whose value starts with it.
          // The error is recorded as soon as the quote is found to be open
          // at the end of the text, before the re-read.
          errors.push({ code: 'unterminated_quote', line: recLine, row: rowVal })
          const r = unquoted(text, qStart + 1, n, recLine, rowVal, errors, '"')
          j = r.j
          value = r.value
        } else {
          line += lineInc
          j = p
          // ---- junk after the closing quote ---------------------------
          let junkStart = j
          let junkParts = null
          let appended = 0
          while (j < n) {
            const c = text.charCodeAt(j)
            if (c === COMMA || c === LF) break
            if (c === CR) {
              if (j + 1 < n && text.charCodeAt(j + 1) === LF) break
              errors.push({ code: 'stray_cr', line: recLine, row: rowVal })
              if (junkParts === null) junkParts = []
              junkParts.push(text.slice(junkStart, j))
              j += 1
              junkStart = j
              continue
            }
            j += 1
          }
          if (junkParts === null) {
            appended = j - junkStart
            if (appended > 0) value += text.slice(junkStart, j)
          } else {
            junkParts.push(text.slice(junkStart, j))
            const junk = junkParts.join('')
            appended = junk.length
            if (appended > 0) value += junk
          }
          if (appended > 0) {
            errors.push({ code: 'quote_junk', line: recLine, row: rowVal })
          }
        }
      } else {
        // ---- unquoted field -----------------------------------------
        const r = unquoted(text, j, n, recLine, rowVal, errors, null)
        j = r.j
        value = r.value
      }

      if (fields.length === 0) firstQuoted = openedQuoted
      fields.push(value)

      if (j >= n) {
        i = n
        break
      }
      if (text.charCodeAt(j) === COMMA) {
        j += 1
        continue
      }
      // the field can only stop at a record terminator now: LF or CRLF
      if (text.charCodeAt(j) === LF) {
        j += 1
        line += 1
      } else {
        j += 2
        line += 1
      }
      i = j
      break
    }

    // ---- finish the record ------------------------------------------
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) {
      // a line that held only stray CRs is no record, though its errors stay
      continue
    }
    if (accepted === 0) {
      width = fields.length
      accepted = 1
      if (header) columns = fields
      else rows.push(fields)
      continue
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: rowVal, fields: fields.length })
      for (let k = fields.length; k < width; k += 1) fields.push('')
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: rowVal, extra: fields.slice(width) })
      fields.length = width
    }
    rows.push(fields)
    accepted += 1
  }

  if (header && columns === null) columns = []
  return { columns: columns, rows: rows, errors: errors }
}

// Read one unquoted field starting at `start`. Quotes are literal; a CR not
// followed by LF is dropped with a stray_cr error; the field ends at a
// comma, at LF, at a CRLF, or at the end of the text. `prefix` (used when a
// never-closing quote is re-read as unquoted text) starts the value off.
function unquoted(text, start, n, recLine, rowVal, errors, prefix) {
  let j = start
  let segStart = start
  let parts = prefix === null ? null : [prefix]
  while (j < n) {
    const c = text.charCodeAt(j)
    if (c === COMMA || c === LF) break
    if (c === CR) {
      if (j + 1 < n && text.charCodeAt(j + 1) === LF) break
      errors.push({ code: 'stray_cr', line: recLine, row: rowVal })
      if (parts === null) parts = []
      parts.push(text.slice(segStart, j))
      j += 1
      segStart = j
      continue
    }
    j += 1
  }
  let value
  if (parts === null) {
    value = text.slice(segStart, j)
  } else {
    parts.push(text.slice(segStart, j))
    value = parts.length === 1 ? parts[0] : parts.join('')
  }
  return { j: j, value: value }
}