/**
 * Snapshot tests for scoring UI
 *
 * These tests extract the rendering functions from index.html and verify
 * the HTML output matches exactly. If the output changes unexpectedly,
 * the snapshot fails and you'll see a diff of what changed.
 *
 * To update snapshots intentionally after a UI change:
 *   npm test -- --updateSnapshot
 */

const fs = require("fs");
const path = require("path");

// ─── Extract JS functions from index.html ─────────────────────────────────────
// We pull the <script> block out of the HTML and eval the functions we need,
// rather than importing a module — since the frontend is a single HTML file.

const html = fs.readFileSync(
  path.join(__dirname, "../public/index.html"),
  "utf8"
);

// Grab everything between <script> and </script>
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("Could not find <script> block in index.html");
const scriptContent = scriptMatch[1];

// Extract a named function by name from the script block
function extractFn(name, src) {
  // Matches: function name(...) { ... } — handles nested braces
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Function "${name}" not found in script`);
  let depth = 0, i = start;
  while (i < src.length) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  throw new Error(`Could not extract function "${name}"`);
}

// Build a minimal sandbox that the functions need
function buildSandbox(overrides = {}) {
  // escHtml is used by both render functions
  function escHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  return { escHtml, ...overrides };
}

// Evaluate a function string in a sandbox and return it
function evalFn(fnStr, sandbox) {
  const keys   = Object.keys(sandbox);
  const values = Object.values(sandbox);
  // eslint-disable-next-line no-new-func
  return new Function(...keys, `return (${fnStr})`)(...values);
}

// ─── Extract the two functions we care about ──────────────────────────────────

const renderScoreboardSrc = extractFn("renderScoreboard", scriptContent);
const renderMyAnswersSrc  = extractFn("renderMyAnswers",  scriptContent);

// renderMyAnswers references myAnswersSummary from outer scope — inject it
function getRenderMyAnswers(myAnswersSummary) {
  const sandbox = { ...buildSandbox(), myAnswersSummary };
  return evalFn(renderMyAnswersSrc, sandbox);
}

function getRenderScoreboard() {
  return evalFn(renderScoreboardSrc, buildSandbox());
}

// ─── Test data ────────────────────────────────────────────────────────────────

const sampleScoreboard = [
  { id: "s1", name: "Ajay",  score: 10, roundScore: 4 },
  { id: "s2", name: "Sam",   score:  8, roundScore: 3 },
  { id: "s3", name: "Alice", score:  5, roundScore: 2 },
];

const sampleAnswers = [
  { category: "An animal",       answer: "Albatross", valid: true  },
  { category: "A city",          answer: "Amsterdam", valid: true  },
  { category: "A food or drink", answer: "Avocado",   valid: true  },
  { category: "A TV show",       answer: "Archer",    valid: false }, // duplicate
  { category: "A boy's name",    answer: "",          valid: false }, // empty
];

// ─── Snapshot tests ───────────────────────────────────────────────────────────

describe("renderScoreboard snapshots", () => {
  test("final scores (no round score column)", () => {
    const renderScoreboard = getRenderScoreboard();
    const html = renderScoreboard(sampleScoreboard, false);
    expect(html).toMatchSnapshot();
  });

  test("between-rounds (with round score column)", () => {
    const renderScoreboard = getRenderScoreboard();
    const html = renderScoreboard(sampleScoreboard, true);
    expect(html).toMatchSnapshot();
  });

  test("single player scoreboard", () => {
    const renderScoreboard = getRenderScoreboard();
    const html = renderScoreboard([{ id: "s1", name: "Solo", score: 7, roundScore: 7 }], true);
    expect(html).toMatchSnapshot();
  });

  test("empty scoreboard", () => {
    const renderScoreboard = getRenderScoreboard();
    const html = renderScoreboard([], false);
    expect(html).toMatchSnapshot();
  });
});

describe("renderMyAnswers snapshots", () => {
  test("mix of valid and invalid answers", () => {
    const renderMyAnswers = getRenderMyAnswers(sampleAnswers);
    const html = renderMyAnswers();
    expect(html).toMatchSnapshot();
  });

  test("all answers valid", () => {
    const allValid = sampleAnswers.map(a => ({ ...a, valid: true }));
    const renderMyAnswers = getRenderMyAnswers(allValid);
    const html = renderMyAnswers();
    expect(html).toMatchSnapshot();
  });

  test("all answers invalid", () => {
    const allInvalid = sampleAnswers.map(a => ({ ...a, valid: false }));
    const renderMyAnswers = getRenderMyAnswers(allInvalid);
    const html = renderMyAnswers();
    expect(html).toMatchSnapshot();
  });

  test("empty answers list returns empty string", () => {
    const renderMyAnswers = getRenderMyAnswers([]);
    const html = renderMyAnswers();
    expect(html).toBe("");
  });
});

describe("renderMyAnswers content checks", () => {
  // These go further than snapshots — they assert specific content is present

  test("valid answers show green color and point label", () => {
    const renderMyAnswers = getRenderMyAnswers(sampleAnswers);
    const html = renderMyAnswers();
    expect(html).toContain("accent3");      // green color variable
    expect(html).toContain("✓ 1 pt");
    expect(html).toContain("Albatross");
    expect(html).toContain("Amsterdam");
  });

  test("invalid answers show red color and no-point label", () => {
    const renderMyAnswers = getRenderMyAnswers(sampleAnswers);
    const html = renderMyAnswers();
    expect(html).toContain("accent2");      // red color variable
    expect(html).toContain("✗ no point");
    expect(html).toContain("Archer");       // the duplicate
  });

  test("empty answers show dash not blank", () => {
    const renderMyAnswers = getRenderMyAnswers(sampleAnswers);
    const html = renderMyAnswers();
    // The empty answer row should contain — somewhere in the output
    expect(html).toContain("—");
  });

  test("all category names are present", () => {
    const renderMyAnswers = getRenderMyAnswers(sampleAnswers);
    const html = renderMyAnswers();
    sampleAnswers.forEach(a => {
      expect(html).toContain(a.category);
    });
  });

  test("scores are rendered in rank order", () => {
    const renderScoreboard = getRenderScoreboard();
    const html = renderScoreboard(sampleScoreboard, false);
    const ajayPos = html.indexOf("Ajay");
    const samPos  = html.indexOf("Sam");
    const alicePos = html.indexOf("Alice");
    expect(ajayPos).toBeLessThan(samPos);
    expect(samPos).toBeLessThan(alicePos);
  });
});