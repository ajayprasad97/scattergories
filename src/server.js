require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { saveGameSession } = require("./db");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// ─── Game Data ───────────────────────────────────────────────────────────────

const CATEGORIES_POOL = [
  // People & Names
  "A boy's name",
  "A girl's name",
  "A famous person's last name",
  "A US president's last name",
  "A celebrity first name",
  "A fictional character",
  "A superhero",
  "A Disney character",
  "A cartoon character",
  "A video game character",

  // Places
  "A city",
  "A country",
  "A US state",
  "A capital city",
  "A tourist destination",
  "Something you find at the beach",
  "Something you find in a forest",
  "Something you find in a city",
  "A landmark or monument",
  "A type of store or shop",

  // Animals & Nature
  "An animal",
  "A farm animal",
  "A wild animal",
  "A sea creature",
  "A bird",
  "An insect",
  "A type of dog breed",
  "A flower",
  "A tree",
  "A fruit",
  "A vegetable",
  "Something in the sky",
  "A natural disaster",

  // Food & Drink
  "A food or drink",
  "A breakfast food",
  "A snack food",
  "A dessert",
  "A type of cuisine",
  "Something you put on a sandwich",
  "A fast food item",
  "A pizza topping",
  "A type of candy",
  "Something you drink",
  "A cocktail or mocktail",

  // Entertainment & Media
  "A movie title",
  "A TV show",
  "A Netflix series",
  "A type of movie genre",
  "A song title",
  "A band or music artist",
  "A video game",
  "A board game",
  "A podcast",
  "A book title",
  "A children's book",
  "A magazine",

  // Sports & Activities
  "A sport",
  "A hobby",
  "An Olympic sport",
  "Something you do at a gym",
  "A card game",
  "An outdoor activity",
  "A dance style",
  "A martial art",
  "A water sport",
  "A team sport",

  // Everyday Life & Objects
  "Something in a kitchen",
  "Something in a bedroom",
  "Something in a bathroom",
  "Something in a school",
  "Something in an office",
  "A type of clothing",
  "A piece of jewellery",
  "A household appliance",
  "Something you carry in a bag",
  "A tool",
  "A type of vehicle",
  "Something with wheels",
  "A mode of transport",
  "Something electronic",
  "A type of furniture",

  // Science & Knowledge
  "A musical instrument",
  "A school subject",
  "A science term",
  "A planet or space object",
  "A type of weather",
  "A body part",
  "A job or profession",
  "Something in a hospital",
  "A type of doctor or specialist",
  "A language",
  "A unit of measurement",

  // Fun & Miscellaneous
  "Something that makes you happy",
  "Something that is yellow",
  "Something that is cold",
  "Something that is loud",
  "Something you find at a party",
  "Something you do on a weekend",
  "Something you give as a gift",
  "Something that comes in pairs",
  "Something with a smell",
  "Something in a museum",
  "Something scary",
  "Something you collect",
  "A reason to celebrate",
  "Something that needs batteries",
  "A holiday or festival",
  "A type of hat",
  "A type of bag",
  "A type of shoe",
  "Something in a garden",
  "A phrase or expression",
];

const CATEGORIES_PER_ROUND = 15;

const LETTERS = "ABCDEFGHIJKLMNOPRSTW".split("");

const GAME_DURATION = 120; // seconds

// ─── In-Memory State ─────────────────────────────────────────────────────────

// rooms = {
//   [gameCode]: {
//     code, hostId, players: { [socketId]: { name, score, answers: {} } },
//     phase: "lobby" | "playing" | "review" | "scores",
//     letter, categories, timerInterval, timeLeft,
//     votes: { [categoryIndex_playerSocketId]: { yes: Set, no: Set } },
//     flagged: { [categoryIndex_playerSocketId]: boolean }
//   }
// }
const rooms = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      isHost: id === room.hostId
    }))
  };
}

