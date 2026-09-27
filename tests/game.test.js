/**
 * Scattergories Integration Tests
 *
 * Uses force_end_round (test-only socket event) to skip real timers entirely.
 * All tests complete in seconds, not minutes.
 */

jest.mock("../src/db", () => ({
  saveGameSession: jest.fn().mockResolvedValue("mock-session-id")
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

// Resolves with the round letter
async function startGame(host, ...players) {
  const started = [host, ...players].map(c => waitFor(c, "game_started"));
  await emit(host, "start_game", {});
  const [evt] = await Promise.all(started);
  return evt.letter;
}

async function nextRound(host, ...players) {
  const started = [host, ...players].map(c => waitFor(c, "game_started"));
  await emit(host, "next_round", {});
  const [evt] = await Promise.all(started);
  return evt.letter;
}

function finalise(host) {
  return new Promise(resolve => { host.once("phase_change", resolve); emit(host, "finalise_scores", {}); });
}

// Stems ending in a letter never used as a round letter, so answers can't earn double points by accident
const w = (L, stem) => `${L}${stem}`;

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
    const host   = makeClient();
    const player = makeClient();
    const { code } = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 3, totalRounds: 1
    });
    const res = await emit(player, "join_game", { playerName: "Bob", code });
    expect(res.success).toBe(true);
    expect(res.playerId).toBeTruthy();
    expect(res.token).toBeTruthy();
  });

  test("room codes are 5 unambiguous characters and joining is case-insensitive", async () => {
    const host   = makeClient();
    const player = makeClient();
    const { code } = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 3, totalRounds: 1
    });
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    const res = await emit(player, "join_game", { playerName: "Alice", code: ` ${code.toLowerCase()} ` });
    expect(res.success).toBe(true);
  });

  test("cannot take a name already used by a connected player", async () => {
    const { code } = await createAndJoin();
    const impostor = makeClient();
    const res = await emit(impostor, "join_game", { playerName: " alice ", code });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/taken/i);
  });

  test("blank names are rejected", async () => {
    const host = makeClient();
    const res = await emit(host, "create_game", { playerName: "   ", gameDuration: 120, questionCount: 3, totalRounds: 1 });
    expect(res.success).toBe(false);
  });

  test("room is deleted when everyone leaves the lobby", async () => {
    const { host, player, code } = await createAndJoin();
    host.disconnect(); player.disconnect();
    await new Promise(r => setTimeout(r, 200));
    expect(rooms[code]).toBeUndefined();
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

  test("start_game is ignored once a round is running", async () => {
    const { host, player, code } = await createAndJoin();
    await startGame(host, player);
    const timer = rooms[code].timerInterval;
    const res = await emit(host, "start_game", {});
    expect(res.success).toBe(false);
    expect(rooms[code].timerInterval).toBe(timer);
    expect(rooms[code].currentRound).toBe(1);
  });

  test("next_round is only allowed between rounds", async () => {
    const { host, player } = await createAndJoin("Host", "Alice", { totalRounds: 2 });
    await startGame(host, player);
    expect((await emit(host, "next_round", {})).success).toBe(false);
    await forceEndRound(host, player);
    expect((await emit(host, "next_round", {})).success).toBe(false);
  });

  test("letters don't repeat within a game", async () => {
    const { host, player } = await createAndJoin("Host", "Alice", { totalRounds: 3 });
    const letters = [await startGame(host, player)];
    for (let i = 0; i < 2; i++) {
      await forceEndRound(host, player);
      await finalise(host);
      letters.push(await nextRound(host, player));
    }
    expect(new Set(letters).size).toBe(3);
  }, 20000);

  test("malformed payloads are rejected without crashing the round", async () => {
    const { host, player, code } = await createAndJoin();
    const L = await startGame(host, player);
    expect((await emit(player, "save_answers", { answers: null })).success).toBe(false);
    expect((await emit(player, "save_answers", null)).success).toBe(false);
    player.emit("save_answers"); // no payload, no ack
    await emit(player, "save_answers", { answers: { 0: w(L, "x".repeat(100)), 1: 42, 99: w(L, "ox") } });
    expect(rooms[code].players[Object.keys(rooms[code].players)[1]].answers).toEqual({ 0: w(L, "x".repeat(39)) });
    const [hostEvt] = await forceEndRound(host, player);
    expect(hostEvt.phase).toBe("review");
  });
});

