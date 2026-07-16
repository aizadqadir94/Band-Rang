// ============================================================================
//  Band Rang — authoritative multiplayer server
//  Serves the client and runs ALL game logic. Clients never decide rules and
//  each player is only ever sent their own hand (so the hidden trump stays hidden).
// ============================================================================
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------- static files
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const publicRoot = path.join(__dirname, "public");
  const filePath = path.join(publicRoot, urlPath);
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------------------------------------------------------------- card model
const SUITS = ["S", "H", "D", "C"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VALUE = RANKS.reduce((m, r, i) => ((m[r] = i + 2), m), {});
const TEAM_OF = (seat) => seat % 2;          // seats 0&2 = team 0, seats 1&3 = team 1
const MIN_BID = 7;

function buildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: r + s });
  return d;
}
function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function sortHand(hand) {
  const order = { S: 0, H: 1, C: 2, D: 3 };
  return [...hand].sort((a, b) =>
    a.suit !== b.suit ? order[a.suit] - order[b.suit] : RANK_VALUE[b.rank] - RANK_VALUE[a.rank]
  );
}
function legalMovesBase(hand, trick) {
  if (trick.length === 0) return hand;
  const lead = trick[0].card.suit;
  const inSuit = hand.filter((c) => c.suit === lead);
  return inSuit.length ? inSuit : hand;
}
function bestPlayInTrick(trick, trump, trumpActive) {
  // Face-down cards can never win the trick.
  const eligible = trick.filter((p) => !p.faceDown);
  if (eligible.length === 0) return trick[0];
  let best = eligible[0];
  for (const play of eligible) {
    const c = play.card, bc = best.card;
    if (trumpActive) {
      const cT = c.suit === trump, bT = bc.suit === trump;
      if (cT && !bT) best = play;
      else if (cT === bT && c.suit === bc.suit && cardRankValue(play) > cardRankValue(best)) best = play;
    } else {
      if (c.suit === bc.suit && cardRankValue(play) > cardRankValue(best)) best = play;
    }
  }
  return best;
}
function trickWinner(trick, trump, trumpActive) {
  return bestPlayInTrick(trick, trump, trumpActive).seat;
}

// ---------------------------------------------------------------- rooms
const rooms = new Map();
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function newRoom(code) {
  return {
    code,
    seats: [null, null, null, null],   // each player: { id, name, ws, connected }
    spectators: [],                    // watchers: { id, name, ws, connected }
    phase: "lobby",                    // lobby | bidding | pickTrump | playing | handover
    dealer: 0,
    hands: [[], [], [], []],
    pending: null,                     // { deck, idx, order } for the deferred 8-card deal
    // bidding: one round only, each player acts once
    bids: [null, null, null, null],    // number | "pass" | null
    highBid: null,                     // { seat, amount }
    bidTurn: 0,
    bidCount: 0,
    firstBidder: 0,
    // play
    trump: null,                       // suit only
    trumpCard: null,                   // exact hidden card; public only after reveal
    trumpCardId: null,
    trumpActive: false,
    trumpHolder: null,
    turn: 0,
    trick: [],
    lastTrick: null,
    pile: 0,
    lastWinnerSeat: null,
    liveTrickResolved: false,
    aceWonLastTrick: [false, false, false, false],
    tricksWon: [0, 0],
    scores: [0, 0],                    // net score: +bid if made, -2×bid if failed
    khoti: null,
    loserTeam: null,                   // team that lost the latest hand and must complete TKMKBSDA
    skipsDone: [false, false, false, false], // per-seat TKMKBSDA completion gate
    message: "Waiting for players\u2026",
    botSeq: 0,
    botTimer: null,
  };
}
function seatedCount(room) { return room.seats.filter((s) => s && s.connected).length; }
function spectatorCount(room) { return room.spectators.filter((s) => s && s.connected).length; }
function humanSeatCount(room) { return room.seats.filter((s) => s && !s.bot && s.connected).length; }
function connectedCount(room) { return humanSeatCount(room) + spectatorCount(room); }
function isBotSeat(room, seat) { const p = room?.seats?.[seat]; return !!(p && p.bot); }
function teamName(team) { return team === 0 ? "Team 1" : "Team 2"; }
function nextSeatOnTeam(fromSeat, team) {
  for (let step = 1; step <= 4; step++) {
    const s = (fromSeat + step) % 4;
    if (TEAM_OF(s) === team) return s;
  }
  return (fromSeat + 1) % 4;
}
function firstBidderFor(room) {
  const margin = room.scores[0] - room.scores[1];
  if (margin > 0) return nextSeatOnTeam(room.dealer, 0);
  if (margin < 0) return nextSeatOnTeam(room.dealer, 1);
  return (room.dealer + 1) % 4;
}
function cardRankValue(play) {
  if (!play || !play.card) return 0;
  return play.zeroAce ? 0 : RANK_VALUE[play.card.rank];
}

