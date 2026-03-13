require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { saveGameSession } = require("./db");

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

// ─── In-Memory State ──────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function normAnswer(str) {
  return (str || "").trim().toLowerCase();
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
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,        // cumulative across all rounds
      roundScore: p.roundScore ?? 0,
      isHost: id === room.hostId
    }))
  };
}

function getAnswersGridForPlayer(room, requestingSocketId) {
  return room.categories.map((cat, ci) => {
    const entries = Object.entries(room.players).map(([sid, player]) => {
      const answer = player.answers[ci] || "";
      const key = `${ci}_${sid}`;
      const flagged = room.flagged[key] || false;
      const voteData = room.votes[key] || { yes: new Set(), no: new Set() };
      return {
        playerId: sid,
        playerName: player.name,
        answer, flagged,
        voteYes: voteData.yes.size,
        voteNo: voteData.no.size,
        myVoteYes: voteData.yes.has(requestingSocketId),
        myVoteNo: voteData.no.has(requestingSocketId)
      };
    });
    return { category: cat, categoryIndex: ci, entries };
  });
}

function detectDuplicates(room) {
  room.categories.forEach((_, ci) => {
    const groups = {};
    Object.entries(room.players).forEach(([sid, player]) => {
      const norm = normAnswer(player.answers[ci]);
      if (!norm) { room.flagged[`${ci}_${sid}`] = true; return; }
      if (!groups[norm]) groups[norm] = [];
      groups[norm].push(sid);
    });
    Object.values(groups).forEach(sids => {
      if (sids.length > 1) sids.forEach(sid => { room.flagged[`${ci}_${sid}`] = true; });
    });
  });
}

function calculateRoundScores(room) {
  Object.entries(room.players).forEach(([sid, player]) => {
    let roundScore = 0;
    room.categories.forEach((_, ci) => {
      if (!room.flagged[`${ci}_${sid}`]) roundScore++;
    });
    player.roundScore = roundScore;
    player.score += roundScore; // accumulate
  });
}

