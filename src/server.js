require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { createGameRecorder } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// ─── Game Data ────────────────────────────────────────────────────────────────

const CATEGORIES_POOL = [
  // People & Names
  "A boy's name", "A girl's name", "A famous person's last name",
  "A US president's last name", "A celebrity first name", "A fictional character",
  "A superhero", "A Disney character", "A cartoon character", "A video game character",
  // Places
  "A city", "A country", "A US state", "A capital city", "A tourist destination",
  "Something you find at the beach", "Something you find in a forest",
  "Something you find in a city", "A landmark or monument", "A type of store or shop",
  // Animals & Nature
  "An animal", "A farm animal", "A wild animal", "A sea creature", "A bird",
  "An insect", "A type of dog breed", "A flower", "A tree", "A fruit",
  "A vegetable", "Something in the sky", "A natural disaster",
  // Food & Drink
  "A food or drink", "A breakfast food", "A snack food", "A dessert",
  "A type of cuisine", "Something you put on a sandwich", "A fast food item",
  "A pizza topping", "A type of candy", "Something you drink", "A cocktail or mocktail",
  // Entertainment & Media
  "A movie title", "A TV show", "A Netflix series", "A type of movie genre",
  "A song title", "A band or music artist", "A video game", "A board game",
  "A podcast", "A book title", "A children's book", "A magazine",
  // Sports & Activities
  "A sport", "A hobby", "An Olympic sport", "Something you do at a gym",
  "A card game", "An outdoor activity", "A dance style", "A martial art",
  "A water sport", "A team sport",
  // Everyday Life & Objects
  "Something in a kitchen", "Something in a bedroom", "Something in a bathroom",
  "Something in a school", "Something in an office", "A type of clothing",
  "A piece of jewellery", "A household appliance", "Something you carry in a bag",
  "A tool", "A type of vehicle", "Something with wheels", "A mode of transport",
  "Something electronic", "A type of furniture",
  // Science & Knowledge
  "A musical instrument", "A school subject", "A science term",
  "A planet or space object", "A type of weather", "A body part",
  "A job or profession", "Something in a hospital", "A type of doctor or specialist",
  "A language", "A unit of measurement",
  // Fun & Miscellaneous
  "Something that makes you happy", "Something that is yellow", "Something that is cold",
  "Something that is loud", "Something you find at a party", "Something you do on a weekend",
  "Something you give as a gift", "Something that comes in pairs", "Something with a smell",
  "Something in a museum", "Something scary", "Something you collect",
  "A reason to celebrate", "Something that needs batteries", "A holiday or festival",
  "A type of hat", "A type of bag", "A type of shoe", "Something in a garden",
  "A phrase or expression",
];

const LETTERS = "ABCDEFGHIJKLMNOPRSTW".split("");
const DEFAULT_DURATION = 120;
const DEFAULT_QUESTIONS = 15;
const DEFAULT_ROUNDS = 3;
const MAX_PLAYERS = 10;
const MAX_NAME_LENGTH = 20;
const MAX_ANSWER_LENGTH = 40;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I lookalikes
const CODE_LENGTH = 5;
const ABANDONED_ROOM_TTL_MS = 10 * 60 * 1000; // how long a room survives once everyone has disconnected
// Phones drop the connection whenever the browser is backgrounded. Only treat a
// player as away (announce it, hand over host, shrink the voter pool) if they
// haven't reconnected within this window.
const AWAY_GRACE_MS = Number(process.env.AWAY_GRACE_MS) || 30 * 1000;
const LOBBY_AWAY_REMOVE_MS = 2 * 60 * 1000; // away players are dropped from a lobby after this

// ─── In-Memory State ──────────────────────────────────────────────────────────
// Players are keyed by a stable player id (not socket id) so reconnecting
// only has to update player.socketId — votes, flags and host stay put.
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getRoom(code) {
  return Object.hasOwn(rooms, code) ? rooms[code] : null;
}

