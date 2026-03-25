/**
 * Scattergories Integration Tests
 *
 * Uses force_end_round (test-only socket event) to skip real timers entirely.
 * All tests complete in seconds, not minutes.
 */

jest.mock("../src/db", () => ({
  saveGameSession: jest.fn().mockResolvedValue("mock-session-id"),
  fetchSessionAnswers: jest.fn().mockResolvedValue({})
}));

const { io: clientIo } = require("socket.io-client");
const { server, rooms } = require("../src/server");

// ─── Setup ───────────────────────────────────────────────────────────────────

let port;
const allClients = [];

beforeAll(done => {
  server.listen(0, () => { port = server.address().port; done(); });
});

afterEach(async () => {
  // Kill any running timers so they don't fire into the next test
  Object.values(rooms).forEach(room => {
    if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
  });
  allClients.forEach(c => { try { c.disconnect(); } catch (_) {} });
  allClients.length = 0;
  await new Promise(r => setTimeout(r, 100));
});

afterAll(done => {
  server.closeAllConnections?.();
  server.close(done);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeClient() {
  const c = clientIo(`http://localhost:${port}`, {
    autoConnect: true, reconnection: false, transports: ["websocket"]
  });
  allClients.push(c);
  return c;
}

function emit(socket, event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}

function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for "${event}"`)),
      timeoutMs
    );
    socket.once(event, data => { clearTimeout(timer); resolve(data); });
  });
}

// answers_grid is now bundled inside phase_change — extract it from there
function waitForGrid(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for answers_grid in phase_change')),
      timeoutMs
    );
    function onPhase(data) {
      if (data.answersGrid) { clearTimeout(timer); resolve(data.answersGrid); }
      else socket.once("phase_change", onPhase); // keep listening if no grid yet
    }
    socket.once("phase_change", onPhase);
  });
}

// Standard game setup helpers
async function createAndJoin(hostName = "Host", playerName = "Alice", opts = {}) {
  const host   = makeClient();
  const player = makeClient();
  const { code } = await emit(host, "create_game", {
    playerName: hostName,
    gameDuration: 120,
    questionCount: opts.questionCount || 3,
    totalRounds: opts.totalRounds || 1
  });
  await emit(player, "join_game", { playerName, code });
  return { host, player, code };
}

async function startGame(host, player) {
  const started = [waitFor(host, "game_started"), waitFor(player, "game_started")];
  await emit(host, "start_game", {});
  await Promise.all(started);
}

async function forceEndRound(host, ...others) {
  const clients = [host, ...others];
  const phases = Promise.all(clients.map(c => waitFor(c, "phase_change", 5000)));
  await emit(host, "force_end_round", {});
  return phases;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Lobby", () => {
  test("host can create a game and gets a room code", async () => {
    const host = makeClient();
    const res = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 15, totalRounds: 3
    });
    expect(res.success).toBe(true);
    expect(res.code).toHaveLength(5);
    expect(res.isHost).toBe(true);
  });

  test("player can join an existing lobby", async () => {
    const { host, player } = await createAndJoin();
    const res = await emit(player, "join_game", { playerName: "Bob", code: (await emit(host, "create_game", { playerName: "H", gameDuration: 120, questionCount: 3, totalRounds: 1 })).code });
    expect(res.success).toBe(true);
  });

  test("cannot join a non-existent game", async () => {
    const player = makeClient();
    const res = await emit(player, "join_game", { playerName: "Alice", code: "XXXXX" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  test("joining players are broadcast to existing players", async () => {
    const host   = makeClient();
    const player = makeClient();
    const { code } = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 5, totalRounds: 1
    });
    const updatePromise = waitFor(host, "room_update");
    await emit(player, "join_game", { playerName: "Alice", code });
    const update = await updatePromise;
    expect(update.players.map(p => p.name)).toContain("Alice");
  });

  test("cannot join a game already in progress", async () => {
    const { host, player, code } = await createAndJoin();
    await startGame(host, player);
    const latecomer = makeClient();
    const res = await emit(latecomer, "join_game", { playerName: "Late", code });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/in progress/i);
  });
});

describe("Game flow", () => {
  test("host starts game and all players receive game_started", async () => {
    const { host, player } = await createAndJoin();
    const [hostEvt, playerEvt] = await Promise.all([
      waitFor(host,   "game_started"),
      waitFor(player, "game_started"),
      emit(host, "start_game", {})
    ]);
    expect(hostEvt.letter).toMatch(/^[A-Z]$/);
    expect(hostEvt.categories).toHaveLength(3);
    expect(hostEvt.currentRound).toBe(1);
    expect(playerEvt.letter).toBe(hostEvt.letter);
  });

  test("answers are autosaved", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    const res = await emit(player, "save_answers", { answers: { 0: "Antelope", 1: "Amsterdam" } });
    expect(res.success).toBe(true);
  });

  test("force_end_round triggers review phase", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    const [hostEvt] = await forceEndRound(host, player);
    expect(hostEvt.phase).toBe("review");
  });
});

describe("Duplicate detection", () => {
  test("duplicate answers are flagged", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: "Antelope" } });
    await emit(player, "save_answers", { answers: { 0: "Antelope" } });

    const [hostGrid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player)
    ]);
    const cat0 = hostGrid.find(g => g.categoryIndex === 0);
    expect(cat0.entries.every(e => e.flagged)).toBe(true);
  });

  test("unique answers are not flagged", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: "Antelope"  } });
    await emit(player, "save_answers", { answers: { 0: "Albatross" } });

    const [hostGrid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player)
    ]);
    const cat0 = hostGrid.find(g => g.categoryIndex === 0);
    expect(cat0.entries.some(e => e.flagged)).toBe(false);
  });
});

describe("Voting", () => {
  test("player cannot vote on their own answer", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    const [grid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player)
    ]);
    const hostEntry = grid[0].entries.find(e => e.playerName === "Host");
    const res = await emit(host, "vote", {
      categoryIndex: 0, targetPlayerId: hostEntry.playerId, voteType: "no"
    });
    expect(res.success).toBe(false);
  });

  test("majority no vote flags an answer (3 players)", async () => {
    const host    = makeClient();
    const player1 = makeClient();
    const player2 = makeClient();
    const { code } = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 3, totalRounds: 1
    });
    await emit(player1, "join_game", { playerName: "Alice", code });
    await emit(player2, "join_game", { playerName: "Bob",   code });

    const started = [waitFor(host, "game_started"), waitFor(player1, "game_started"), waitFor(player2, "game_started")];
    await emit(host, "start_game", {});
    await Promise.all(started);

    await emit(host,    "save_answers", { answers: { 0: "Aardvark"  } });
    await emit(player1, "save_answers", { answers: { 0: "Albatross" } });
    await emit(player2, "save_answers", { answers: { 0: "Axolotl"   } });

    const [grid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player1, player2)
    ]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;

    // 3 players, 2 eligible voters — need 2 no votes (majority of 2)
    await emit(player1, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "no" });
    const finalGridPromise = waitFor(host, "vote_update");
    await emit(player2, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "no" });
    const finalGrid = await finalGridPromise;
    expect(finalGrid[0].entries.find(e => e.playerName === "Host").flagged).toBe(true);
  });

  test("single no vote flags answer in 2-player game", async () => {
    const { host, player, code } = await createAndJoin();
    await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: "Aardvark"  } });
    await emit(player, "save_answers", { answers: { 0: "Albatross" } });

    const [grid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player)
    ]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;

    // 2 players — only 1 eligible voter, so 1 no vote = majority
    const finalGridPromise = waitFor(host, "vote_update");
    await emit(player, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "no" });
    const finalGrid = await finalGridPromise;
    expect(finalGrid[0].entries.find(e => e.playerName === "Host").flagged).toBe(true);
  });
});

describe("Scoring", () => {
  test("scores calculated correctly after finalise", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: "Antelope", 1: "Austria",  2: "" } });
    await emit(player, "save_answers", { answers: { 0: "Albatross", 1: "Albania", 2: "" } });

    await forceEndRound(host, player);

    const result = await new Promise(resolve => {
      host.once("phase_change", resolve);
      emit(host, "finalise_scores", {});
    });
    expect(result.scoreboard.find(p => p.name === "Host").score).toBe(2);
  });

  test("double points awarded for answer starting and ending with round letter", async () => {
    const { host, player } = await createAndJoin();
    const [startEvt] = await Promise.all([
      waitFor(host,   "game_started"),
      waitFor(player, "game_started"),
      emit(host, "start_game", {})
    ]);
    const L = startEvt.letter; // e.g. "A"

    // Construct an answer that starts and ends with L e.g. "AuroraA"
    const doubleAnswer = `${L}urora${L}`;
    await emit(host,   "save_answers", { answers: { 0: doubleAnswer } }); // worth 2
    await emit(player, "save_answers", { answers: { 0: `${L}lpha`  } }); // worth 1

    await forceEndRound(host, player);

    const result = await new Promise(resolve => {
      host.once("phase_change", resolve);
      emit(host, "finalise_scores", {});
    });
    expect(result.scoreboard.find(p => p.name === "Host").score).toBe(2);
    expect(result.scoreboard.find(p => p.name === "Alice").score).toBe(1);
  });

  test("scores accumulate across rounds", async () => {
    const { host, player } = await createAndJoin("Host", "Alice", { questionCount: 2, totalRounds: 2 });

    // Round 1
    await startGame(host, player);
    // Use answers where last letter != first letter to avoid accidental double points
    await emit(host,   "save_answers", { answers: { 0: "Antelope", 1: "Autumn"   } });
    await emit(player, "save_answers", { answers: { 0: "Albatross", 1: "Apricot" } });
    await forceEndRound(host, player);

    const r1 = await new Promise(resolve => { host.once("phase_change", resolve); emit(host, "finalise_scores", {}); });
    expect(r1.phase).toBe("between_rounds");
    expect(r1.scoreboard.find(p => p.name === "Host").score).toBe(2);

    // Round 2
    const started2 = [waitFor(host, "game_started"), waitFor(player, "game_started")];
    await emit(host, "next_round", {});
    await Promise.all(started2);

    await emit(host,   "save_answers", { answers: { 0: "Apricot", 1: "Autumn"  } });
    await emit(player, "save_answers", { answers: { 0: "Avocado", 1: "Apricot" } });
    await forceEndRound(host, player);

    const r2 = await new Promise(resolve => { host.once("phase_change", resolve); emit(host, "finalise_scores", {}); });
    expect(r2.phase).toBe("scores");
    // Score should have increased from round 1 — exact value depends on letter/double pts
    const hostFinal = r2.scoreboard.find(p => p.name === "Host").score;
    const hostR1    = r1.scoreboard.find(p => p.name === "Host").score;
    expect(hostFinal).toBeGreaterThan(hostR1);
  }, 20000);
});

describe("Rejoin", () => {
  test("disconnected player rejoins during playing with answers restored", async () => {
    const { host, player, code } = await createAndJoin();
    await startGame(host, player);
    await emit(player, "save_answers", { answers: { 0: "Antelope", 1: "Austria" } });

    player.disconnect();
    await new Promise(r => setTimeout(r, 400));

    const rejoiner = makeClient();
    const res = await emit(rejoiner, "join_game", { playerName: "Alice", code });
    expect(res.success).toBe(true);
    expect(res.rejoined).toBe(true);
    expect(res.phase).toBe("playing");
    expect(res.myAnswers[0]).toBe("Antelope");
    expect(res.myAnswers[1]).toBe("Austria");
  });

  test("rejoining player preserves score", async () => {
    const { host, player, code } = await createAndJoin("Host", "Alice", { questionCount: 2, totalRounds: 2 });
    await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: "Antelope" } });
    await emit(player, "save_answers", { answers: { 0: "Albatross" } });
    await forceEndRound(host, player);

    const r1 = await new Promise(resolve => { host.once("phase_change", resolve); emit(host, "finalise_scores", {}); });
    const aliceScore = r1.scoreboard.find(p => p.name === "Alice")?.score;
    expect(aliceScore).toBeGreaterThan(0);

    player.disconnect();
    await new Promise(r => setTimeout(r, 400));

    const rejoiner = makeClient();
    const res = await emit(rejoiner, "join_game", { playerName: "Alice", code });
    expect(res.success).toBe(true);
    expect(res.rejoined).toBe(true);
    expect(res.scoreboard?.find(p => p.name === "Alice")?.score).toBe(aliceScore);
  }, 20000);
});