# Scattergories

A real-time multiplayer Scattergories-style game. No accounts, no installs — share a code and play.

---

## How to Play

1. One player creates a game and shares the code
2. Everyone joins with their name + code
3. Each round you get a random letter and a list of categories
4. Type answers that start with that letter before the timer runs out — answers autosave, no submit button
5. After the timer, vote on each other's answers — empty, one-letter, wrong-letter and duplicate answers are auto-flagged
6. Scores accumulate across rounds, highest total wins

You can only be in one game at a time — press **Leave** (bottom bar) before creating or joining another.

Dropped connection, switched apps on your phone or refreshed the page? You're put straight back into your seat. Other players are only told you've gone if you're away for more than 30 seconds. You can also rejoin from another device by entering the same name and code once that 30 seconds has passed.

**Double points** — if your answer starts *and* ends with the round letter (e.g. letter A → *Anaconda*) you score 2 points instead of 1.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Backend | Node.js + Express + Socket.io |
| Database | Supabase (Postgres) |
| Hosting | Render.com |

All free tier.

---

## Structure

```
scattergories/
├── .github/
│   └── workflows/
│       └── test.yml        ← CI runs on every push
├── public/
│   └── index.html          ← entire frontend
├── src/
│   ├── server.js           ← game logic + socket events
│   └── db.js               ← Supabase helper (saves each finalised round)
├── supabase/
│   └── schema.sql          ← creates/upgrades DB tables (safe to re-run)
├── tests/
│   ├── game.test.js        ← integration tests (socket clients)
│   ├── db.test.js          ← database saving (fake Supabase client)
│   └── ui.test.js          ← snapshot tests (rendering functions)
├── .env.example
├── package.json
├── render.yaml
└── README.md
```

---

## Local Development

**Prerequisites:** Node.js 18+

```bash
git clone https://github.com/ajayprasad97/scattergories.git
cd scattergories
npm install
cp .env.example .env   # fill in your Supabase credentials
npm run dev
```

Open `http://localhost:3000`.

---

## Environment Variables

```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

Set these in `.env` locally and in Render → Environment in production.

To get them: create a free project at [supabase.com](https://supabase.com), then run `supabase/schema.sql` in the SQL editor.

**Upgrading an existing database:** re-run `supabase/schema.sql` *before* deploying a new version. It only adds what's missing and keeps existing rows. If the tables are out of date, saves fail and get logged, but games keep working.

### What gets saved

| Table | One row per |
|---|---|
| `game_sessions` | game (`ended_at` is set when the last round is finalised; empty = abandoned) |
| `game_players` | player in a game (`final_score` is the running total, updated every round) |
| `game_rounds` | finalised round (`round_number`, `letter`, `categories`) |
| `game_answers` | player × category × round (`valid`, `points`, `invalid_reason`) |

Rows saved before this layout have `letter`/`categories` on `game_sessions`, one session per round, and no `game_rounds` rows.

---

## Running Tests

```bash
npm test
```

70 tests across three suites. Runs in a few seconds. No real timers, no network calls — Supabase is mocked.

```bash
npm test -- --updateSnapshot   # regenerate UI snapshots after frontend changes
npm test -- tests/ui.test.js   # run just the UI tests
npm test -- tests/game.test.js # run just the integration tests
```

CI runs automatically on every push to `main` via GitHub Actions.

---

## Deployment (Render)

The repo includes a `render.yaml`. To deploy:

1. Push to GitHub
2. Create a new Web Service on [render.com](https://render.com) and connect the repo
3. Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in Render → Environment
4. Render auto-deploys on every push to `main`

**Note:** Free tier spins down after 15 minutes of inactivity — expect a ~30 second cold start.

---

## Game Settings

| Setting | Range | Default |
|---|---|---|
| Timer | 30s - 10min | 2min |
| Categories per round | 1 - 25 | 15 |
| Rounds | 1 - 10 | 3 |

---

## Scoring Rules

- **1 point** — unique valid answer starting with the round letter
- **2 points** — answer starts *and* ends with the round letter
- **0 points** — empty, a single letter, doesn't start with the round letter, duplicate (same as another player's), or voted out by majority
- Scores accumulate across all rounds

A leading "The", "A" or "An" is skipped when checking the letter, so *The Beatles* is a B answer. Duplicates are matched ignoring case, spaces, punctuation, accents and plurals (*Watermelons* = *watermelon* = *water melon*, *cherries* = *cherry*).

Voting: majority of eligible voters (connected players other than the answer's owner) needed to flag an answer. In a 2-player game, 1 no vote is enough. Votes can be changed until the host finalises, and the host can hit **↺ Revote** on a voted-out answer (other than their own) to clear its votes and let everyone vote again. Letters and categories don't repeat within a game.