function generateCode() {
  let code;
  do {
    code = Array.from({ length: CODE_LENGTH },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
  } while (getRoom(code));
  return code;
}

function normCode(code) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function cleanName(name) {
  return typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, MAX_NAME_LENGTH) : "";
}

function intInRange(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Lowercase, strip accents, punctuation and spaces so "Spider-Man" and "spiderman" match
function normAnswer(str) {
  return (str || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// The part of an answer that has to start with the round letter — a leading
// "the" / "a" / "an" doesn't count (so "The Beatles" is a B answer)
function keyWord(answer) {
  return normAnswer((answer || "").trim().replace(/^(the|an|a)\s+/i, ""));
}

// Every form an answer could be the plural of, so "Watermelons" matches "watermelon"
// and "cherries" matches "cherry". Two answers are duplicates if these sets overlap.
function singularForms(word) {
  const forms = new Set([word]);
  const add = (w) => { if (w.length >= 3) forms.add(w); };
  if (word.endsWith("ies")) add(word.slice(0, -3) + "y");
  if (word.endsWith("es")) add(word.slice(0, -2));
  if (word.endsWith("s") && !word.endsWith("ss")) add(word.slice(0, -1));
  return forms;
}

function startsWithLetter(answer, letter) {
  return !!letter && keyWord(answer).startsWith(letter.toLowerCase());
}

function isDoublePoints(answer, letter) {
  if (!answer || !letter) return false;
  const word = keyWord(answer);
  const l = letter.toLowerCase();
  return word.length > 1 && word.startsWith(l) && word.endsWith(l);
}

function sanitizeAnswers(answers, count) {
  const clean = {};
  for (let i = 0; i < count; i++) {
    const a = answers[i];
    if (typeof a === "string" && a.trim()) clean[i] = a.trim().slice(0, MAX_ANSWER_LENGTH);
  }
  return clean;
}

// Players who haven't been gone for longer than the grace period
function presentPlayers(room) {
  return Object.values(room.players).filter(p => !p.away);
}

function emitToPlayer(player, event, data) {
  if (player.socketId) io.to(player.socketId).emit(event, data);
}

function getRoomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    letter: room.letter,
    categories: room.categories,
    timeLeft: room.timeLeft,
    settings: room.settings,
    currentRound: room.currentRound,
    totalRounds: room.settings.totalRounds,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,        // cumulative across all rounds
      roundScore: p.roundScore ?? 0,
      isHost: p.id === room.hostId,
      away: p.away
    }))
  };
}

// ─── Answer Validity ──────────────────────────────────────────────────────────
// An answer is out if it was auto-flagged when the round ended (empty, one
// letter, wrong letter, duplicate) or if a majority of present voters voted no on it.

function autoFlagAnswers(room) {
  room.autoFlags = {};
  room.categories.forEach((_, ci) => {
    const candidates = [];
    Object.values(room.players).forEach(player => {
      const key = `${ci}_${player.id}`;
      const answer = player.answers[ci];
      const word = keyWord(answer);
      if (!word) { room.autoFlags[key] = "empty"; return; }
      if (word.length < 2) { room.autoFlags[key] = "too short"; return; }
      if (!startsWithLetter(answer, room.letter)) { room.autoFlags[key] = "wrong letter"; return; }
      candidates.push({ key, forms: singularForms(word) });
    });
    // Pairwise so a match through any plural form counts (only ≤10 players)
    candidates.forEach((a, i) => candidates.slice(i + 1).forEach(b => {
      if ([...a.forms].some(f => b.forms.has(f))) room.autoFlags[a.key] = room.autoFlags[b.key] = "duplicate";
    }));
  });
}

