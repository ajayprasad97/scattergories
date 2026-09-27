const { createClient } = require("@supabase/supabase-js");

// ─── Init ─────────────────────────────────────────────────────────────────────
// These are loaded from environment variables — never hardcode them.
// The client is created on first use so the server still boots without them.
let supabase = null;
let warnedMissingEnv = false;

function getClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    if (!warnedMissingEnv) console.warn("⚠️  Supabase env vars not set — skipping DB saves.");
    warnedMissingEnv = true;
    return null;
  }
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

// ─── Save a finished round to the database ────────────────────────────────────
// Called when host clicks "Finalise Scores".
// game = a snapshot taken at finalise time:
//   { code, letter, settings, categories,
//     players: [{ name, score, answers: [{ category, answer, valid }] }] }
// Returns the session ID (UUID) or null on failure.
async function saveGameSession(game) {
  const client = getClient();
  if (!client) return null;

  try {
    // 1. Insert the session row
    const { data: session, error: sessionErr } = await client
      .from("game_sessions")
      .insert({
        game_code:      game.code,
        letter:         game.letter,
        duration_sec:   game.settings?.gameDuration ?? 120,
        question_count: game.settings?.questionCount ?? 15,
        categories:     game.categories,
        ended_at:       new Date().toISOString()
      })
      .select("id")
      .single();

    if (sessionErr) throw sessionErr;
    const sessionId = session.id;

    // 2. Insert a player row for each participant
    const playerRows = game.players.map(p => ({
      session_id:  sessionId,
      player_name: p.name,
      final_score: p.score ?? 0
    }));

    const { data: players, error: playersErr } = await client
      .from("game_players")
      .insert(playerRows)
      .select("id, player_name");

    if (playersErr) throw playersErr;

    // Build a map from player_name → DB player id
    // (the server keeps names unique within a game)
    const nameToDbId = {};
    players.forEach(p => { nameToDbId[p.player_name] = p.id; });

    // 3. Insert an answer row for every player × category combination
    const answerRows = [];
    game.players.forEach(player => {
      const dbPlayerId = nameToDbId[player.name];
      if (!dbPlayerId) return;
      player.answers.forEach(({ category, answer, valid }) => {
        answerRows.push({
          session_id: sessionId,
          player_id:  dbPlayerId,
          category,
          answer: (answer || "").trim(),
          valid
        });
      });
    });

    const { error: answersErr } = await client
      .from("game_answers")
      .insert(answerRows);

    if (answersErr) throw answersErr;

    console.log(`✅ Game ${game.code} saved to Supabase (session ${sessionId})`);
    return sessionId;

  } catch (err) {
    // Never crash the game if DB save fails — just log it
    console.error("❌ Supabase save failed:", err.message);
    return null;
  }
}

module.exports = { saveGameSession };
