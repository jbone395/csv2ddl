# csv2ddl

A free, 100% client-side tool that turns a CSV file into a Postgres
`CREATE TABLE` statement. Paste CSV text or drop a `.csv` file, and it infers
a reasonable column type for each column (INTEGER, NUMERIC, BOOLEAN, DATE,
TIMESTAMP, or TEXT) from the sample data, then generates the DDL. Nothing is
uploaded — it's static HTML/CSS/JS with no backend, no build step, and no
dependencies.

(Context: sqlizer.io did this as a paid $29/mo product and shut down in
August 2025. There's no current free incumbent.)

## How to use

1. Open `index.html` directly in a browser (double-click it, or drag it into
   a browser window — no server required).
2. Paste CSV text into the box, or drag & drop / choose a `.csv` file.
3. Optionally edit the table name.
4. Click **Generate DDL**.
5. Click **Copy to clipboard** to grab the `CREATE TABLE` statement, or
   **Download .sql** to save it as a `.sql` file.

## Dialect

Postgres only, v1. No multi-dialect abstraction.

## Type inference approach

For each column, non-empty values are sampled (all rows, capped at the first
1000 data rows for large files) and checked against candidate types in order
of specificity: **INTEGER → NUMERIC → BOOLEAN → DATE → TIMESTAMP → TEXT**. A
type is chosen only if it fits *every* sampled non-empty value in that
column; otherwise inference falls through to the next, less specific type.
A column with zero non-empty values anywhere falls back to TEXT.

Identifiers (column names) are lowercased, invalid characters replaced with
`_`, prefixed if they start with a digit, and de-duplicated on collision
(`name`, `name` → `name`, `name_2`). All identifiers are always
double-quoted in the emitted DDL, so case and any remaining special
characters are preserved safely regardless of Postgres reserved words.

### Specific decisions worth knowing about

- **Leading zeros (`"007"`) are TEXT, not INTEGER/NUMERIC.** Casting `"007"`
  to a Postgres numeric type silently drops the leading zero, which would
  corrupt real-world values like zip codes, SKUs, or employee IDs that
  happen to look numeric. Any value with a leading zero (and more than one
  digit before the decimal point) forces that column to TEXT.
- **A column of only `"0"`/`"1"` is INTEGER, not BOOLEAN**, because INTEGER
  is checked before BOOLEAN in the specificity order above. Use
  `true`/`false`/`t`/`f`/`yes`/`no`/`y`/`n` (case-insensitive) if you want
  BOOLEAN inference.
- A column mixing whole numbers and decimals (e.g. `"123"` and `"123.5"`)
  becomes NUMERIC, since not every value fits INTEGER.

## Known limitations

- **CSV parsing**: handles quoted fields with embedded commas/newlines and
  `""`-escaped quotes, and both CRLF and LF line endings. It does **not**
  handle bare-CR-only line endings (old classic-Mac style), non-UTF-8
  encodings, or exotic numeric formats like scientific notation or
  thousands separators (`"1,234.56"`).
- **Dates**: only ISO `YYYY-MM-DD` and US-style `M/D/YYYY` / `MM/DD/YYYY` are
  recognized. `DD/MM/YYYY` is inherently ambiguous with the US format and is
  **not** distinguished — we always assume month-first. Locale-specific
  formats (`"15 Jan 2024"`) are not handled.
- **Timestamps**: only ISO-ish `YYYY-MM-DDTHH:MM:SS` / `YYYY-MM-DD HH:MM:SS`
  (with optional fractional seconds and `Z`/offset) are recognized.
  Non-ISO timestamp formats (e.g. `"01/15/2024 3:00 PM"`) fall back to TEXT.
- No `NOT NULL`, `PRIMARY KEY`, or other constraint inference — just column
  name + type, by design.
- Large files: type inference samples at most the first 1000 data rows.

## Files

- `index.html` — page structure
- `style.css` — styling (light/dark aware via `prefers-color-scheme`)
- `app.js` — CSV parser, type inference, DDL generation, UI wiring