function getAnswersGrid(room) {
  // Build a grid: for each category, each player's answer + flag status + vote counts
  const grid = room.categories.map((cat, ci) => {
    const entries = Object.entries(room.players).map(([sid, player]) => {
      const answer = player.answers[ci] || "";
      const key = `${ci}_${sid}`;
      const flagged = room.flagged[key] || false;
      const voteData = room.votes[key] || { yes: new Set(), no: new Set() };
      return {
        playerId: sid,
        playerName: player.name,
        answer,
        flagged,
        voteYes: voteData.yes.size,
        voteNo: voteData.no.size,
        myVoteYes: null, // filled client-side
        myVoteNo: null
      };
    });
    return { category: cat, categoryIndex: ci, entries };
  });
  return grid;
}

function getAnswersGridForPlayer(room, requestingSocketId) {
  const grid = room.categories.map((cat, ci) => {
    const entries = Object.entries(room.players).map(([sid, player]) => {
      const answer = player.answers[ci] || "";
      const key = `${ci}_${sid}`;
      const flagged = room.flagged[key] || false;
      const voteData = room.votes[key] || { yes: new Set(), no: new Set() };
      return {
        playerId: sid,
        playerName: player.name,
        answer,
        flagged,
        voteYes: voteData.yes.size,
        voteNo: voteData.no.size,
        myVoteYes: voteData.yes.has(requestingSocketId),
        myVoteNo: voteData.no.has(requestingSocketId)
      };
    });
    return { category: cat, categoryIndex: ci, entries };
  });
  return grid;
}

function detectDuplicates(room) {
  room.categories.forEach((_, ci) => {
    // Group by normalised answer
    const groups = {};
    Object.entries(room.players).forEach(([sid, player]) => {
      const norm = normAnswer(player.answers[ci]);
      if (!norm) {
        // Empty answers are auto-flagged
        room.flagged[`${ci}_${sid}`] = true;
        return;
      }
      if (!groups[norm]) groups[norm] = [];
      groups[norm].push(sid);
    });
    Object.values(groups).forEach(sids => {
      if (sids.length > 1) {
        sids.forEach(sid => {
          room.flagged[`${ci}_${sid}`] = true;
        });
      }
    });
  });
}

function calculateScores(room) {
  Object.entries(room.players).forEach(([sid, player]) => {
    let score = 0;
    room.categories.forEach((_, ci) => {
      const key = `${ci}_${sid}`;
      if (!room.flagged[key]) {
        score += 1;
      }
    });
    player.score = score;
  });
}