function flagReason(room, ci, playerId) {
  const key = `${ci}_${playerId}`;
  if (room.autoFlags[key]) return room.autoFlags[key];
  const v = room.votes[key];
  if (!v) return null;
  // Majority of eligible voters (present players other than the answer's owner)
  // so that in a 2-player game, 1 no vote is enough to flag
  const eligibleVoters = presentPlayers(room).filter(p => p.id !== playerId).length;
  const majority = Math.floor(eligibleVoters / 2) + 1;
  return v.no.size >= majority ? "voted out" : null;
}

function getAnswersGridForPlayer(room, viewerId) {
  return room.categories.map((cat, ci) => {
    const entries = Object.values(room.players).map(player => {
      const key = `${ci}_${player.id}`;
      const reason = flagReason(room, ci, player.id);
      const voteData = room.votes[key] || { yes: new Set(), no: new Set() };
      return {
        playerId: player.id,
        playerName: player.name,
        answer: player.answers[ci] || "",
        flagged: !!reason,
        flagReason: reason,
        votable: !room.autoFlags[key],
        voteYes: voteData.yes.size,
        voteNo: voteData.no.size,
        myVoteYes: voteData.yes.has(viewerId),
        myVoteNo: voteData.no.has(viewerId)
      };
    });
    return { category: cat, categoryIndex: ci, entries };
  });
}

function broadcastGrid(room) {
  Object.values(room.players).forEach(p => emitToPlayer(p, "vote_update", getAnswersGridForPlayer(room, p.id)));
}

function getScoreboard(room) {
  return Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, score: p.score, roundScore: p.roundScore }))
    .sort((a, b) => b.score - a.score);
}

// Scores the round and records each player's per-answer breakdown
function calculateRoundScores(room) {
  Object.values(room.players).forEach(player => {
    player.roundSummary = room.categories.map((category, ci) => {
      const answer = player.answers[ci] || "";
      const reason = flagReason(room, ci, player.id);
      const valid = !reason;
      return { category, answer, valid, reason, double: valid && isDoublePoints(answer, room.letter) };
    });
    player.roundScore = player.roundSummary.reduce((sum, a) => sum + (a.valid ? (a.double ? 2 : 1) : 0), 0);
    player.score += player.roundScore;
  });
}

// ─── Round Lifecycle ──────────────────────────────────────────────────────────

function stopTimer(room) {
  if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
}

function startTimer(room) {
  stopTimer(room);
  room.timeLeft = room.settings.gameDuration;
  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit("timer_tick", { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) endRound(room);
  }, 1000);
}

function endRound(room) {
  if (room.phase !== "playing") return;
  stopTimer(room);
  room.phase = "review";
  autoFlagAnswers(room);
  // Bundle answersGrid into phase_change per player — one event, no race condition
  Object.values(room.players).forEach(p => {
    emitToPlayer(p, "phase_change", {
      phase: "review",
      currentRound: room.currentRound,
      totalRounds: room.settings.totalRounds,
      answersGrid: getAnswersGridForPlayer(room, p.id)
    });
  });
}

function pickLetter(room) {
  const fresh = LETTERS.filter(l => !room.usedLetters.has(l));
  const letter = shuffle(fresh.length ? fresh : LETTERS)[0];
  room.usedLetters.add(letter);
  return letter;
}

// Prefer categories not seen yet this game, topping up with repeats if the pool runs dry
function pickCategories(room) {
  const unused = CATEGORIES_POOL.filter(c => !room.usedCategories.has(c));
  const used   = CATEGORIES_POOL.filter(c =>  room.usedCategories.has(c));
  const picked = [...shuffle(unused), ...shuffle(used)].slice(0, room.settings.questionCount);
  picked.forEach(c => room.usedCategories.add(c));
  return picked;
}

function startNextRound(room) {
  room.currentRound++;
  room.phase = "playing";
  room.votes = {};
  room.autoFlags = {};
  room.letter = pickLetter(room);
  room.categories = pickCategories(room);
  Object.values(room.players).forEach(p => { p.answers = {}; p.roundScore = 0; p.roundSummary = []; });

  io.to(room.code).emit("game_started", {
    letter: room.letter,
    categories: room.categories,
    timeLeft: room.settings.gameDuration,
    currentRound: room.currentRound,
    totalRounds: room.settings.totalRounds
  });
  startTimer(room);
}

