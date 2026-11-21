/* csv2ddl — CSV to Postgres CREATE TABLE, 100% client-side.
 * No build step, no dependencies. See README.md for known limitations.
 */

/* ---------------------------------------------------------------------- */
/* CSV parsing                                                            */
/* ---------------------------------------------------------------------- */

// RFC-4180-ish CSV parser. Handles:
//   - quoted fields containing commas and newlines
//   - escaped quotes ("" inside a quoted field)
//   - CRLF and LF line endings (CRLF is normalized by skipping bare \r)
// Known limitation (see README): a bare CR (old Mac-style line endings with
// no following \n) is NOT treated as a row break.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch; // includes literal \n / \r / , inside quotes
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (ch === "\r") {
      // swallow bare CR; row break is driven by \n
      i += 1;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }

  // flush trailing field/row if the file didn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // drop stray fully-blank lines (a row that is a single empty field),
  // e.g. trailing blank lines in the file
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/* ---------------------------------------------------------------------- */
/* Identifier sanitization                                               */
/* ---------------------------------------------------------------------- */

// Lowercase, replace anything not [a-z0-9_] with "_", prefix if it starts
// with a digit, fall back to "col" if empty, and de-dupe collisions by
// appending _2, _3, ... We always double-quote identifiers in the emitted
// DDL (see buildDDL) rather than trying to special-case Postgres reserved
// words, so the sanitized name itself just needs to be a legal identifier
// body.
function sanitizeIdentifiers(headers) {
  const used = new Set();
  return headers.map((raw) => {
    let id = String(raw).trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (id === "") id = "col";
    if (/^[0-9]/.test(id)) id = "col_" + id;

    let candidate = id;
    let n = 2;
    while (used.has(candidate)) {
      candidate = `${id}_${n}`;
      n += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

/* ---------------------------------------------------------------------- */
/* Type inference                                                         */
/* ---------------------------------------------------------------------- */

// A numeric string with a leading zero (e.g. "007", "0123.5") is
// deliberately NOT treated as INTEGER/NUMERIC: casting it to a Postgres
// numeric type silently drops the leading zero, which corrupts values like
// zip codes, SKUs, or employee IDs that happen to look numeric. Such
// columns fall through to TEXT instead, preserving the original string.
// "0" and "0.5" are fine (no "leading zero problem") since there's nothing
// to lose there.
function hasLeadingZeroProblem(numStr) {
  const unsigned = numStr.replace(/^[+-]/, "");
  const intPart = unsigned.split(".")[0];
  return intPart.length > 1 && intPart[0] === "0";
}

function isInteger(v) {
  if (!/^[+-]?\d+$/.test(v)) return false;
  return !hasLeadingZeroProblem(v);
}

function isNumeric(v) {
  if (!/^[+-]?(\d+\.\d+|\.\d+|\d+\.|\d+)$/.test(v)) return false;
  return !hasLeadingZeroProblem(v);
}

// Note: a column of plain "0"/"1" is classified INTEGER, not BOOLEAN,
// because INTEGER is checked first in our specificity order (per spec).
// Use true/false/t/f/yes/no/y/n if you want BOOLEAN inference.
const BOOLEAN_VALUES = new Set(["true", "false", "t", "f", "yes", "no", "y", "n"]);
function isBoolean(v) {
  return BOOLEAN_VALUES.has(v.toLowerCase());
}

// Supported: ISO YYYY-MM-DD, and US-style M/D/YYYY or MM/DD/YYYY.
// Known limitation (see README): DD/MM/YYYY is ambiguous with MM/DD/YYYY
// and we always assume the US (month-first) ordering; locale month names
// ("15 Jan 2024") are not handled.
function isDate(v) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const month = +m[2], day = +m[3];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) {
    const month = +m[1], day = +m[2];
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }
  return false;
}

// Supported: "YYYY-MM-DDTHH:MM:SS" and "YYYY-MM-DD HH:MM:SS", with optional
// fractional seconds and optional trailing Z / +HH:MM offset.
// Known limitation: non-ISO timestamp formats (e.g. "01/15/2024 3:00 PM")
// are not recognized and will fall back to TEXT.
function isTimestamp(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return false;
  const month = +m[2], day = +m[3], hour = +m[4], min = +m[5], sec = +m[6];
  return (
    month >= 1 && month <= 12 &&
    day >= 1 && day <= 31 &&
    hour >= 0 && hour <= 23 &&
    min >= 0 && min <= 59 &&
    sec >= 0 && sec <= 59
  );
}

// values: non-empty, trimmed sample strings for one column.
// Checks candidates in order of specificity; a type is chosen only if it
// fits EVERY sampled non-empty value. Zero non-empty values -> TEXT.
function inferColumnType(values) {
  if (values.length === 0) return "TEXT";
  if (values.every(isInteger)) return "INTEGER";
  if (values.every(isNumeric)) return "NUMERIC";
  if (values.every(isBoolean)) return "BOOLEAN";
  if (values.every(isDate)) return "DATE";
  if (values.every(isTimestamp)) return "TIMESTAMP";
  return "TEXT";
}

/* ---------------------------------------------------------------------- */
/* DDL generation                                                         */
/* ---------------------------------------------------------------------- */

const SAMPLE_CAP = 1000; // cap rows scanned for type inference on huge files

function sanitizeTableName(name) {
  let id = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (id === "") id = "my_table";
  if (/^[0-9]/.test(id)) id = "t_" + id;
  return id;
}

function buildDDL(rows, tableName) {
  if (rows.length === 0) {
    throw new Error("No data found in CSV input.");
  }

  const header = rows[0];
  const dataRows = rows.slice(1, 1 + SAMPLE_CAP);
  const colNames = sanitizeIdentifiers(header);

  const colTypes = header.map((_, colIdx) => {
    const samples = [];
    for (const r of dataRows) {
      const raw = r[colIdx];
      if (raw === undefined) continue; // ragged row, shorter than header
      const trimmed = raw.trim();
      if (trimmed !== "") samples.push(trimmed);
    }
    return inferColumnType(samples);
  });

  const table = sanitizeTableName(tableName);
  const lines = colNames.map((name, idx) => `  "${name}" ${colTypes[idx]}`);
  return `CREATE TABLE "${table}" (\n${lines.join(",\n")}\n);`;
}

/* ---------------------------------------------------------------------- */
/* UI wiring                                                              */
/* ---------------------------------------------------------------------- */

const csvInput = document.getElementById("csvInput");
const tableNameInput = document.getElementById("tableName");
const generateBtn = document.getElementById("generateBtn");
const ddlOutput = document.getElementById("ddlOutput");
const copyBtn = document.getElementById("copyBtn");
const copyMsg = document.getElementById("copyMsg");
const errorMsg = document.getElementById("errorMsg");
const fileInput = document.getElementById("fileInput");
const dropzone = document.getElementById("dropzone");

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function clearError() {
  errorMsg.hidden = true;
  errorMsg.textContent = "";
}

function generate() {
  clearError();
  copyMsg.hidden = true;
  const text = csvInput.value;
  if (!text || !text.trim()) {
    showError("Paste some CSV text or load a file first.");
    ddlOutput.value = "";
    return;
  }
  try {
    const rows = parseCSV(text);
    const ddl = buildDDL(rows, tableNameInput.value);
    ddlOutput.value = ddl;
  } catch (err) {
    showError(err.message || String(err));
    ddlOutput.value = "";
  }
}

function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    csvInput.value = reader.result;
    // derive a table name suggestion from the filename, if still default
    const base = file.name.replace(/\.csv$/i, "");
    if (!tableNameInput.value || tableNameInput.value === "my_table") {
      tableNameInput.value = sanitizeTableName(base);
    }
    generate();
  };
  reader.onerror = () => showError("Could not read file: " + reader.error);
  reader.readAsText(file);
}

generateBtn.addEventListener("click", generate);

fileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  loadFile(file);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  loadFile(file);
});

copyBtn.addEventListener("click", async () => {
  if (!ddlOutput.value) return;
  try {
    await navigator.clipboard.writeText(ddlOutput.value);
  } catch (_err) {
    // fallback for contexts where the async Clipboard API is unavailable
    ddlOutput.focus();
    ddlOutput.select();
    document.execCommand("copy");
  }
  copyMsg.hidden = false;
  setTimeout(() => (copyMsg.hidden = true), 1500);
});