describe("Duplicate detection", () => {
  test("duplicate answers are flagged", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: w(L, "ntelopy") } });
    await emit(player, "save_answers", { answers: { 0: w(L, "ntelopy") } });

    const [hostGrid] = await Promise.all([
      waitForGrid(host),
      forceEndRound(host, player)
    ]);
    const cat0 = hostGrid.find(g => g.categoryIndex === 0);
    expect(cat0.entries.every(e => e.flagged)).toBe(true);
    expect(cat0.entries.every(e => e.flagReason === "duplicate")).toBe(true);
  });

  test("duplicates ignore case, punctuation, spacing and leading articles", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: `${L}ob-Sky`, 1: `The ${L}ox` } });
    await emit(player, "save_answers", { answers: { 0: `${L.toLowerCase()}ob sky!`, 1: `${L}ox` } });

    const [hostGrid] = await Promise.all([waitForGrid(host), forceEndRound(host, player)]);
    expect(hostGrid[0].entries.every(e => e.flagReason === "duplicate")).toBe(true);
    expect(hostGrid[1].entries.every(e => e.flagReason === "duplicate")).toBe(true);
  });

  test("answers that don't start with the round letter are flagged", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);
    const other = L === "Z" ? "Q" : "Z"; // Z is never a round letter

    await emit(host,   "save_answers", { answers: { 0: `${other}ebra`, 1: `The ${L}ox`, 2: `${L} ` } });
    await emit(player, "save_answers", { answers: { 0: w(L, "ay") } });

    const [hostGrid] = await Promise.all([waitForGrid(host), forceEndRound(host, player)]);
    const hostEntry = ci => hostGrid[ci].entries.find(e => e.playerName === "Host");
    expect(hostEntry(0).flagReason).toBe("wrong letter");
    expect(hostEntry(1).flagged).toBe(false); // leading "The" is skipped
    expect(hostEntry(2).flagged).toBe(false); // a single letter still starts with it

    const result = await finalise(host);
    expect(result.scoreboard.find(p => p.name === "Host").score).toBe(2);
  });

  test("unique answers are not flagged", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: w(L, "ntelopy") } });
    await emit(player, "save_answers", { answers: { 0: w(L, "lbatrox") } });

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

    const L = await startGame(host, player1, player2);

    await emit(host,    "save_answers", { answers: { 0: w(L, "ardvarx") } });
    await emit(player1, "save_answers", { answers: { 0: w(L, "lbatrox") } });
    await emit(player2, "save_answers", { answers: { 0: w(L, "xolotly") } });

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
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: w(L, "ardvarx") } });
    await emit(player, "save_answers", { answers: { 0: w(L, "lbatrox") } });

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

  test("a no vote can be taken back", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);
    await emit(host, "save_answers", { answers: { 0: w(L, "ardvarx") } });

    const [grid] = await Promise.all([waitForGrid(host), forceEndRound(host, player)]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;

    await emit(player, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "no" });
    const updated = waitFor(host, "vote_update");
    const res = await emit(player, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "clear" });
    expect(res.success).toBe(true);
    const entry = (await updated)[0].entries.find(e => e.playerName === "Host");
    expect(entry.flagged).toBe(false);
    expect(entry.voteNo).toBe(0);
  });

  test("votes can't rescue auto-flagged answers", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    // Host leaves category 0 empty
    const [grid] = await Promise.all([waitForGrid(host), forceEndRound(host, player)]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;
    const res = await emit(player, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "yes" });
    expect(res.success).toBe(false);
  });

  test("invalid votes are rejected", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    const [grid] = await Promise.all([waitForGrid(host), forceEndRound(host, player)]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;
    for (const bad of [
      { categoryIndex: 99, targetPlayerId: hostPlayerId, voteType: "no" },
      { categoryIndex: 0, targetPlayerId: "__proto__", voteType: "no" },
      { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "maybe" },
    ]) {
      expect((await emit(player, "vote", bad)).success).toBe(false);
    }
  });

  test("disconnected players don't count towards the majority", async () => {
    const host    = makeClient();
    const player1 = makeClient();
    const player2 = makeClient();
    const { code } = await emit(host, "create_game", {
      playerName: "Host", gameDuration: 120, questionCount: 3, totalRounds: 1
    });
    await emit(player1, "join_game", { playerName: "Alice", code });
    await emit(player2, "join_game", { playerName: "Bob",   code });
    const L = await startGame(host, player1, player2);
    await emit(host, "save_answers", { answers: { 0: w(L, "ardvarx") } });

    const [grid] = await Promise.all([waitForGrid(host), forceEndRound(host, player1, player2)]);
    const hostPlayerId = grid[0].entries.find(e => e.playerName === "Host").playerId;

    player2.disconnect();
    await new Promise(r => setTimeout(r, 200));

    // Only Alice is left to vote on Host's answer, so her no is a majority
    const updated = waitFor(host, "vote_update");
    await emit(player1, "vote", { categoryIndex: 0, targetPlayerId: hostPlayerId, voteType: "no" });
    expect((await updated)[0].entries.find(e => e.playerName === "Host").flagReason).toBe("voted out");
  });
});