// ─── Room Membership ──────────────────────────────────────────────────────────

function deleteRoom(room) {
  stopTimer(room);
  clearTimeout(room.cleanupTimer);
  Object.values(room.players).forEach(clearPlayerTimers);
  delete rooms[room.code];
  console.log(`Room ${room.code} deleted`);
}

function clearPlayerTimers(player) {
  clearTimeout(player.awayTimer);
  clearTimeout(player.removeTimer);
  player.awayTimer = player.removeTimer = null;
}

function laterUnref(fn, ms) {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return t;
}

function attachSocket(socket, room, player) {
  clearPlayerTimers(player);
  const wasAway = player.away;
  player.socketId = socket.id;
  player.connected = true;
  player.away = false;
  socket.join(room.code);
  socket.data.gameCode = room.code;
  socket.data.playerId = player.id;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
  // If the host went away and nobody took over, the first player back becomes host
  const host = room.players[room.hostId];
  if (!host || host.away) room.hostId = player.id;
  if (wasAway) socket.to(room.code).emit("player_back", { playerName: player.name });
}

function currentPlayer(socket) {
  const room = getRoom(socket.data.gameCode);
  const player = room && room.players[socket.data.playerId];
  // A socket whose seat was taken over by a newer connection no longer speaks for the player
  if (!player || player.socketId !== socket.id) return {};
  return { room, player };
}

function removePlayer(room, player) {
  clearPlayerTimers(player);
  delete room.players[player.id];
}

// The player is really gone: hand over host, tell everyone, re-count votes
function markAway(room, player, reason) {
  if (getRoom(room.code) !== room || !Object.hasOwn(room.players, player.id)) return;
  clearPlayerTimers(player);
  if (room.phase === "lobby" && reason === "left") removePlayer(room, player);
  else {
    player.away = true;
    // A lobby seat isn't held forever — they may have closed the tab
    if (room.phase === "lobby") {
      player.removeTimer = laterUnref(() => {
        if (room.phase !== "lobby" || !player.away || getRoom(room.code) !== room) return;
        removePlayer(room, player);
        io.to(room.code).emit("room_update", getRoomState(room));
      }, LOBBY_AWAY_REMOVE_MS);
    }
  }
  if (!Object.keys(room.players).length) return deleteRoom(room);

  const nextHost = presentPlayers(room).find(p => p.connected);
  if (room.hostId === player.id && nextHost) {
    room.hostId = nextHost.id;
    emitToPlayer(nextHost, "you_are_host");
  }
  io.to(room.code).emit("room_update", getRoomState(room));
  io.to(room.code).emit("player_left", { playerName: player.name, reason });
  // Fewer voters can change what counts as a majority
  if (room.phase === "review") broadcastGrid(room);
}

// Called on disconnect (left = false) and when a socket leaves or switches games (left = true)
function detachSocket(socket, left = false) {
  const { room, player } = currentPlayer(socket);
  socket.data.gameCode = null;
  socket.data.playerId = null;
  if (!room) return;
  socket.leave(room.code);
  player.connected = false;
  player.socketId = null;

  if (left) markAway(room, player, "left");
  else player.awayTimer = laterUnref(() => markAway(room, player, "disconnected"), AWAY_GRACE_MS);

  if (getRoom(room.code) === room && !Object.values(room.players).some(p => p.connected)) {
    // Everyone's gone — give them a while to come back, then free the room
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = laterUnref(() => deleteRoom(room), ABANDONED_ROOM_TTL_MS);
  }
}