function publicPlay(play) {
  if (!play) return play;
  if (play.faceDown) return { seat: play.seat, faceDown: true, card: null };
  return play;
}
function publicLastTrick(lastTrick) {
  if (!lastTrick) return null;
  return { winner: lastTrick.winner, trick: lastTrick.trick.map(publicPlay) };
}

function legalMoveIds(room, seat) {
  if (room.phase !== "playing" || room.turn !== seat) return [];
  let hand = room.hands[seat];

  // The exact hidden trump card is locked in the bidder's hand until trump is revealed.
  if (!room.trumpActive && room.trumpCardId && seat === room.trumpHolder) {
    hand = hand.filter((c) => c.id !== room.trumpCardId);
  }

  const lead = room.trick.length ? room.trick[0].card.suit : null;
  if (!lead) return hand.map((c) => c.id);

  const inSuit = hand.filter((c) => c.suit === lead);
  if (inSuit.length) return inSuit.map((c) => c.id);

  // Defenders must cut with trump while trump is hidden if they are void and hold trump.
  const isDefender = room.trumpHolder != null && TEAM_OF(seat) !== TEAM_OF(room.trumpHolder);
  if (!room.trumpActive && room.trump && isDefender) {
    const myTrumps = hand.filter((c) => c.suit === room.trump);
    if (myTrumps.length) return myTrumps.map((c) => c.id);
  }

  // Bidding team void before reveal may play anything except the locked hidden trump card.
  return hand.map((c) => c.id);
}

