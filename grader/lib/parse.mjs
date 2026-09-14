// Pure text/JSON parsers shared by the grader's phase runners, split out of
// report.mjs. No imports: nothing here touches report.mjs state, the
// filesystem, or any node builtin.
export function stripAnsi(text) {
  return String(text ?? "").replace(/\u001B\[[0-9;]*m/g, "");
}

export function truncate(text, max) {
  const clean = String(text ?? "").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max)}…`;
}

export function firstNonEmptyLine(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines[0] || "<empty>";
}

export function textFromEntry(entry) {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && typeof entry.text === "string") {
    return entry.text;
  }
  return "";
}

export function safeProblem(check, expected, observed) {
  return {
    check: String(check ?? "unknown"),
    expected: String(expected ?? ""),
    observed: String(observed ?? ""),
  };
}

export function dedupeProblems(problems) {
  const seen = new Set();
  const out = [];
  for (const problem of problems) {
    const key = `${problem.check}\u0000${problem.expected}\u0000${problem.observed}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(problem);
  }
  return out;
}

export function dedupeStrings(items) {
  return [...new Set(items.filter((item) => item && String(item).trim().length > 0))];
}

export function parseJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // keep going
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

export function extractBalancedSegment(text, open, close, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === close) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return text.slice(start, i + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  return null;
}

export function parseProblemLine(line) {
  const clean = stripAnsi(line).trim();
  if (!clean.startsWith("PROBLEM ")) {
    return null;
  }
  const payload = clean.slice("PROBLEM ".length);
  const expectedMarker = ": expected ";
  const expectedIdx = payload.indexOf(expectedMarker);
  if (expectedIdx < 0) {
    return null;
  }

  const check = payload.slice(0, expectedIdx).trim();
  const tail = payload.slice(expectedIdx + expectedMarker.length);
  const observedMarker = ", observed ";
  const observedIdx = tail.indexOf(observedMarker);
  if (observedIdx < 0) {
    return null;
  }

  const expected = tail.slice(0, observedIdx).trim();
  const observed = tail.slice(observedIdx + observedMarker.length).trim();
  return safeProblem(check, expected, observed);
}

export function parseProblemsFromTextLines(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseProblemLine(line);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export function parseProblemsFromErrorMessage(message) {
  const clean = stripAnsi(String(message ?? ""));
  const out = [];
  let idx = clean.indexOf("[");

  while (idx >= 0) {
    const segment = extractBalancedSegment(clean, "[", "]", idx);
    if (!segment) {
      break;
    }
    try {
      const parsed = JSON.parse(segment);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            item
            && typeof item === "object"
            && typeof item.check === "string"
            && Object.prototype.hasOwnProperty.call(item, "expected")
            && Object.prototype.hasOwnProperty.call(item, "observed")
          ) {
            out.push(safeProblem(item.check, item.expected, item.observed));
          }
        }
        if (out.length > 0) {
          return out;
        }
      }
    } catch {
      // keep searching for a parseable JSON array
    }

    idx = clean.indexOf("[", idx + 1);
  }

  return out;
}

export function collectPlaywrightSpecs(suites, out = []) {
  if (!Array.isArray(suites)) {
    return out;
  }

  for (const suite of suites) {
    if (Array.isArray(suite?.specs)) {
      out.push(...suite.specs);
    }
    if (Array.isArray(suite?.suites)) {
      collectPlaywrightSpecs(suite.suites, out);
    }
  }
  return out;
}

export function extractPlaywrightRunError(report) {
  if (!report || !Array.isArray(report.errors) || report.errors.length === 0) {
    return "";
  }

  for (const errorEntry of report.errors) {
    if (typeof errorEntry === "string" && errorEntry.trim()) {
      return stripAnsi(errorEntry.trim());
    }
    if (errorEntry && typeof errorEntry === "object") {
      if (typeof errorEntry.message === "string" && errorEntry.message.trim()) {
        return stripAnsi(errorEntry.message.trim());
      }
      const serialized = stripAnsi(JSON.stringify(errorEntry));
      if (serialized.trim()) {
        return serialized;
      }
    }
  }
  return "";
}