function rejoin(socket, room, player, ack) {
  if (player.socketId && player.socketId !== socket.id) {
    // Stale connection (e.g. before a page refresh) — hand the seat to the new one
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.leave(room.code);
      old.data.gameCode = null;
      old.data.playerId = null;
      old.emit("session_replaced");
    }
  }
  attachSocket(socket, room, player);

  // Build rejoin payload based on current phase
  const payload = {
    success: true, code: room.code, playerId: player.id, token: player.token,
    isHost: room.hostId === player.id, rejoined: true,
    phase: room.phase,
    roomState: getRoomState(room),
    currentRound: room.currentRound,
    totalRounds: room.settings.totalRounds
  };
  if (room.phase === "playing") {
    payload.letter     = room.letter;
    payload.categories = room.categories;
    payload.timeLeft   = room.timeLeft;
    payload.myAnswers  = player.answers;
  }
  if (room.phase === "review") {
    payload.answersGrid = getAnswersGridForPlayer(room, player.id);
  }
  if (room.phase === "scores" || room.phase === "between_rounds") {
    payload.scoreboard  = getScoreboard(room);
    payload.isLastRound = room.currentRound >= room.settings.totalRounds;
    payload.myAnswers   = player.roundSummary;
  }

  ack(payload);
  io.to(room.code).emit("room_update", getRoomState(room));
  if (room.phase === "review") broadcastGrid(room);
  console.log(`${player.name} rejoined room ${room.code} (phase: ${room.phase})`);
}

function newPlayer(name) {
  return {
    id: uuidv4(), token: uuidv4(), name,
    socketId: null, connected: false,
    away: false, awayTimer: null, removeTimer: null,
    score: 0, roundScore: 0, answers: {}, roundSummary: []
  };
}

// ─── Socket Logic ─────────────────────────────────────────────────────────────

// Wraps a socket handler so a missing/malformed payload or ack callback can't throw
function handler(fn) {
  return (data, cb) => {
    const ack = typeof cb === "function" ? cb : () => {};
    try {
      fn(data && typeof data === "object" ? data : {}, ack);
    } catch (err) {
      console.error("Handler error:", err);
      ack({ success: false, error: "Something went wrong." });
    }
  };
}

// A socket already seated in a game has to leave it first (the Leave button)
// rather than being silently pulled out of it — e.g. clicking Create Game
// while the page is still quietly rejoining the game from last time
function alreadySeated(socket, exceptPlayerId = null) {
  const { room, player } = currentPlayer(socket);
  if (!room || player.id === exceptPlayerId) return null;
  return { success: false, error: `You're already in game ${room.code}. Leave it first.`, code: room.code };
}

