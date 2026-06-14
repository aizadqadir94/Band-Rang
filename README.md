# Band Rang — online multiplayer for 4 friends

Real online Band Rang (hidden-trump Court Piece with bidding). One small server,
room codes, everyone plays from their own phone. The server owns all the rules and
sends each player only their own cards — so the hidden trump stays genuinely hidden.

**Rules built in:** bid 7–13 (highest bidder picks & hides the trump, choosing from
only their first 5 cards), tricks pile in the middle with no trump in play, the trump
reveals only when a **defender** (opposing the bidder) is void and must cut, a team
scoops the pile by winning two tricks in a row *after* the reveal, the bidding team
must reach its bid to win the hand, and a hand ends early the moment the bid becomes
mathematically impossible.

---

## You only set this up ONCE. Your friends just open a link.

Everything below can be done **from your phone's browser** — no computer, no
command line, no installing anything.

### Step 1 — Get a GitHub account & upload these files
1. Go to **github.com** and sign up (free).
2. Tap **+** (top right) → **New repository**. Name it `bandrang`, leave it Public, tap **Create repository**.
3. On the new repo page, tap **uploading an existing file** (or **Add file → Upload files**).
4. Upload `server.js`, `package.json`, and `README.md`.
5. You also need the `public` folder with `index.html` inside it. On mobile the simplest way:
   tap **Add file → Create new file**, and in the name box type `public/index.html`
   (the `public/` part creates the folder). Paste the contents of `index.html` there, then **Commit**.
6. Make sure your repo shows: `server.js`, `package.json`, and `public/index.html`.

### Step 2 — Deploy on Render (free)
1. Go to **render.com** and sign up — tap **Sign in with GitHub** (easiest).
2. Tap **New** → **Web Service**.
3. Connect your GitHub and pick the `bandrang` repository.
4. Fill in:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Tap **Create Web Service**. Render builds and starts it (takes a minute or two).
6. You'll get a public URL like `https://bandrang-xxxx.onrender.com`.

### Step 3 — Play
- Send that URL to your three friends (WhatsApp, etc.).
- Everyone opens it. One person taps **Create a room** and reads out the 4-letter code.
- The other three tap **Join**, type the code.
- When all four seats are filled, anyone taps **Start the game**.

That URL is permanent — bookmark it and reuse it every game night. Setup never repeats.

---

## How a game flows on screen
1. Everyone is dealt 5 cards. Bidding goes around — tap a number (min 7) or **Pass**.
   Each bid must beat the last; highest bidder wins.
2. The winner taps a suit to set the **hidden trump** — they see only their first 5 cards
   while choosing. The rest of the cards are dealt once the trump is locked.
3. Play begins. Tap a card to play it (playable cards glow gold). Tricks pile in the middle.
4. When a defender can't follow suit, the trump flips up and they must cut — the table flashes.
5. After the reveal, win two tricks in a row to scoop the pile. Bidding team needs its bid.
6. Hand ends (or ends early if the bid is dead). Tap **Deal next hand** to continue.

---

## Good to know about the free tier
- **Sleeps after ~15 min idle.** The first person to open the link after a quiet spell waits
  ~30–50 seconds for the server to wake. After that it's instant. Render's cheapest paid tier removes this.
- **Dropped phone keeps its seat.** If a connection drops mid-game, refreshing the page in the same
  browser rejoins automatically. An empty room is cleaned up about a minute after everyone leaves.
- **Strictly 4 humans** — no bots online (by design). All four seats must be filled by people to start.

---

## Want to test on your own computer first (optional)
If you do have a laptop: install Node.js 18+, then in this folder run `npm install` and `npm start`,
and open four browser tabs at `http://localhost:3000`. Not required — Render works the same way.
