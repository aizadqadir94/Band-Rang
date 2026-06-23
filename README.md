# Band Rang — online multiplayer for 4 friends

Real online Band Rang: hidden-trump Court Piece with bidding, room codes, and four human players.
The Node server owns the game rules and sends each player only their own hand.

## What is included

```text
server.js
package.json
package-lock.json
README.md
public/
  index.html
```

## Rules built in

- Four players, two teams: seats 1 & 3 vs seats 2 & 4.
- Everyone receives 5 cards first.
- Bidding goes from 7 to 13. Every bid must beat the current high bid.
- Highest bidder chooses one specific card from their first 5 cards as the hidden trump card.
- After trump is locked, everyone receives the remaining 8 cards.
- The hidden trump card stays locked in the bidder's hand until trump is revealed.
- Trump reveals only when a defender cannot follow suit and must cut.
- On the final (13th) trick, if trump was never revealed, it is revealed automatically so the locked trump card can be played and the hand never stalls.
- Special rule: when the winning bid is exactly **9**, none of the remaining 8 cards dealt to the bidding team will be of the chosen trump suit — every leftover trump goes to the two opponents.
- If the **trump setter** cannot follow suit before trump is revealed, their vaddrang/waste card is played face down and cannot win the trick. The setter's partner plays face up.
- After trump is revealed, the **same player** must win two live-trump tricks in a row to scoop/pick the full pile. The picked tricks are added to that player's team score.
- Hand score counts picked/captured pile tricks, not raw trick winners. Before trump is revealed, no team can pick from the pile.
- The hand ends immediately when the bidding team has picked enough tricks to make the bid, or when defenders have picked enough tricks to make the bid impossible. For example, bid 9 ends when the bidder team picks 9 or defenders pick 5.
- Net scoring: bidding team gets `+bid` if they make it, or `-2 × bid` if they fail.
- Match ends when the net margin reaches 52.

## Visual features

- A dramatic flip animation reveals the actual trump card (rank and suit) when trump goes live.
- The table shows the current round, tricks currently in the pile, your team's picked tricks, opponents' picked tricks, and the bid target.
- The winning card of each trick is briefly highlighted.
- A gold "SCOOP! +N" burst appears at the winner's seat when a pile is scooped.
- "Match point": when the net margin is within 8 of 52, the table border pulses red with a badge.
- Before each new hand, a player on the losing (net-negative) team shuffles for 5 seconds, showing the message "Please rukiye. Taha k waalid pii kar rahay hain, shukriya".
- At the end of every hand, an image overlay appears and the two players on the **losing** team must each tap their "TKMKBSDA" button 13 times — their buttons run away on each tap (kept inside the frame). Everyone watches; "Deal next hand" stays locked until both finish.

## Deploy on Render

1. Create a GitHub repository, for example `bandrang`.
2. Upload these files exactly as shown above. `index.html` must be inside the `public` folder (it is a single self-contained file — no separate `app.js`).
3. Go to Render → **New** → **Web Service**.
4. Connect your GitHub repository.
5. Use these settings:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free is fine |

Render gives you a URL like:

```text
https://bandrang-xxxx.onrender.com
```

Send that URL to your friends.

## Play

1. One player opens the link and taps **Create a room**.
2. Share the 4-character room code.
3. The other three players open the same link, enter their names and the code, then tap **Join**.
4. When all 4 seats are filled, anyone can tap **Start the game**.

## Free Render tier note

The app sends WebSocket heartbeats while a player has the game open, and `/healthz` is available for uptime checks. On Render Free, the service can still spin down if there is no inbound traffic for a while or if every browser tab is closed/backgrounded. Use a paid always-on instance or an external uptime monitor if the game must stay available without any open player browser.

## Local test, optional

```bash
npm install
npm start
```

Then open four browser tabs at:

```text
http://localhost:3000
```