function startTimer(room) {
  room.timeLeft = room.settings ? room.settings.gameDuration : GAME_DURATION;
  room.timerInterval = setInterval(() => {
    room.timeLeft -= 1;
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
  io.to(room.code).emit("phase_change", { phase: "review" });
  // Send grid to each player (personalised vote state)
  Object.keys(room.players).forEach(sid => {
    io.to(sid).emit("answers_grid", getAnswersGridForPlayer(room, sid));
  });
}

// ─── Socket Logic ─────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Create game ──
  socket.on("create_game", ({ playerName, gameDuration, questionCount }, cb) => {
    const code = generateCode();
    const settings = {
      gameDuration: gameDuration && gameDuration >= 30 && gameDuration <= 600 ? gameDuration : GAME_DURATION,
      questionCount: questionCount && questionCount >= 1 && questionCount <= 25 ? questionCount : CATEGORIES_PER_ROUND
    };
    rooms[code] = {
      code,
      hostId: socket.id,
      players: {
        [socket.id]: { name: playerName, score: 0, answers: {} }
      },
      phase: "lobby",
      letter: null,
      categories: [],
      timerInterval: null,
      timeLeft: settings.gameDuration,
      settings,
      votes: {},
      flagged: {}
    };
    socket.join(code);
    socket.data.gameCode = code;
    cb({ success: true, code, isHost: true, roomState: getRoomState(rooms[code]) });
    console.log(`Room created: ${code} by ${playerName}`);
  });

  // ── Join game ──
  socket.on("join_game", ({ playerName, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ success: false, error: "Game not found. Check your code." });
    if (room.phase !== "lobby") return cb({ success: false, error: "Game already in progress." });
    if (Object.keys(room.players).length >= 10) return cb({ success: false, error: "Room is full." });

    room.players[socket.id] = { name: playerName, score: 0, answers: {} };
    socket.join(code);
    socket.data.gameCode = code;

    cb({ success: true, code, isHost: false, roomState: getRoomState(room) });
    // Notify everyone else
    io.to(code).emit("room_update", getRoomState(room));
    console.log(`${playerName} joined room ${code}`);
  });

  // ── Start game (host only) ──
  socket.on("start_game", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });

    room.letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
    room.phase = "playing";
    room.votes = {};
    room.flagged = {};
    // Pick a fresh random set of categories each round
    const count = room.settings ? room.settings.questionCount : CATEGORIES_PER_ROUND;
    const shuffled = [...CATEGORIES_POOL].sort(() => Math.random() - 0.5);
    room.categories = shuffled.slice(0, count);
    Object.values(room.players).forEach(p => { p.answers = {}; });

    io.to(code).emit("game_started", {
      letter: room.letter,
      categories: room.categories,
      timeLeft: room.timeLeft
    });
    startTimer(room);
    cb && cb({ success: true });
  });

  // ── Save answers (autosave every few seconds + final submit) ──
  socket.on("save_answers", ({ answers }, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || room.phase !== "playing") return cb && cb({ success: false });

    const player = room.players[socket.id];
    if (player) {
      player.answers = answers; // { [categoryIndex]: answerString }
    }
    cb && cb({ success: true });
  });

  // ── Vote on an answer ──
  socket.on("vote", ({ categoryIndex, targetPlayerId, voteType }, cb) => {
    // voteType: "yes" | "no" | "clear"
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || room.phase !== "review") return cb && cb({ success: false });

    const key = `${categoryIndex}_${targetPlayerId}`;
    if (!room.votes[key]) room.votes[key] = { yes: new Set(), no: new Set() };

    const v = room.votes[key];
    // Remove any existing vote from this socket first
    v.yes.delete(socket.id);
    v.no.delete(socket.id);

    if (voteType === "yes") v.yes.add(socket.id);
    if (voteType === "no") v.no.add(socket.id);

    const totalPlayers = Object.keys(room.players).length;
    const majority = Math.floor(totalPlayers / 2) + 1;

    // Auto-resolve if majority reached
    if (v.no.size >= majority) {
      room.flagged[key] = true;
    } else if (v.yes.size >= majority) {
      room.flagged[key] = false;
    }

    // Broadcast updated grid to all players
    Object.keys(room.players).forEach(sid => {
      io.to(sid).emit("answers_grid", getAnswersGridForPlayer(room, sid));
    });

    cb && cb({ success: true });
  });

  // ── Finalise scores (host only) ──
  socket.on("finalise_scores", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });

    calculateScores(room);
    room.phase = "scores";

    const scoreboard = Object.entries(room.players)
      .map(([id, p]) => ({ id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    io.to(code).emit("phase_change", { phase: "scores", scoreboard });
    cb && cb({ success: true });

    // Save to Supabase asynchronously — doesn't block the game
    saveGameSession(room);
  });

  // ── Play again (host only) ──
  socket.on("play_again", (_, cb) => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room || socket.id !== room.hostId) return cb && cb({ success: false });

    room.phase = "lobby";
    room.letter = null;
    room.votes = {};
    room.flagged = {};
    room.timeLeft = room.settings ? room.settings.gameDuration : GAME_DURATION;
    Object.values(room.players).forEach(p => { p.answers = {}; p.score = 0; });

    io.to(code).emit("room_update", getRoomState(room));
    io.to(code).emit("phase_change", { phase: "lobby" });
    cb && cb({ success: true });
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const code = socket.data.gameCode;
    const room = rooms[code];
    if (!room) return;

    const playerName = room.players[socket.id]?.name;
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      // Clean up empty room
      if (room.timerInterval) clearInterval(room.timerInterval);
      delete rooms[code];
      console.log(`Room ${code} deleted (empty)`);
    } else {
      // If host left, assign new host
      if (room.hostId === socket.id) {
        room.hostId = Object.keys(room.players)[0];
        io.to(room.hostId).emit("you_are_host");
      }
      io.to(code).emit("room_update", getRoomState(room));
      io.to(code).emit("player_left", { playerName });
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎲 Scattergories server running on port ${PORT}`);
});
