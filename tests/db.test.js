/**
 * Unit tests for the Supabase game recorder.
 *
 * @supabase/supabase-js is replaced with a tiny in-memory fake that records
 * every query, so these check what gets written without a real database.
 */

let db;          // table name → rows
let queries;     // every query run, in order
let failNext;    // table name → error to return for the next query on it

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: table => mockQuery(table) })
}));

let nextId = 1;
function mockQuery(table) {
  const q = { table, op: null, rows: null, values: null, filters: {}, single: false };
  const builder = {
    insert(rows)  { q.op = "insert"; q.rows = [].concat(rows); return builder; },
    upsert(rows)  { q.op = "upsert"; q.rows = [].concat(rows); return builder; },
    update(vals)  { q.op = "update"; q.values = vals; return builder; },
    eq(col, val)  { q.filters[col] = val; return builder; },
    select()      { return builder; },
    single()      { q.single = true; return builder; },
    then(resolve) { resolve(execute(q)); }
  };
  return builder;
}

function execute(q) {
  queries.push(q);
  if (failNext[q.table]) {
    const error = failNext[q.table];
    delete failNext[q.table];
    return { data: null, error };
  }
  const rows = (db[q.table] = db[q.table] || []);
  if (q.op === "insert") {
    const inserted = q.rows.map(r => ({ id: `${q.table}-${nextId++}`, ...r }));
    rows.push(...inserted);
    return { data: q.single ? inserted[0] : inserted, error: null };
  }
  if (q.op === "upsert") {
    q.rows.forEach(r => Object.assign(rows.find(x => x.id === r.id), r));
    return { data: null, error: null };
  }
  if (q.op === "update") {
    rows.filter(r => Object.entries(q.filters).every(([k, v]) => r[k] === v)).forEach(r => Object.assign(r, q.values));
    return { data: null, error: null };
  }
}

function round(n, overrides = {}) {
  return {
    code: "ABCDE",
    settings: { gameDuration: 120, questionCount: 2, totalRounds: 2 },
    roundNumber: n,
    isLastRound: n === 2,
    letter: n === 1 ? "B" : "C",
    categories: [`Cat ${n}a`, `Cat ${n}b`],
    players: [
      { name: "Ajay", score: n, answers: [
        { category: `Cat ${n}a`, answer: "Bob", valid: true, reason: null, double: true },
        { category: `Cat ${n}b`, answer: "", valid: false, reason: "empty", double: false },
      ] },
      { name: "Sam", score: 0, answers: [
        { category: `Cat ${n}a`, answer: " Bear ", valid: false, reason: "voted out", double: false },
        { category: `Cat ${n}b`, answer: "Z", valid: false, reason: "too short", double: false },
      ] },
    ],
    ...overrides
  };
}

let createGameRecorder;
beforeEach(() => {
  db = {}; queries = []; failNext = {};
  process.env.SUPABASE_URL = "http://fake.supabase";
  process.env.SUPABASE_SERVICE_KEY = "fake-key";
  jest.resetModules();
  ({ createGameRecorder } = require("../src/db"));
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("createGameRecorder", () => {
  test("a two-round game is one session with two rounds, not two sessions", async () => {
    const recorder = createGameRecorder();
    await recorder.saveRound(round(1));
    await recorder.saveRound(round(2));

    expect(db.game_sessions).toHaveLength(1);
    expect(db.game_sessions[0]).toMatchObject({ game_code: "ABCDE", duration_sec: 120, question_count: 2, total_rounds: 2 });
    expect(db.game_rounds.map(r => [r.round_number, r.letter])).toEqual([[1, "B"], [2, "C"]]);
    expect(db.game_rounds.every(r => r.session_id === db.game_sessions[0].id)).toBe(true);
  });

  test("players are inserted once and their running total is updated each round", async () => {
    const recorder = createGameRecorder();
    await recorder.saveRound(round(1));
    await recorder.saveRound(round(2));

    expect(db.game_players).toHaveLength(2);
    expect(db.game_players.find(p => p.player_name === "Ajay").final_score).toBe(2);
  });

  test("answers carry their round, points and why they were ruled out", async () => {
    const recorder = createGameRecorder();
    await recorder.saveRound(round(1));
    await recorder.saveRound(round(2));

    expect(db.game_answers).toHaveLength(8);
    const round2 = db.game_rounds.find(r => r.round_number === 2);
    const sam2 = db.game_answers.filter(a => a.round_id === round2.id && a.player_id === db.game_players[1].id);
    expect(sam2).toEqual([
      expect.objectContaining({ round_number: 2, answer: "Bear", valid: false, points: 0, invalid_reason: "voted out" }),
      expect.objectContaining({ round_number: 2, answer: "Z", valid: false, points: 0, invalid_reason: "too short" }),
    ]);
    const ajayDouble = db.game_answers.find(a => a.answer === "Bob");
    expect(ajayDouble).toMatchObject({ valid: true, points: 2, invalid_reason: null });
  });

  test("the session is only marked ended after the last round", async () => {
    const recorder = createGameRecorder();
    await recorder.saveRound(round(1));
    expect(db.game_sessions[0].ended_at).toBeUndefined();
    await recorder.saveRound(round(2));
    expect(db.game_sessions[0].ended_at).toEqual(expect.any(String));
  });

  test("rounds are saved in order even when fired back to back", async () => {
    const recorder = createGameRecorder();
    await Promise.all([recorder.saveRound(round(1)), recorder.saveRound(round(2))]);
    expect(db.game_sessions).toHaveLength(1);
    expect(db.game_rounds.map(r => r.round_number)).toEqual([1, 2]);
  });

  test("separate games get separate sessions", async () => {
    await createGameRecorder().saveRound(round(1));
    await createGameRecorder().saveRound(round(1));
    expect(db.game_sessions).toHaveLength(2);
  });

  test("a failed save is logged, returns null, and doesn't stop later rounds", async () => {
    const recorder = createGameRecorder();
    failNext.game_rounds = { message: "relation \"game_rounds\" does not exist" };
    expect(await recorder.saveRound(round(1))).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("round 1"), expect.stringContaining("game_rounds"));

    expect(await recorder.saveRound(round(2))).toEqual(expect.any(String));
    expect(db.game_sessions).toHaveLength(1);
    expect(db.game_rounds.map(r => r.round_number)).toEqual([2]);
  });

  test("does nothing without Supabase env vars", async () => {
    delete process.env.SUPABASE_URL;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(await createGameRecorder().saveRound(round(1))).toBeNull();
    expect(queries).toHaveLength(0);
  });
});