describe("Scoring", () => {
  test("scores calculated correctly after finalise", async () => {
    const { host, player } = await createAndJoin();
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: w(L, "ntelopy"), 1: w(L, "ustrix"),  2: "" } });
    await emit(player, "save_answers", { answers: { 0: w(L, "lbatrox"), 1: w(L, "lbaniy"), 2: "" } });

    await forceEndRound(host, player);

    const result = await finalise(host);
    expect(result.scoreboard.find(p => p.name === "Host").score).toBe(2);
  });

  test("finalising twice doesn't count the round twice", async () => {
    const { host, player, code } = await createAndJoin();
    const L = await startGame(host, player);
    await emit(host, "save_answers", { answers: { 0: w(L, "ntelopy"), 1: w(L, "ustrix") } });
    await forceEndRound(host, player);

    const result = await finalise(host);
    expect((await emit(host, "finalise_scores", {})).success).toBe(false);
    const hostState = Object.values(rooms[code].players).find(p => p.name === "Host");
    expect(hostState.score).toBe(result.scoreboard.find(p => p.name === "Host").score);
    expect(hostState.score).toBe(2);
  });

  test("only the host can finalise", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    await forceEndRound(host, player);
    expect((await emit(player, "finalise_scores", {})).success).toBe(false);
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
    await emit(player, "save_answers", { answers: { 0: w(L, "lphy") } }); // worth 1

    await forceEndRound(host, player);

    const result = await finalise(host);
    expect(result.scoreboard.find(p => p.name === "Host").score).toBe(2);
    expect(result.scoreboard.find(p => p.name === "Alice").score).toBe(1);
  });

  test("scores accumulate across rounds", async () => {
    const { host, player } = await createAndJoin("Host", "Alice", { questionCount: 2, totalRounds: 2 });

    // Round 1
    const L1 = await startGame(host, player);
    await emit(host,   "save_answers", { answers: { 0: w(L1, "ntelopy"), 1: w(L1, "utumx") } });
    await emit(player, "save_answers", { answers: { 0: w(L1, "lbatrox"), 1: w(L1, "pricox") } });
    await forceEndRound(host, player);

    const r1 = await finalise(host);
    expect(r1.phase).toBe("between_rounds");
    expect(r1.scoreboard.find(p => p.name === "Host").score).toBe(2);

    // Round 2 — host's second answer duplicates Alice's
    const L2 = await nextRound(host, player);
    await emit(host,   "save_answers", { answers: { 0: w(L2, "pricox"), 1: w(L2, "utumx") } });
    await emit(player, "save_answers", { answers: { 0: w(L2, "vocadx"), 1: w(L2, "utumx") } });
    await forceEndRound(host, player);

    const r2 = await finalise(host);
    expect(r2.phase).toBe("scores");
    expect(r2.scoreboard.find(p => p.name === "Host").score).toBe(3);
    expect(r2.scoreboard.find(p => p.name === "Host").roundScore).toBe(1);
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
    const L = await startGame(host, player);

    await emit(host,   "save_answers", { answers: { 0: w(L, "ntelopy") } });
    await emit(player, "save_answers", { answers: { 0: w(L, "lbatrox") } });
    await forceEndRound(host, player);

    const r1 = await finalise(host);
    const aliceScore = r1.scoreboard.find(p => p.name === "Alice")?.score;
    expect(aliceScore).toBeGreaterThan(0);

    player.disconnect();
    await new Promise(r => setTimeout(r, 400));

    const rejoiner = makeClient();
    const res = await emit(rejoiner, "join_game", { playerName: "Alice", code });
    expect(res.success).toBe(true);
    expect(res.rejoined).toBe(true);
    expect(res.scoreboard?.find(p => p.name === "Alice")?.score).toBe(aliceScore);
    expect(res.myAnswers[0].valid).toBe(true);
  }, 20000);

  test("rejoined player is marked connected again", async () => {
    const { host, player, code } = await createAndJoin();
    await startGame(host, player);
    player.disconnect();
    await new Promise(r => setTimeout(r, 200));

    const update = waitFor(host, "room_update");
    await emit(makeClient(), "join_game", { playerName: "Alice", code });
    const alice = (await update).players.find(p => p.name === "Alice");
    expect(alice.connected).toBe(true);
  });

  test("token lets a new connection take over a seat whose old socket is still open", async () => {
    const host   = makeClient();
    const player = makeClient();
    const { code } = await emit(host, "create_game", { playerName: "Host", gameDuration: 120, questionCount: 3, totalRounds: 1 });
    const { token } = await emit(player, "join_game", { playerName: "Alice", code });
    const L = await startGame(host, player);
    await emit(player, "save_answers", { answers: { 0: w(L, "ntelopy") } });

    const replaced = waitFor(player, "session_replaced");
    const fresh = makeClient();
    const res = await emit(fresh, "join_game", { code, token });
    await replaced;
    expect(res.success).toBe(true);
    expect(res.phase).toBe("playing");
    expect(res.myAnswers[0]).toBe(w(L, "ntelopy"));

    // The old socket no longer speaks for Alice
    expect((await emit(player, "save_answers", { answers: { 0: "x" } })).success).toBe(false);
    expect((await emit(fresh,  "save_answers", { answers: { 0: w(L, "lbatrox") } })).success).toBe(true);
  });

  test("host role moves on if the host drops mid-review, and the new host can finalise", async () => {
    const { host, player } = await createAndJoin();
    await startGame(host, player);
    await forceEndRound(host, player);

    const promoted = waitFor(player, "you_are_host");
    host.disconnect();
    await promoted;

    const result = await finalise(player);
    expect(result.phase).toBe("scores");
  });
});