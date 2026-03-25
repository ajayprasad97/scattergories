# Scattergories

A real-time multiplayer Scattergories-style game. No accounts, no installs — share a code and play.

---

## How to Play

1. One player creates a game and shares the code
2. Everyone joins with their name + code
3. Each round you get a random letter and a list of categories
4. Type answers that start with that letter before the timer runs out — answers autosave, no submit button
5. After the timer, vote on each other's answers — duplicates are auto-flagged
6. Scores accumulate across rounds, highest total wins

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
│   └── db.js               ← Supabase helper
├── supabase/
│   └── schema.sql          ← run once to set up DB tables
├── tests/
│   ├── game.test.js        ← integration tests (socket clients)
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

---

## Running Tests

```bash
npm test
```

29 tests across two suites. Runs in ~9 seconds. No real timers, no network calls — Supabase is mocked.

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
- **0 points** — duplicate answer (same as another player's), empty answer, or voted out by majority
- Scores accumulate across all rounds

Voting: majority of eligible voters (everyone except the answer's owner) needed to flag an answer. In a 2-player game, 1 no vote is enough.