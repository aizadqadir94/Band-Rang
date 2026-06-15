# Band Rang — online multiplayer for 4 friends

Real online Band Rang: hidden-trump Court Piece with bidding, room codes, and four human players.
The Node server owns the game rules and sends each player only their own hand.

## What is included

```text
server.js
package.json
package-lock.json
render.yaml
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
- If the bidding team cannot follow suit before trump is revealed, their card is played face down and cannot win the trick.
- After trump is revealed, winning two live-trump tricks in a row scoops the full pile.
- The hand can end early once the bid is mathematically impossible.
- Net scoring: bidding team gets `+bid` if they make it, or `-2 × bid` if they fail.
- Match ends when the net margin reaches 52.

## Deploy on Render

1. Create a GitHub repository, for example `bandrang`.
2. Upload these files exactly as shown above. `index.html` must be inside the `public` folder.
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

The free Render tier may sleep after inactivity. The first load after a quiet period can take around a minute while the server wakes. After that, the game runs normally.

## Local test, optional

```bash
npm install
npm start
```

Then open four browser tabs at:

```text
http://localhost:3000
```
