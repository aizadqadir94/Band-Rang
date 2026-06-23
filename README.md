# Band Rang — online multiplayer

Online 4-player Band Rang with hidden trump, bidding, pile pickup scoring, WebSockets, reconnect support, and mobile UI.

## Files

```text
server.js
package.json
package-lock.json
README.md
public/
  index.html
```

## Current rule logic

- Four players, two teams: seats 1 & 3 vs seats 2 & 4.
- Everyone receives 5 cards first.
- Bidding goes from 7 to 13. One bidding round only.
- Highest bidder chooses one exact card from the first 5 as hidden trump.
- After trump is selected, everyone receives the remaining 8 cards.
- The hidden trump card is locked in the trump setter's hand until trump is revealed.
- Trump reveals when a defender cannot follow suit and must cut.
- If trump is still hidden at the final trick, it auto-reveals so the locked trump can be played.
- Special deal rule applies only to bid 8: in the remaining 8-card deal, the trump setter and partner receive no K or A; the partner receives no additional trump cards; the trump setter can still receive additional trump cards if they are Q or lower.
- Before trump reveal, no team can pick score. Tricks only build the pile.
- Before trump reveal, only the trump setter's vaddrang/waste card is face down. The setter's partner plays waste face up.
- After trump reveal, the same individual player must win two live tricks in a row to pick the full pile.
- Picked pile points go to that player's team.
- Hand ends when the bidding team picks the bid amount, or defenders pick enough to make the bid impossible.
- Net scoring: bidding team gets `+bid` if made, or `-2 × bid` if failed.
- Top-right match score shows only positive net margin from the viewer's perspective.
- Match ends when net margin reaches 52.

## Deploy on Render

1. Upload the files to GitHub with `index.html` inside `public/`.
2. Render settings:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |

## Local test

```bash
npm install
npm start
```

Open four browser tabs at:

```text
http://localhost:3000
```