function startTimer(room) {
  room.timeLeft = room.settings.gameDuration;
  room.timerInterval = setInterval(() => {
    room.timeLeft--;
    io.to(room.code).emit("timer_tick", { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      endRound(room);
    }
  }, 1000);
}

function endRound(room) {
  room.phase = "review";
  detectDuplicates(room);
  // Bundle answersGrid into phase_change per player — one event, no race condition
  Object.keys(room.players).forEach(sid => {
    io.to(sid).emit("phase_change", {
      phase: "review",
      currentRound: room.currentRound,
      totalRounds: room.settings.totalRounds,
      answersGrid: getAnswersGridForPlayer(room, sid)
    });
  });
}

function startNextRound(room) {
  room.currentRound++;
  room.phase = "playing";
  room.votes = {};
  room.flagged = {};
  room.letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  const shuffled = [...CATEGORIES_POOL].sort(() => Math.random() - 0.5);
  room.categories = shuffled.slice(0, room.settings.questionCount);
  Object.values(room.players).forEach(p => { p.answers = {}; p.roundScore = 0; });

  io.to(room.code).emit("game_started", {
    letter: room.letter,
    categories: room.categories,
    timeLeft: room.settings.gameDuration,
    currentRound: room.currentRound,
    totalRounds: room.settings.totalRounds
  });
  startTimer(room);
}

// ─── Socket Logic ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Create game ──
  socket.on("create_game", ({ playerName, gameDuration, questionCount, totalRounds }, cb) => {
    const code = generateCode();
    const settings = {
      gameDuration:  (gameDuration  >= 30  && gameDuration  <= 600) ? gameDuration  : DEFAULT_DURATION,
      questionCount: (questionCount >= 1   && questionCount <= 25)  ? questionCount : DEFAULT_QUESTIONS,
      totalRounds:   (totalRounds   >= 1   && totalRounds   <= 10)  ? totalRounds   : DEFAULT_ROUNDS,
    };
    rooms[code] = {
      code, hostId: socket.id,
      players: { [socket.id]: { name: playerName, score: 0, roundScore: 0, answers: {} } },
      phase: "lobby",
      letter: null, categories: [],
      timerInterval: null, timeLeft: settings.gameDuration,
      settings,
      currentRound: 0,
      votes: {}, flagged: {}
    };
    socket.join(code);
    socket.data.gameCode = code;
    cb({ success: true, code, isHost: true, roomState: getRoomState(rooms[code]) });
    console.log(`Room ${code} created by ${playerName} (${settings.totalRounds} rounds)`);
  });

  // ── Join game (handles both new joins and rejoins) ──
  socket.on("join_game", ({ playerName, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ success: false, error: "Game not found. Check your code." });

    const normName = (playerName || "").trim().toLowerCase();

    // ── Rejoin: find existing player with same name ──
    const existingSocketId = Object.keys(room.players).find(sid =>
      room.players[sid].name.trim().toLowerCase() === normName
    );

    if (existingSocketId && existingSocketId !== socket.id) {
      const player = room.players[existingSocketId];

      // Swap socket ID in players map
      room.players[socket.id] = player;
      delete room.players[existingSocketId];

      // Swap host if needed
      if (room.hostId === existingSocketId) room.hostId = socket.id;

      // Swap socket ID in all vote sets
      Object.values(room.votes).forEach(v => {
        if (v.yes.has(existingSocketId)) { v.yes.delete(existingSocketId); v.yes.add(socket.id); }
        if (v.no.has(existingSocketId))  { v.no.delete(existingSocketId);  v.no.add(socket.id); }
      });

      // Swap socket ID in flagged keys
      const updatedFlagged = {};
      Object.entries(room.flagged).forEach(([key, val]) => {
        updatedFlagged[key.replace(existingSocketId, socket.id)] = val;
      });
      room.flagged = updatedFlagged;

      socket.join(code);
      socket.data.gameCode = code;
      const isHost = room.hostId === socket.id;

      // Build rejoin payload based on current phase
      const rejoinPayload = {
        success: true, code, isHost, rejoined: true,
        phase: room.phase,
        roomState: getRoomState(room)
      };

      if (room.phase === "playing") {
        rejoinPayload.letter     = room.letter;
        rejoinPayload.categories = room.categories;
        rejoinPayload.timeLeft   = room.timeLeft;
        rejoinPayload.currentRound = room.currentRound;
        rejoinPayload.totalRounds  = room.settings.totalRounds;
        rejoinPayload.myAnswers    = player.answers;
      }
      if (room.phase === "review") {
        rejoinPayload.answersGrid = getAnswersGridForPlayer(room, socket.id);
        rejoinPayload.currentRound = room.currentRound;
        rejoinPayload.totalRounds  = room.settings.totalRounds;
      }
      if (room.phase === "scores" || room.phase === "between_rounds") {
        const scoreboard = Object.entries(room.players)
          .map(([id, p]) => ({ id, name: p.name, score: p.score, roundScore: p.roundScore }))
          .sort((a, b) => b.score - a.score);
        rejoinPayload.scoreboard   = scoreboard;
        rejoinPayload.currentRound = room.currentRound;
        rejoinPayload.totalRounds  = room.settings.totalRounds;
        rejoinPayload.isLastRound  = room.currentRound >= room.settings.totalRounds;
      }

      cb(rejoinPayload);
      io.to(code).emit("room_update", getRoomState(room));
      console.log(`${playerName} rejoined room ${code} (phase: ${room.phase})`);
      return;
    }

    // ── New join: only allowed in lobby ──
    if (room.phase !== "lobby") return cb({ success: false, error: "Game already in progress." });
    if (Object.keys(room.players).length >= 10) return cb({ success: false, error: "Room is full." });

    room.players[socket.id] = { name: playerName, score: 0, roundScore: 0, answers: {} };
    socket.join(code);
    socket.data.gameCode = code;
    cb({ success: true, code, isHost: false, rejoined: false, phase: "lobby", roomState: getRoomState(room) });
    io.to(code).emit("room_update", getRoomState(room));
    console.log(`${playerName} joined room ${code}`);
  });

  // ── Start game (host only) ──
  socket.on("start_game", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });
    // Reset cumulative scores at game start
    Object.values(room.players).forEach(p => { p.score = 0; p.roundScore = 0; });
    startNextRound(room);
    cb && cb({ success: true });
  });

  // ── Autosave answers ──
  socket.on("save_answers", ({ answers }, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || room.phase !== "playing") return cb && cb({ success: false });
    const player = room.players[socket.id];
    if (player) player.answers = answers;
    cb && cb({ success: true });
  });

  // ── Vote on an answer ──
  socket.on("vote", ({ categoryIndex, targetPlayerId, voteType }, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || room.phase !== "review") return cb && cb({ success: false });
    // Can't vote on your own answer
    if (targetPlayerId === socket.id) return cb && cb({ success: false, error: "Can't vote on your own answer." });

    const key = `${categoryIndex}_${targetPlayerId}`;
    if (!room.votes[key]) room.votes[key] = { yes: new Set(), no: new Set() };
    const v = room.votes[key];
    v.yes.delete(socket.id); v.no.delete(socket.id);
    if (voteType === "yes") v.yes.add(socket.id);
    if (voteType === "no")  v.no.add(socket.id);

    const majority = Math.floor(Object.keys(room.players).length / 2) + 1;
    if (v.no.size >= majority)  room.flagged[key] = true;
    if (v.yes.size >= majority) room.flagged[key] = false;

    Object.keys(room.players).forEach(sid => {
      io.to(sid).emit("vote_update", getAnswersGridForPlayer(room, sid));
    });
    cb && cb({ success: true });
  });

  // ── Finalise round scores (host only) ──
  socket.on("finalise_scores", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });

    calculateRoundScores(room);
    const isLastRound = room.currentRound >= room.settings.totalRounds;
    room.phase = isLastRound ? "scores" : "between_rounds";

    const scoreboard = Object.entries(room.players)
      .map(([id, p]) => ({ id, name: p.name, score: p.score, roundScore: p.roundScore }))
      .sort((a, b) => b.score - a.score);

    // Send each player their summary + phase change in one event so there's no race
    Object.entries(room.players).forEach(([sid, player]) => {
      const myAnswers = room.categories.map((category, ci) => {
        const key = `${ci}_${sid}`;
        return {
          category,
          answer: player.answers[ci] || "",
          valid: !room.flagged[key] && !!(player.answers[ci] || "").trim()
        };
      });
      io.to(sid).emit("phase_change", {
        phase: isLastRound ? "scores" : "between_rounds",
        scoreboard,
        currentRound: room.currentRound,
        totalRounds: room.settings.totalRounds,
        isLastRound,
        myAnswers,
        skipLoading: process.env.NODE_ENV === "test"  // tests skip the 2s loading delay
      });
    });

    cb && cb({ success: true });

    // Save to Supabase asynchronously — doesn't block anything
    saveGameSession(room);
  });

  // ── Next round (host only) ──
  socket.on("next_round", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });
    startNextRound(room);
    cb && cb({ success: true });
  });

  // ── Force end round — TEST ONLY, only active in test environment ──
  if (process.env.NODE_ENV === "test") {
    socket.on("force_end_round", (_, cb) => {
      const code = socket.data.gameCode;
      const room = rooms[code];
      if (!room) return cb && cb({ success: false });
      if (room.timerInterval) { clearInterval(room.timerInterval); room.timerInterval = null; }
      endRound(room);
      cb && cb({ success: true });
    });
  }

    // ── Play again — full reset (host only) ──
  socket.on("play_again", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });

    room.phase = "lobby";
    room.letter = null;
    room.votes = {}; room.flagged = {};
    room.currentRound = 0;
    room.timeLeft = room.settings.gameDuration;
    Object.values(room.players).forEach(p => { p.answers = {}; p.score = 0; p.roundScore = 0; });

    io.to(code).emit("room_update", getRoomState(room));
    io.to(code).emit("phase_change", { phase: "lobby" });
    cb && cb({ success: true });
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room) return;
    const player = room.players[socket.id];
    const playerName = player?.name;

    if (room.phase === "lobby") {
      // In lobby: remove immediately, they haven't played yet
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        if (room.timerInterval) clearInterval(room.timerInterval);
        delete rooms[code];
        console.log(`Room ${code} deleted (empty)`);
        return;
      }
    } else {
      // In-game: mark as disconnected but keep in room so they can rejoin
      if (player) player.disconnected = true;
    }

    if (room.hostId === socket.id) {
      const nextHostId =
        Object.keys(room.players).find(id => !room.players[id].disconnected)
        || Object.keys(room.players)[0];
      if (nextHostId) {
        room.hostId = nextHostId;
        io.to(nextHostId).emit("you_are_host");
      }
    }
    io.to(code).emit("room_update", getRoomState(room));
    io.to(code).emit("player_left", { playerName });
    console.log(`Socket disconnected: ${socket.id} (${playerName}, phase: ${room.phase})`);
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