// For events only the host may send in a given phase
function hostAction(socket, phase) {
  const { room, player } = currentPlayer(socket);
  if (!room || room.hostId !== player.id || room.phase !== phase) return null;
  return room;
}

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Create game ──
  socket.on("create_game", handler(({ playerName, gameDuration, questionCount, totalRounds }, ack) => {
    const name = cleanName(playerName);
    if (!name) return ack({ success: false, error: "Enter your name." });
    const seated = alreadySeated(socket);
    if (seated) return ack(seated);

    const code = generateCode();
    const settings = {
      gameDuration:  intInRange(gameDuration,  30, 600, DEFAULT_DURATION),
      questionCount: intInRange(questionCount, 1,  25,  DEFAULT_QUESTIONS),
      totalRounds:   intInRange(totalRounds,   1,  10,  DEFAULT_ROUNDS),
    };
    const player = newPlayer(name);
    const room = rooms[code] = {
      code, hostId: player.id,
      players: { [player.id]: player },
      phase: "lobby",
      letter: null, categories: [],
      timerInterval: null, cleanupTimer: null, timeLeft: settings.gameDuration,
      settings,
      currentRound: 0,
      usedLetters: new Set(), usedCategories: new Set(),
      votes: {}, autoFlags: {},
      recorder: null
    };
    attachSocket(socket, room, player);
    ack({ success: true, code, playerId: player.id, token: player.token, isHost: true, roomState: getRoomState(room) });
    console.log(`Room ${code} created by ${name} (${settings.totalRounds} rounds)`);
  }));

  // ── Join game (handles both new joins and rejoins) ──
  socket.on("join_game", handler(({ playerName, code, token }, ack) => {
    const room = getRoom(normCode(code));
    if (!room) return ack({ success: false, error: "Game not found. Check your code." });
    const name = cleanName(playerName);
    const players = Object.values(room.players);

    // Rejoin with the token handed out on first join (reconnect / page refresh)
    let player = typeof token === "string" && players.find(p => p.token === token);
    if (!player) {
      if (!name) return ack({ success: false, error: "Enter your name." });
      const sameName = players.find(p => p.name.toLowerCase() === name.toLowerCase());
      // Without the token, a seat can only be claimed by name once its owner has been away
      // past the grace period — e.g. rejoining from another device
      // (a repeat join from the socket that already holds the seat is just a rejoin)
      if (sameName && !sameName.away && sameName.socketId !== socket.id) {
        return ack({ success: false, error: "That name is already taken in this game. If it's you, try again in a minute." });
      }
      player = sameName;
    }
    const seated = alreadySeated(socket, player?.id);
    if (seated) return ack(seated);
    if (player) return rejoin(socket, room, player, ack);

    // ── New join: only allowed in lobby ──
    if (room.phase !== "lobby") return ack({ success: false, error: "Game already in progress." });
    if (players.length >= MAX_PLAYERS) return ack({ success: false, error: "Room is full." });

    player = newPlayer(name);
    room.players[player.id] = player;
    attachSocket(socket, room, player);
    ack({
      success: true, code: room.code, playerId: player.id, token: player.token,
      isHost: false, rejoined: false, phase: "lobby", roomState: getRoomState(room)
    });
    io.to(room.code).emit("room_update", getRoomState(room));
    console.log(`${name} joined room ${room.code}`);
  }));

  // ── Leave game ──
  socket.on("leave_game", handler((_, ack) => {
    detachSocket(socket, true);
    ack({ success: true });
  }));

  // ── Start game (host only) ──
  socket.on("start_game", handler((_, ack) => {
    const room = hostAction(socket, "lobby");
    if (!room) return ack({ success: false });
    // Reset cumulative scores and the no-repeat pools at game start
    Object.values(room.players).forEach(p => { p.score = 0; p.roundScore = 0; });
    room.currentRound = 0;
    room.usedLetters = new Set();
    room.usedCategories = new Set();
    room.recorder = createGameRecorder(); // one DB game per start, however many rounds
    startNextRound(room);
    ack({ success: true });
  }));

  // ── Autosave answers ──
  socket.on("save_answers", handler(({ answers }, ack) => {
    const { room, player } = currentPlayer(socket);
    if (!room || room.phase !== "playing" || !answers || typeof answers !== "object") return ack({ success: false });
    player.answers = sanitizeAnswers(answers, room.categories.length);
    ack({ success: true });
  }));

  // ── Vote on an answer ──
  socket.on("vote", handler(({ categoryIndex, targetPlayerId, voteType }, ack) => {
    const { room, player } = currentPlayer(socket);
    if (!room || room.phase !== "review") return ack({ success: false });
    if (!Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= room.categories.length
      || typeof targetPlayerId !== "string" || !Object.hasOwn(room.players, targetPlayerId)
      || !["yes", "no", "clear"].includes(voteType)) {
      return ack({ success: false, error: "Invalid vote." });
    }
    // Can't vote on your own answer
    if (targetPlayerId === player.id) return ack({ success: false, error: "Can't vote on your own answer." });

    const key = `${categoryIndex}_${targetPlayerId}`;
    // Empty, wrong-letter and duplicate answers are out regardless of votes
    if (room.autoFlags[key]) return ack({ success: false, error: "That answer is already ruled out." });

    if (!room.votes[key]) room.votes[key] = { yes: new Set(), no: new Set() };
    const v = room.votes[key];
    v.yes.delete(player.id); v.no.delete(player.id);
    if (voteType === "yes") v.yes.add(player.id);
    if (voteType === "no")  v.no.add(player.id);

    broadcastGrid(room);
    ack({ success: true });
  }));

  // ── Reset votes on an answer so it gets a fresh vote (host only) ──
  socket.on("reset_votes", handler(({ categoryIndex, targetPlayerId }, ack) => {
    const room = hostAction(socket, "review");
    if (!room) return ack({ success: false });
    if (typeof targetPlayerId !== "string" || !Object.hasOwn(room.players, targetPlayerId)) return ack({ success: false });
    // No overruling the table on your own answer
    if (targetPlayerId === room.hostId) return ack({ success: false, error: "Can't reset votes on your own answer." });
    delete room.votes[`${categoryIndex}_${targetPlayerId}`];
    broadcastGrid(room);
    ack({ success: true });
  }));

  // ── Finalise round scores (host only) ──
  socket.on("finalise_scores", handler((_, ack) => {
    const room = hostAction(socket, "review");
    if (!room) return ack({ success: false });

    calculateRoundScores(room);
    const isLastRound = room.currentRound >= room.settings.totalRounds;
    room.phase = isLastRound ? "scores" : "between_rounds";
    const scoreboard = getScoreboard(room);

    // Send each player their summary + phase change in one event so there's no race
    Object.values(room.players).forEach(player => {
      emitToPlayer(player, "phase_change", {
        phase: room.phase,
        scoreboard,
        currentRound: room.currentRound,
        totalRounds: room.settings.totalRounds,
        isLastRound,
        myAnswers: player.roundSummary,
        skipLoading: process.env.NODE_ENV === "test"  // tests skip the 2s loading delay
      });
    });

    ack({ success: true });

    // Save to Supabase asynchronously — snapshot now so a quick next round can't change what gets saved
    room.recorder.saveRound({
      code: room.code,
      settings: { ...room.settings },
      roundNumber: room.currentRound,
      isLastRound,
      letter: room.letter,
      categories: [...room.categories],
      players: Object.values(room.players).map(p => ({ name: p.name, score: p.score, answers: p.roundSummary }))
    });
  }));

  // ── Next round (host only) ──
  socket.on("next_round", handler((_, ack) => {
    const room = hostAction(socket, "between_rounds");
    if (!room) return ack({ success: false });
    startNextRound(room);
    ack({ success: true });
  }));

  // ── Force end round — TEST ONLY, only active in test environment ──
  if (process.env.NODE_ENV === "test") {
    socket.on("force_end_round", handler((_, ack) => {
      const { room } = currentPlayer(socket);
      if (!room || room.phase !== "playing") return ack({ success: false });
      endRound(room);
      ack({ success: true });
    }));
  }

  // ── Play again — full reset (host only) ──
  socket.on("play_again", handler((_, ack) => {
    const room = hostAction(socket, "scores");
    if (!room) return ack({ success: false });

    room.phase = "lobby";
    room.letter = null;
    room.votes = {}; room.autoFlags = {};
    room.currentRound = 0;
    room.timeLeft = room.settings.gameDuration;
    // Players who never came back don't carry over into the new lobby
    Object.values(room.players).forEach(p => {
      if (p.away) removePlayer(room, p);
      else { p.answers = {}; p.score = 0; p.roundScore = 0; p.roundSummary = []; }
    });

    io.to(room.code).emit("room_update", getRoomState(room));
    io.to(room.code).emit("phase_change", { phase: "lobby" });
    ack({ success: true });
  }));

  // ── Disconnect ──
  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
    detachSocket(socket);
  });
});

// ─── Global error handlers — prevent silent crashes ──────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err.message, err.stack);
});

// ─── Start ────────────────────────────────────────────────────────────────────
// Only auto-start when run directly, not when required by tests
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`🎲 Scattergories running on port ${PORT}`));
}

module.exports = { server, rooms };
