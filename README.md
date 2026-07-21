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
  app.js
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

## Visual features

- A dramatic flip animation reveals the actual trump card (rank and suit) when trump goes live.
- The winning card of each trick is briefly highlighted.
- At the end of every hand, an image overlay appears and the two players on the **losing** team must each tap their "TKMKBSDA" button 13 times — and their buttons run away on each tap. Everyone in the room watches the losers struggle, and "Deal next hand" stays locked until both have finished.

## Deploy on Render

1. Create a GitHub repository, for example `bandrang`.
2. Upload these files exactly as shown above. Both `index.html` and `app.js` must be inside the `public` folder.
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


## Latest package notes

This build includes the polished board UI, flashing near-52 warning, top-right reset with confirmation, greyed, visible locked hidden-trump card for the trump setter, bot seats, solo play with three bots, normal dealing for every bid, fixed back-to-back Ace rule, and enforced 13-card deals.

For Render/GitHub, keep this structure:

```text
server.js
package.json
package-lock.json
README.md
public/
  index.html
  app.js
```


## Latest package notes
- Premium board UI cleanup for mobile.
- TKMKBSDA local tap counter resets each hand; button movement is constrained inside its slot.
- Gameplay rules are unchanged from the bot/rules package.


## Current update

- Removed the special bid 10 dealing rule. A bid of 10 now uses the normal remaining-card deal.
- Removed the special bid 8 restriction; every bid now uses the normal deal.
- In phone portrait mode, a 13-card hand is displayed in two compact rows so every card is readable.
- The trump setter sees the selected hidden-trump card greyed out and disabled; its rank and suit remain visible only to that player.


## Bot testing

- Select **Quick test · Play with 3 bots** on the opening screen to start immediately with three computer players.
- In a normal room, use **Add bot** or **Fill with bots** to occupy empty seats.
- Bots bid, choose trump, play legal cards, and continue through handover rounds automatically.

## Portrait hand layout

On phone portrait screens, the player hand stays in two balanced rows for the entire hand, including when eight or fewer cards remain. The second row keeps its space until the final card so the layout does not collapse back into overlapping cards.

## Final hidden-trump safeguard

If the selected hidden trump is still unrevealed on the final trick, the server now reveals and unlocks it automatically when it becomes the trump setter's only remaining card. This prevents the hand from getting stuck with no legal card.

## Smart partnership bots

Bots now use a fair, public-information partnership strategy instead of simply playing high cards. Defenders coordinate around short suits to expose trump; the bidding team rotates safer suits and sheds weak cards to delay exposure. Bots avoid overtaking a winning partner, preserve controls, block opponent scoops, choose the cheapest winning card, and select a low card as the locked hidden trump so high trump controls remain playable.
