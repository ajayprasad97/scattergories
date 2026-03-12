const { createClient } = require("@supabase/supabase-js");

// ─── Init ─────────────────────────────────────────────────────────────────────
// These are loaded from environment variables — never hardcode them.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Save a completed game to the database ────────────────────────────────────
// Called when host clicks "Finalise Scores".
// room = the full in-memory room object.
// Returns the session ID (UUID) or null on failure.
async function saveGameSession(room) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn("⚠️  Supabase env vars not set — skipping DB save.");
    return null;
  }

  try {
    // 1. Insert the session row
    const { data: session, error: sessionErr } = await supabase
      .from("game_sessions")
      .insert({
        game_code:      room.code,
        letter:         room.letter,
        duration_sec:   room.settings?.gameDuration ?? 120,
        question_count: room.settings?.questionCount ?? 15,
        categories:     room.categories,
        ended_at:       new Date().toISOString()
      })
      .select("id")
      .single();

    if (sessionErr) throw sessionErr;
    const sessionId = session.id;

    // 2. Insert a player row for each participant
    const playerRows = Object.entries(room.players).map(([, p]) => ({
      session_id:  sessionId,
      player_name: p.name,
      final_score: p.score ?? 0
    }));

    const { data: players, error: playersErr } = await supabase
      .from("game_players")
      .insert(playerRows)
      .select("id, player_name");

    if (playersErr) throw playersErr;

    // Build a map from player_name → DB player id
    // (names are unique enough within a single game session)
    const nameToDbId = {};
    players.forEach(p => { nameToDbId[p.player_name] = p.id; });

    // 3. Insert an answer row for every player × category combination
    const answerRows = [];
    Object.entries(room.players).forEach(([socketId, player]) => {
      const dbPlayerId = nameToDbId[player.name];
      if (!dbPlayerId) return;

      room.categories.forEach((category, ci) => {
        const key     = `${ci}_${socketId}`;
        const answer  = (player.answers[ci] || "").trim();
        const valid   = !room.flagged[key];

        answerRows.push({
          session_id: sessionId,
          player_id:  dbPlayerId,
          category,
          answer,
          valid
        });
      });
    });

    const { error: answersErr } = await supabase
      .from("game_answers")
      .insert(answerRows);

    if (answersErr) throw answersErr;

    console.log(`✅ Game ${room.code} saved to Supabase (session ${sessionId})`);
    return sessionId;

  } catch (err) {
    // Never crash the game if DB save fails — just log it
    console.error("❌ Supabase save failed:", err.message);
    return null;
  }
}

module.exports = { saveGameSession };