// View sent to ONE player/spectator: public state + only that player's own hand.
function stateFor(room, seat, isSpectator = false) {
  const bidFloor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
  return {
    type: "state",
    you: isSpectator ? null : seat,
    isSpectator,
    code: room.code,
    phase: room.phase,
    players: room.seats.map((s) => (s ? { name: s.name, connected: s.connected, bot: !!s.bot } : null)),
    spectators: room.spectators.map((s) => ({ name: s.name, connected: s.connected })),
    handCounts: room.hands.map((h) => h.length),
    hand: !isSpectator && seat != null && seat >= 0 ? room.hands[seat] : [],
    dealer: room.dealer,
    // bidding
    bids: room.bids,
    highBid: room.highBid,
    bidTurn: room.bidTurn,
    bidFloor,
    bidCount: room.bidCount,
    canBidNow: !isSpectator && room.phase === "bidding" && room.bidTurn === seat && room.bids[seat] == null,
    // trump: exact card is revealed publicly only after trump becomes active.
    trump: room.trumpActive ? room.trump : null,
    trumpCard: room.trumpActive ? room.trumpCard : null,
    trumpCardId: room.trumpActive || (!isSpectator && seat === room.trumpHolder) ? room.trumpCardId : null,
    trumpActive: room.trumpActive,
    trumpHolder: room.trumpHolder,
    isMyTrumpPick: !isSpectator && room.phase === "pickTrump" && room.trumpHolder === seat,
    // play
    turn: room.turn,
    trick: room.trick.map(publicPlay),
    lastTrick: publicLastTrick(room.lastTrick),
    pile: room.pile,
    tricksWon: room.tricksWon,
    scores: room.scores,
    khoti: room.khoti,
    loserTeam: room.loserTeam,
    skipsDone: room.skipsDone,
    message: room.message,
    legal: isSpectator ? [] : legalMoveIds(room, seat),
    isMyTurn: !isSpectator && room.turn === seat && room.phase === "playing",
  };
}
function broadcast(room) {
  room.seats.forEach((s, seat) => {
    if (s && s.connected && !s.bot && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(stateFor(room, seat, false)));
  });
  room.spectators.forEach((s) => {
    if (s && s.connected && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(stateFor(room, null, true)));
  });
  maybeScheduleBots(room);
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------------------------------------------------------------- dealing / flow
function startHand(room) {
  const deck = shuffle(buildDeck());
  const dealFirst = (room.dealer + 1) % 4;
  const bidFirst = firstBidderFor(room);
  const h = [[], [], [], []];
  let idx = 0;
  const order = [0, 1, 2, 3].map((i) => (dealFirst + i) % 4);
  for (const seat of order) for (let k = 0; k < 5; k++) h[seat].push(deck[idx++]);
  room.hands = h.map(sortHand);
  room.pending = { deck, idx, order };
  // reset per-hand state
  room.bids = [null, null, null, null];
  room.highBid = null;
  room.bidTurn = bidFirst;
  room.bidCount = 0;
  room.firstBidder = bidFirst;
  room.trump = null;
  room.trumpCard = null;
  room.trumpCardId = null;
  room.trumpActive = false;
  room.trumpHolder = null;
  room.trick = [];
  room.lastTrick = null;
  room.pile = 0;
  room.lastWinnerSeat = null;
  room.liveTrickResolved = false;
  room.aceWonLastTrick = [false, false, false, false];
  room.tricksWon = [0, 0];
  room.khoti = null;
  room.loserTeam = null;
  room.skipsDone = [false, false, false, false];
  room.phase = "bidding";
  room.message = `${room.seats[bidFirst].name} bids first. One bidding round only.`;
  broadcast(room);
}

function isHighCard(card) {
  return card.rank === "K" || card.rank === "A";
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function popCard(pool, predicate = () => true) {
  const idx = pool.findIndex(predicate);
  if (idx === -1) return null;
  return pool.splice(idx, 1)[0];
}
function pushCard(assigned, seat, card) {
  if (!card || assigned[seat].length >= 8) return false;
  assigned[seat].push(card);
  return true;
}
function fillSeat(assigned, pool, seat, predicate = () => true) {
  let changed = false;
  while (assigned[seat].length < 8) {
    const card = popCard(pool, predicate);
    if (!card) break;
    assigned[seat].push(card);
    changed = true;
  }
  return changed;
}
function fillRoundRobin(assigned, pool, seats, predicate = () => true) {
  let changed = true;
  while (changed && seats.some((seat) => assigned[seat].length < 8)) {
    changed = false;
    for (const seat of seats) {
      if (assigned[seat].length >= 8) continue;
      const card = popCard(pool, predicate);
      if (card) {
        assigned[seat].push(card);
        changed = true;
      }
    }
  }
}
function completeAnyMissing(assigned, pool) {
  // Last-resort safety: card count is more important than a broken deal.
  // This makes it impossible for a player to be left with 10/11/12 cards.
  fillRoundRobin(assigned, pool, [0, 1, 2, 3], () => true);
  for (const seat of [0, 1, 2, 3]) {
    if (assigned[seat].length !== 8) {
      throw new Error(`Deal failed: seat ${seat + 1} received ${assigned[seat].length} remaining cards.`);
    }
  }
  if (pool.length !== 0) {
    throw new Error(`Deal failed: ${pool.length} cards left undealt.`);
  }
}
function applyAssignedDeal(room, assigned) {
  for (let round = 0; round < 8; round++) {
    for (const seat of room.pending.order) {
      room.hands[seat].push(assigned[seat][round]);
    }
  }
  room.hands = room.hands.map(sortHand);
}
function dealRemainingNormal(room) {
  const { deck, idx, order } = room.pending;
  let i = idx;
  for (let round = 0; round < 2; round++) {
    for (const seat of order) {
      for (let k = 0; k < 4; k++) room.hands[seat].push(deck[i++]);
    }
  }
  room.hands = room.hands.map(sortHand);
}
function dealBid8Remaining(room, remaining) {
  // Bid 8 penalty, amended:
  // Restrict the bidding team in the remaining 8-card deal.
  // Preferred restrictions: no K/A; bidder may receive one extra trump; partner receives no extra trump.
  // If an impossible deck state occurs, the fallback fills all hands to 13 cards.
  const bidder = room.highBid.seat;
  const bidTeam = TEAM_OF(bidder);
  const partner = [0, 1, 2, 3].find((s) => s !== bidder && TEAM_OF(s) === bidTeam);
  const opponents = [0, 1, 2, 3].filter((s) => TEAM_OF(s) !== bidTeam);
  const assigned = { 0: [], 1: [], 2: [], 3: [] };
  const pool = shuffleInPlace([...remaining]);

  // Bidder may get one extra trump after the hidden trump.
  pushCard(assigned, bidder, popCard(pool, (c) => !isHighCard(c) && c.suit === room.trump));

  // Preferred fill: both bidding-team players avoid K/A, and partner avoids trump.
  fillRoundRobin(assigned, pool, [bidder, partner], (c) => !isHighCard(c) && c.suit !== room.trump);

  // Relaxation for bidder: non-high cards are okay; this may include trump only if needed.
  fillSeat(assigned, pool, bidder, (c) => !isHighCard(c));

  // Relaxation for partner: still try to avoid trump first, then allow non-high trump only if needed.
  fillSeat(assigned, pool, partner, (c) => !isHighCard(c) && c.suit !== room.trump);
  fillSeat(assigned, pool, partner, (c) => !isHighCard(c));

  // Last-resort relaxation for the bidding team before opponents consume the rest.
  fillRoundRobin(assigned, pool, [bidder, partner], () => true);

  // Opponents receive everything else.
  fillRoundRobin(assigned, pool, opponents, () => true);
  completeAnyMissing(assigned, pool);
  applyAssignedDeal(room, assigned);
}
function dealRemaining(room) {
  const { deck, idx } = room.pending;
  const remaining = deck.slice(idx);
  const bidAmount = room.highBid?.amount;

  if (bidAmount === 8) return dealBid8Remaining(room, remaining);
  return dealRemainingNormal(room);
}

function finishBidding(room, winnerSeat, amount) {
  room.trumpHolder = winnerSeat;
  room.highBid = { seat: winnerSeat, amount };
  room.phase = "pickTrump";
  room.turn = winnerSeat;
  room.message = `${room.seats[winnerSeat].name} won the bid at ${amount} and is choosing one hidden trump card\u2026`;
  broadcast(room);
}

function applyTrumpPick(room, cardId) {
  const card = room.hands[room.trumpHolder].find((c) => c.id === cardId);
  if (!card) return false;
  room.trump = card.suit;
  room.trumpCard = card;
  room.trumpCardId = card.id;
  dealRemaining(room);            // now everyone gets their full 13
  room.phase = "playing";
  room.turn = room.trumpHolder;   // bid winner leads
  room.message = `Trump card is hidden. ${room.seats[room.trumpHolder].name} leads. Bid: ${room.highBid.amount}.`;
  broadcast(room);
  return true;
}

function revealTrump(room, bySeat, mustCut = false) {
  room.trumpActive = true;
  room.lastWinnerSeat = null;     // consecutive-win count restarts under live trump
  const cardTxt = room.trumpCard ? `${room.trumpCard.rank}${room.trumpCard.suit}` : room.trump;
  room.message = mustCut
    ? `${room.seats[bySeat].name} couldn't follow — trump revealed: ${cardTxt}. Must cut.`
    : `${room.seats[bySeat].name} couldn't follow — trump revealed: ${cardTxt}.`;
}

function resolveTrick(room) {
  // Called when 4 cards are down. Pause so clients can see the full trick, then resolve.
  setTimeout(() => {
    const winningPlay = bestPlayInTrick(room.trick, room.trump, room.trumpActive);
    const winner = winningPlay.seat;
    const winnerWonWithAce = winningPlay.card?.rank === "A" && !winningPlay.zeroAce && !winningPlay.faceDown;
    const newPile = room.pile + 1;
    const scoopEligible = room.trumpActive && room.liveTrickResolved;
    const scoopTeam = scoopEligible && room.lastWinnerSeat !== null && winner === room.lastWinnerSeat
      ? TEAM_OF(winner) : null;
    const cardsLeft = room.hands.reduce((n, h) => n + h.length, 0);
    const handDone = cardsLeft === 0;
    const remainingTricks = Math.floor(cardsLeft / 4);

    let pileAfter = newPile;
    if (scoopTeam !== null) {
      room.tricksWon[scoopTeam] += newPile;
      pileAfter = 0;
      room.pile = 0;
      room.message = `${room.seats[winner].name} won 2 in a row — scooped ${newPile} trick${newPile > 1 ? "s" : ""} for ${teamName(scoopTeam)}.`;
    } else {
      room.pile = newPile;
      room.message = `${room.seats[winner].name} won the trick. Pile is now ${newPile}.`;
    }
    // After a scoop, reset consecutive-win tracking.
    // Otherwise the same player winning the next trick would incorrectly scoop again immediately.
    room.lastWinnerSeat = scoopTeam !== null ? null : winner;
    room.lastTrick = { trick: room.trick, winner };
    room.trick = [];
    // Correct back-to-back Ace rule: only an Ace that actually wins the trick
    // creates the next-trick Ace penalty for that same player.
    room.aceWonLastTrick = [false, false, false, false];
    if (winnerWonWithAce) room.aceWonLastTrick[winner] = true;
    if (room.trumpActive) room.liveTrickResolved = true;

    if (handDone) {
      let finalTricks = [...room.tricksWon];
      if (scoopTeam === null && newPile > 0) finalTricks[TEAM_OF(winner)] += newPile;
      endHand(room, finalTricks, "all 13 tricks played");
      return;
    }

    const bidTeam = TEAM_OF(room.highBid.seat);

    // Early auto-end: bidding team has already banked enough tricks to make the bid.
    if (room.tricksWon[bidTeam] >= room.highBid.amount) {
      endHand(room, room.tricksWon, "bid reached");
      return;
    }

    // Early auto-end: bidders' best case = banked + live pile + remaining tricks.
    if (room.tricksWon[bidTeam] + pileAfter + remainingTricks < room.highBid.amount) {
      endHand(room, room.tricksWon, "bid no longer reachable");
      return;
    }
    room.turn = winner;
    broadcast(room);
  }, 1300);
}

function endHand(room, finalTricks, reason) {
  const bidTeam = TEAM_OF(room.highBid.seat);
  const made = finalTricks[bidTeam] >= room.highBid.amount;
  const ns = [...room.scores];
  const delta = made ? room.highBid.amount : -2 * room.highBid.amount;
  ns[bidTeam] += delta;
  room.scores = ns;
  room.tricksWon = finalTricks;
  room.phase = "handover";
  // The team that lost the hand must complete the TKMKBSDA gate before the next hand.
  room.loserTeam = made ? (1 - bidTeam) : bidTeam;
  room.skipsDone = [false, false, false, false];
  const bidderName = teamName(bidTeam);
  room.message = made
    ? `${bidderName} made the bid: ${finalTricks[bidTeam]} ≥ ${room.highBid.amount}. +${room.highBid.amount} points.`
    : `${bidderName} fell short: ${finalTricks[bidTeam]} of ${room.highBid.amount} (${reason}). −2× = ${delta} points.`;

  const margin = ns[0] - ns[1];
  if (Math.abs(margin) >= 52) {
    const winners = margin > 0 ? 0 : 1;
    const losers = 1 - winners;
    room.khoti = { winners, losers, margin: Math.abs(margin) };
  }
  broadcast(room);
}

function resetToLobby(room) {
  room.dealer = 0;
  room.hands = [[], [], [], []];
  room.pending = null;
  room.bids = [null, null, null, null];
  room.highBid = null;
  room.bidTurn = 0;
  room.bidCount = 0;
  room.firstBidder = 0;
  room.trump = null;
  room.trumpCard = null;
  room.trumpCardId = null;
  room.trumpActive = false;
  room.trumpHolder = null;
  room.turn = 0;
  room.trick = [];
  room.lastTrick = null;
  room.pile = 0;
  room.lastWinnerSeat = null;
  room.liveTrickResolved = false;
  room.aceWonLastTrick = [false, false, false, false];
  room.tricksWon = [0, 0];
  room.scores = [0, 0];
  room.khoti = null;
  room.loserTeam = null;
  room.skipsDone = [false, false, false, false];
  room.phase = "lobby";
  room.message = seatedCount(room) < 4 ? `Waiting for players… (${seatedCount(room)}/4)` : "All four seated. Anyone can start.";
  broadcast(room);
}



// ---------------------------------------------------------------- bots
const BOT_NAMES = ["Babar Bot", "Nagma Bot", "Raja Bot", "Mirza Bot", "Sultan Bot", "Chaudhry Bot"];
function addBotToRoom(room) {
  if (!room || room.phase !== "lobby") return false;
  const seat = room.seats.findIndex((s) => s === null);
  if (seat === -1) return false;
  const name = BOT_NAMES[room.botSeq % BOT_NAMES.length];
  room.botSeq += 1;
  room.seats[seat] = {
    id: `bot_${room.code}_${seat}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    ws: null,
    connected: true,
    bot: true,
  };
  room.message = seatedCount(room) < 4
    ? `Bot added. Waiting for players… (${seatedCount(room)}/4)`
    : "All four seated. Anyone can start.";
  return true;
}
function fillBots(room) {
  let added = 0;
  while (room && room.phase === "lobby" && seatedCount(room) < 4) {
    if (!addBotToRoom(room)) break;
    added += 1;
  }
  return added;
}
function cardStrength(card) {
  if (!card) return 0;
  return RANK_VALUE[card.rank] || 0;
}
function chooseBotBid(room, seat) {
  const floor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
  if (floor > 13) return "pass";
  const hand = room.hands[seat] || [];
  const high = hand.filter((c) => ["A", "K", "Q", "J"].includes(c.rank)).length;
  const aces = hand.filter((c) => c.rank === "A").length;
  const suitCounts = Object.fromEntries(SUITS.map((s) => [s, hand.filter((c) => c.suit === s).length]));
  const longest = Math.max(...Object.values(suitCounts));
  let ceiling = 7 + Math.min(3, Math.floor((high + aces + Math.max(0, longest - 2)) / 2));
  if (aces >= 2) ceiling += 1;
  if (Math.random() < 0.16) ceiling += 1;
  ceiling = Math.max(7, Math.min(11, ceiling));
  return floor <= ceiling ? floor : "pass";
}
function chooseBotTrump(room, seat) {
  const hand = room.hands[seat] || [];
  const scoreCard = (card) => {
    const sameSuit = hand.filter((c) => c.suit === card.suit).length;
    return cardStrength(card) * 3 + sameSuit * 5 + (card.rank === "A" ? 7 : card.rank === "K" ? 4 : 0);
  };
  return [...hand].sort((a, b) => scoreCard(b) - scoreCard(a))[0]?.id;
}
function chooseBotCard(room, seat) {
  const ids = legalMoveIds(room, seat);
  const cards = (room.hands[seat] || []).filter((c) => ids.includes(c.id));
  if (!cards.length) return null;
  const zeroAceFor = (c) => c.rank === "A" && room.aceWonLastTrick[seat];
  const playValue = (c) => zeroAceFor(c) ? 0 : cardStrength(c);
  const lowFirst = [...cards].sort((a, b) => playValue(a) - playValue(b));
  const highFirst = [...cards].sort((a, b) => playValue(b) - playValue(a));
  if (room.trick.length === 0) {
    const nonAce = highFirst.find((c) => !(c.rank === "A" && room.aceWonLastTrick[seat]));
    return (nonAce || highFirst[0]).id;
  }
  const winning = lowFirst.filter((c) => {
    const candidate = { seat, card: c, faceDown: false, zeroAce: zeroAceFor(c) };
    const best = bestPlayInTrick([...room.trick, candidate], room.trump, room.trumpActive);
    return best === candidate;
  });
  // Try to win cheaply if possible; otherwise throw the cheapest legal card.
  return (winning[0] || lowFirst[0]).id;
}
function runBotTurn(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.botTimer = null;
  if (room.phase === "bidding" && isBotSeat(room, room.bidTurn)) {
    handleBot(room, room.bidTurn, { type: "bid", amount: chooseBotBid(room, room.bidTurn) });
    return;
  }
  if (room.phase === "pickTrump" && isBotSeat(room, room.trumpHolder)) {
    const cardId = chooseBotTrump(room, room.trumpHolder);
    if (cardId) handleBot(room, room.trumpHolder, { type: "pickTrump", cardId });
    return;
  }
  if (room.phase === "playing" && room.trick.length < 4 && isBotSeat(room, room.turn)) {
    const cardId = chooseBotCard(room, room.turn);
    if (cardId) handleBot(room, room.turn, { type: "play", cardId });
    return;
  }
  if (room.phase === "handover" && room.loserTeam != null && !room.khoti) {
    const loserSeats = [0, 1, 2, 3].filter((s) => TEAM_OF(s) === room.loserTeam);
    let changed = false;
    for (const s of loserSeats) {
      if (isBotSeat(room, s) && !room.skipsDone[s]) {
        room.skipsDone[s] = true;
        changed = true;
      }
    }
    const allSkipped = loserSeats.every((s) => room.skipsDone[s]);
    if (changed) broadcast(room);
    if (allSkipped && loserSeats.every((s) => isBotSeat(room, s))) {
      setTimeout(() => {
        const r = rooms.get(code);
        if (!r || r.phase !== "handover" || r.khoti) return;
        r.dealer = (r.dealer + 1) % 4;
        startHand(r);
      }, 900);
    }
  }
}
function scheduleBot(room, delay = 650) {
  if (!room) return;
  clearTimeout(room.botTimer);
  room.botTimer = setTimeout(() => runBotTurn(room.code), delay + Math.floor(Math.random() * 450));
}
function maybeScheduleBots(room) {
  if (!room) return;
  if (room.phase === "bidding" && isBotSeat(room, room.bidTurn)) return scheduleBot(room);
  if (room.phase === "pickTrump" && isBotSeat(room, room.trumpHolder)) return scheduleBot(room, 750);
  if (room.phase === "playing" && room.trick.length < 4 && isBotSeat(room, room.turn)) return scheduleBot(room, 700);
  if (room.phase === "handover" && room.loserTeam != null) return scheduleBot(room, 500);
}
function handleBot(room, seat, msg) {
  handle({ roomCode: room.code, seat, playerId: room.seats[seat]?.id, isSpectator: false }, msg);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.roomCode = null; ws.seat = null; ws.playerId = null; ws.isSpectator = false;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m && m.type === "ping") { ws.isAlive = true; try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    handle(ws, m);
  });
  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.isSpectator) {
      const sp = room.spectators.find((x) => x && x.id === ws.playerId && x.ws === ws);
      if (sp) sp.connected = false;
    } else if (ws.seat != null) {
      const s = room.seats[ws.seat];
      // Only react if THIS socket is still the one in the seat (a reconnect may have replaced it).
      if (s && s.ws === ws) {
        s.connected = false;
        // Grace period: don't spam "disconnected" — auto-reconnect usually restores within seconds.
        setTimeout(() => {
          const r = rooms.get(ws.roomCode);
          if (!r) return;
          const seat = r.seats[ws.seat];
          if (seat && seat.ws === ws && !seat.connected) {
            r.message = `${seat.name} disconnected — waiting for them to rejoin…`;
            broadcast(r);
          }
        }, 4000);
      }
    }
    setTimeout(() => {
      const r = rooms.get(ws.roomCode);
      if (r && connectedCount(r) === 0) rooms.delete(ws.roomCode);
    }, 120000);
  });
});

// Heartbeat: ping every 25s; a socket that misses a round-trip is terminated so it can reconnect.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 25000);
wss.on("close", () => clearInterval(heartbeat));

function joinRoom(ws, room, name, playerId) {
  if (room.phase !== "lobby") return send(ws, { type: "error", message: "That game has already started." });
  const seat = room.seats.findIndex((s) => s === null);
  if (seat === -1) return send(ws, { type: "error", message: "Room is full (4 players)." });
  const id = playerId || Math.random().toString(36).slice(2);
  room.seats[seat] = { id, name: String(name).slice(0, 16), ws, connected: true };
  ws.roomCode = room.code; ws.seat = seat; ws.playerId = id; ws.isSpectator = false;
  send(ws, { type: "joined", code: room.code, seat, playerId: id, isSpectator: false });
  room.message = seatedCount(room) < 4
    ? `Waiting for players… (${seatedCount(room)}/4)`
    : "All four seated. Anyone can start.";
  broadcast(room);
}

function joinSpectator(ws, room, name, playerId) {
  const id = playerId || Math.random().toString(36).slice(2);
  let existing = room.spectators.find((s) => s.id === id);
  if (!existing) {
    existing = { id, name: String(name).slice(0, 16), ws, connected: true };
    room.spectators.push(existing);
  } else {
    existing.name = String(name || existing.name || "Spectator").slice(0, 16);
    existing.ws = ws;
    existing.connected = true;
  }
  ws.roomCode = room.code; ws.seat = null; ws.playerId = id; ws.isSpectator = true;
  send(ws, { type: "joined", code: room.code, seat: null, playerId: id, isSpectator: true });
  broadcast(room);
}

function handle(ws, msg) {
  const room = rooms.get(ws.roomCode);
  switch (msg.type) {
    case "create": {
      const code = makeCode();
      const r = newRoom(code);
      rooms.set(code, r);
      joinRoom(ws, r, msg.name || "Player", msg.playerId);
      break;
    }
    case "createBots": {
      const code = makeCode();
      const r = newRoom(code);
      rooms.set(code, r);
      joinRoom(ws, r, msg.name || "Player", msg.playerId);
      fillBots(r);
      if (seatedCount(r) === 4) startHand(r);
      else broadcast(r);
      break;
    }
    case "join": {
      const r = rooms.get((msg.code || "").toUpperCase());
      if (!r) return send(ws, { type: "error", message: "No room with that code." });
      joinRoom(ws, r, msg.name || "Player", msg.playerId);
      break;
    }
    case "spectate": {
      const r = rooms.get((msg.code || "").toUpperCase());
      if (!r) return send(ws, { type: "error", message: "No room with that code." });
      joinSpectator(ws, r, msg.name || "Spectator", msg.playerId);
      break;
    }
    case "rejoin": {
      const r = rooms.get((msg.code || "").toUpperCase());
      if (!r) return send(ws, { type: "error", message: "Room no longer exists." });
      const seat = r.seats.findIndex((s) => s && s.id === msg.playerId);
      if (seat !== -1) {
        const wasDown = !r.seats[seat].connected;
        r.seats[seat].ws = ws; r.seats[seat].connected = true;
        ws.roomCode = r.code; ws.seat = seat; ws.playerId = msg.playerId; ws.isSpectator = false;
        ws.isAlive = true;
        if (wasDown) r.message = `${r.seats[seat].name} rejoined.`;
        broadcast(r);
        break;
      }
      const sp = r.spectators.find((s) => s && s.id === msg.playerId);
      if (!sp) return send(ws, { type: "error", message: "Could not find your seat." });
      sp.ws = ws; sp.connected = true;
      ws.roomCode = r.code; ws.seat = null; ws.playerId = msg.playerId; ws.isSpectator = true;
      ws.isAlive = true;
      broadcast(r);
      break;
    }
    case "addBot": {
      if (!room || room.phase !== "lobby") return;
      if (!addBotToRoom(room)) return send(ws, { type: "error", message: "No empty seat for a bot." });
      broadcast(room);
      break;
    }
    case "fillBots": {
      if (!room || room.phase !== "lobby") return;
      const added = fillBots(room);
      if (!added) return send(ws, { type: "error", message: "No empty seats for bots." });
      broadcast(room);
      break;
    }
    case "start": {
      if (!room || room.phase !== "lobby") return;
      if (seatedCount(room) !== 4) return send(ws, { type: "error", message: "Need all 4 seats filled." });
      room.dealer = 0;
      startHand(room);
      break;
    }
    case "bid": {
      if (!room || room.phase !== "bidding" || room.bidTurn !== ws.seat || room.bids[ws.seat] != null) return;
      const amount = msg.amount; // number or "pass"
      const floor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
      if (amount !== "pass" && (typeof amount !== "number" || amount < floor || amount > 13)) {
        return send(ws, { type: "error", message: floor > 13 ? "No higher bid is possible. You can only pass." : `Bid must be ${floor}–13 or pass.` });
      }

      room.bids[ws.seat] = amount;
      room.bidCount += 1;
      if (amount !== "pass") room.highBid = { seat: ws.seat, amount };
      room.message = amount === "pass" ? `${room.seats[ws.seat].name} passes.` : `${room.seats[ws.seat].name} bids ${amount}.`;

      // One round only: once all 4 seats have acted, bidding is finished.
      if (room.bidCount >= 4) {
        if (room.highBid) finishBidding(room, room.highBid.seat, room.highBid.amount);
        else finishBidding(room, room.firstBidder, MIN_BID); // nobody bid -> first bidder forced to min
        return;
      }

      room.bidTurn = (room.bidTurn + 1) % 4;
      broadcast(room);
      break;
    }
    case "pickTrump": {
      if (!room || room.phase !== "pickTrump" || room.trumpHolder !== ws.seat) return;
      applyTrumpPick(room, msg.cardId);
      break;
    }
    case "play": {
      if (!room || room.phase !== "playing" || room.turn !== ws.seat || room.trick.length >= 4) return;
      const legalIds = legalMoveIds(room, ws.seat);
      if (!legalIds.includes(msg.cardId)) return send(ws, { type: "error", message: "That card is not playable now." });

      const hand = room.hands[ws.seat];
      const card = hand.find((c) => c.id === msg.cardId);
      if (!card) return;
      const lead = room.trick.length ? room.trick[0].card.suit : null;
      const hasLead = lead ? hand.some((c) => c.suit === lead) : true;
      const isDefender = room.trumpHolder != null && TEAM_OF(ws.seat) !== TEAM_OF(room.trumpHolder);
      const isTrumpHolder = room.trumpHolder != null && ws.seat === room.trumpHolder;
      let faceDown = false;

      // Only the player who set the trump may play face down when void before reveal.
      // Their partner must play face up.
      if (lead && !hasLead && !room.trumpActive && isTrumpHolder) {
        faceDown = true;
      }

      // Defender void in lead suit before reveal: reveal exact hidden trump card and force cut if possible.
      if (lead && !hasLead && !room.trumpActive && isDefender) {
        const myTrumps = hand.filter((c) => c.suit === room.trump);
        if (myTrumps.length && card.suit !== room.trump) {
          revealTrump(room, ws.seat, true);
          broadcast(room);
          return send(ws, { type: "error", message: "Trump revealed — you must play a trump card." });
        }
        revealTrump(room, ws.seat, false);
      }

      // Back-to-back Ace rule: an Ace counts as 0 only if this same player
      // won the immediately previous trick with an Ace. Merely playing an Ace
      // and losing the trick does not trigger the penalty.
      const zeroAce = card.rank === "A" && room.aceWonLastTrick[ws.seat];

      // apply the play
      room.hands[ws.seat] = hand.filter((c) => c.id !== card.id);
      room.trick.push({ seat: ws.seat, card, faceDown, zeroAce });
      room.lastTrick = null;
      if (faceDown) room.message = `${room.seats[ws.seat].name} played a card face down.`;
      else if (zeroAce) room.message = `${room.seats[ws.seat].name} played a back-to-back Ace — this Ace counts as 0.`;

      if (room.trick.length === 4) { broadcast(room); resolveTrick(room); }
      else { room.turn = (room.turn + 1) % 4; broadcast(room); }
      break;
    }
    case "skip": {
      // A losing player completes their TKMKBSDA gate; broadcast progress to everyone.
      if (!room || room.phase !== "handover" || room.loserTeam == null || ws.seat == null) return;
      if (TEAM_OF(ws.seat) !== room.loserTeam) return;
      if (room.skipsDone[ws.seat]) return;
      room.skipsDone[ws.seat] = true;
      broadcast(room);
      break;
    }
    case "nextHand": {
      if (!room || room.phase !== "handover" || room.khoti) return;
      // Both losing players must complete TKMKBSDA before a new hand can start.
      if (room.loserTeam != null) {
        const loserSeats = [0, 1, 2, 3].filter((s) => TEAM_OF(s) === room.loserTeam);
        const allSkipped = loserSeats.every((s) => room.skipsDone[s]);
        if (!allSkipped) return send(ws, { type: "error", message: "The losing team must finish their TKMKBSDA first." });
      }
      room.dealer = (room.dealer + 1) % 4;
      startHand(room);
      break;
    }
    case "newMatch": {
      if (!room) return;
      resetToLobby(room);
      break;
    }
  }
}

server.listen(PORT, () => console.log(`Band Rang server on http://localhost:${PORT}`));
