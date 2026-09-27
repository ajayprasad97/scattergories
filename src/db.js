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

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ─── Record a game, one round at a time ───────────────────────────────────────
// One recorder per game (created when the host starts it). The first finalised
// round creates the game_sessions row; every round then adds a game_rounds row,
// its answers, and updates each player's running total.
//
// round = a snapshot taken at finalise time:
//   { code, settings, roundNumber, isLastRound, letter, categories,
//     players: [{ name, score, answers: [{ category, answer, valid, reason, double }] }] }
function createGameRecorder() {
  let sessionId = null;
  const playerIds = {};           // player name → game_players.id
  let queue = Promise.resolve();  // rounds are saved strictly in order

  async function ensureSession(client, round) {
    if (sessionId) return;
    const session = await run(client
      .from("game_sessions")
      .insert({
        game_code:      round.code,
        duration_sec:   round.settings?.gameDuration ?? 120,
        question_count: round.settings?.questionCount ?? 15,
        total_rounds:   round.settings?.totalRounds ?? null
      })
      .select("id")
      .single());
    sessionId = session.id;
  }

  async function savePlayers(client, round) {
    // Existing players get their running total updated; new ones are inserted
    // (the server keeps names unique within a game)
    const rows = round.players.map(p => ({
      ...(playerIds[p.name] ? { id: playerIds[p.name] } : {}),
      session_id:  sessionId,
      player_name: p.name,
      final_score: p.score ?? 0
    }));
    const fresh = rows.filter(r => !r.id);
    const known = rows.filter(r => r.id);
    if (fresh.length) {
      const inserted = await run(client.from("game_players").insert(fresh).select("id, player_name"));
      inserted.forEach(p => { playerIds[p.player_name] = p.id; });
    }
    if (known.length) await run(client.from("game_players").upsert(known));
  }

  async function saveRound(round) {
    const client = getClient();
    if (!client) return null;
    try {
      await ensureSession(client, round);
      await savePlayers(client, round);

      const { id: roundId } = await run(client
        .from("game_rounds")
        .insert({
          session_id:   sessionId,
          round_number: round.roundNumber,
          letter:       round.letter,
          categories:   round.categories
        })
        .select("id")
        .single());

      const answerRows = [];
      round.players.forEach(player => {
        const dbPlayerId = playerIds[player.name];
        if (!dbPlayerId) return;
        player.answers.forEach(({ category, answer, valid, reason, double }) => {
          answerRows.push({
            session_id:     sessionId,
            player_id:      dbPlayerId,
            round_id:       roundId,
            round_number:   round.roundNumber,
            category,
            answer:         (answer || "").trim(),
            valid,
            points:         valid ? (double ? 2 : 1) : 0,
            invalid_reason: reason || null
          });
        });
      });
      if (answerRows.length) await run(client.from("game_answers").insert(answerRows));

      if (round.isLastRound) {
        await run(client.from("game_sessions").update({ ended_at: new Date().toISOString() }).eq("id", sessionId));
      }

      console.log(`✅ Game ${round.code} round ${round.roundNumber} saved to Supabase (session ${sessionId})`);
      return roundId;
    } catch (err) {
      // Never crash the game if DB save fails — just log it
      console.error(`❌ Supabase save failed (game ${round.code}, round ${round.roundNumber}):`, err.message);
      return null;
    }
  }

  return {
    // Queued behind any earlier round so a slow save can't be overtaken
    saveRound(round) {
      queue = queue.then(() => saveRound(round));
      return queue;
    }
  };
}

module.exports = { createGameRecorder };
