# 🎲 Scattergories

A real-time multiplayer Scattergories-style game. Players join with a name and game code, race a 2-minute timer to fill in 15 categories starting with a random letter, then review and vote on answers together.

---

## How It Works

1. **Host** creates a game → shares the code with friends
2. **Players** join at your domain using name + game code
3. Host clicks **Start Game** → everyone sees the same letter and 15 categories
4. 2-minute countdown — players type one answer per category
5. Timer ends → answers revealed, duplicates auto-flagged red
6. **Review round** — any player can vote ✓/✗ to challenge answers (majority rules)
7. Host clicks **Finalise Scores** → leaderboard shown
8. Play as many rounds as you want

---

## Project Structure

```
scattergories/
├── public/
│   └── index.html        # Full frontend (single file)
├── src/
│   └── server.js         # Node.js + Express + Socket.io backend
├── package.json
├── render.yaml           # Render.com deployment config
└── .gitignore
```

---

## Local Development

### Prerequisites
- Node.js 18+
- npm

### Steps

```bash
# 1. Clone your repo
git clone https://github.com/YOUR_USERNAME/scattergories.git
cd scattergories

# 2. Install dependencies
npm install

# 3. Run in dev mode (auto-restarts on changes)
npm run dev

# 4. Open in browser
# http://localhost:3000
```

---

## Deploying to Render.com (Free)

Render auto-deploys from GitHub on every push. Zero config needed.

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/scattergories.git
git push -u origin main
```

### Step 2 — Create a Render Web Service

1. Go to [render.com](https://render.com) and sign up (free)
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Render detects `render.yaml` automatically — just click **Deploy**

Your app will be live at `https://scattergories.onrender.com` (or similar).

> **Note:** Free Render instances spin down after 15 mins of inactivity and take ~30s to wake up. For a party game this is fine — just open the URL before guests arrive.

---

## Connecting Your Own Domain

### On Render
1. In your Render service → **Settings → Custom Domains**
2. Add your domain (e.g. `scattergories.yourdomain.com`)
3. Render gives you a CNAME value

### On Your DNS Provider (Namecheap, GoDaddy, Cloudflare, etc.)
1. Go to DNS settings for your domain
2. Add a **CNAME record**:
   - **Host/Name:** `scattergories` (or `@` for root domain)
   - **Value:** the CNAME Render gave you
   - **TTL:** Auto
3. Wait 5–30 minutes for DNS to propagate

---

## Customising the Categories

Edit the `CATEGORIES` array in `src/server.js` (line ~14):

```js
const CATEGORIES = [
  "A boy's name",
  "A girl's name",
  "A city",
  // ... add or change anything here
];
```

Up to 20 categories work well. The frontend adapts automatically.

---

## Customising the Letter Pool

Edit the `LETTERS` string in `src/server.js`:

```js
const LETTERS = "ABCDEFGHIJKLMNOPRSTW".split("");
```

Q, X, Y, Z are excluded by default (hard to play with). Add or remove as you like.

---

## Changing the Timer

In `src/server.js`:

```js
const GAME_DURATION = 120; // seconds — change to 90, 180, etc.
```

---

## Scoring Rules

- **1 point** per valid unique answer
- **0 points** for duplicates (same answer as another player, case-insensitive)
- **0 points** for empty answers
- Answers can be challenged during review — majority vote determines validity
- Scores accumulate across rounds if you play multiple games in the same session

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS (single file) |
| Backend | Node.js + Express |
| Real-time | Socket.io (WebSockets) |
| State | In-memory (no database needed) |
| Hosting | Render.com (free tier) |

No database required — all game state lives in server memory per session.

---

## Troubleshooting

**Players can't connect / see each other**
- Make sure you're all using the same URL (not `localhost` vs domain)
- Check the game code is correct (case-insensitive)

**Server crashes or restarts reset the game**
- Free Render instances can sleep — open the URL a minute before playing
- All in-progress games are lost on restart (by design for simplicity)

**Votes aren't resolving**
- Majority is `floor(n/2) + 1` — with 3 players, 2 votes needed to resolve

**Want to add persistence / multiple rounds history?**
- Add Upstash Redis (free tier) — DM for instructions
