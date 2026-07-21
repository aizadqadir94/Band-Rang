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
    // Bot intelligence uses only public play history plus each bot's own hand.
    botVoidSuits: [[], [], [], []],
    botTrickHistory: [],
    botLastLeadSuit: [null, null, null, null],
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

function revealLockedTrumpIfOnlyCard(room) {
  // If trump was never exposed during the first 12 tricks, the bidder reaches
  // the final trick with the selected trump as their only card. The card was
  // intentionally locked while trump was hidden, so reveal it now to prevent
  // an empty legal-move list and a stuck hand.
  if (!room || room.phase !== "playing" || room.trumpActive) return false;
  if (room.turn !== room.trumpHolder || room.trumpHolder == null) return false;

  const hand = room.hands[room.trumpHolder] || [];
  if (hand.length !== 1 || hand[0].id !== room.trumpCardId) return false;

  revealTrump(room, room.trumpHolder, false);
  const cardTxt = room.trumpCard
    ? `${room.trumpCard.rank}${room.trumpCard.suit}`
    : room.trump;
  room.message = `Final trick — hidden trump revealed automatically: ${cardTxt}.`;
  return true;
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
  revealLockedTrumpIfOnlyCard(room);
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
  room.botVoidSuits = [[], [], [], []];
  room.botTrickHistory = [];
  room.botLastLeadSuit = [null, null, null, null];
  room.tricksWon = [0, 0];
  room.khoti = null;
  room.loserTeam = null;
  room.skipsDone = [false, false, false, false];
  room.phase = "bidding";
  room.message = `${room.seats[bidFirst].name} bids first. One bidding round only.`;
  broadcast(room);
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
function dealRemaining(room) {
  // All bids now use the standard remaining-card deal.
  // There are no special dealing rules for bid 8 or bid 10.
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
    const leadSuitForBots = room.trick[0]?.card?.suit || null;
    room.botTrickHistory.push({
      winner,
      leadSuit: leadSuitForBots,
      trumpActive: room.trumpActive,
      plays: room.trick.map((p) => ({
        seat: p.seat,
        faceDown: !!p.faceDown,
        zeroAce: !!p.zeroAce,
        // A face-down card is not public information, so other bots do not get it.
        card: p.faceDown ? null : p.card,
      })),
    });
    if (room.botTrickHistory.length > 20) room.botTrickHistory.shift();
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
  room.botVoidSuits = [[], [], [], []];
  room.botTrickHistory = [];
  room.botLastLeadSuit = [null, null, null, null];
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
function partnerOf(seat) { return (seat + 2) % 4; }
function opponentsOf(seat) { return [0, 1, 2, 3].filter((s) => TEAM_OF(s) !== TEAM_OF(seat)); }
function suitCounts(cards) {
  const counts = Object.fromEntries(SUITS.map((s) => [s, 0]));
  for (const c of cards || []) counts[c.suit] += 1;
  return counts;
}
function effectiveBotValue(room, seat, card) {
  if (!card) return 0;
  if (card.rank === "A" && room.aceWonLastTrick[seat]) return 0;
  return cardStrength(card);
}
function botKnowsTrump(room, seat) {
  return !!room.trumpActive || seat === room.trumpHolder;
}
function knownTrumpSuit(room, seat) {
  return botKnowsTrump(room, seat) ? room.trump : null;
}
function isKnownVoid(room, seat, suit) {
  return !!(suit && room.botVoidSuits?.[seat]?.includes(suit));
}
function publicPlayedCards(room) {
  const cards = [];
  for (const hist of room.botTrickHistory || []) {
    for (const p of hist.plays || []) if (p.card) cards.push(p.card);
  }
  for (const p of room.trick || []) if (!p.faceDown && p.card) cards.push(p.card);
  return cards;
}
function higherUnseenCount(room, seat, card) {
  const ownIds = new Set((room.hands[seat] || []).map((c) => c.id));
  const seenIds = new Set(publicPlayedCards(room).map((c) => c.id));
  let count = 0;
  for (const rank of RANKS) {
    if (RANK_VALUE[rank] <= RANK_VALUE[card.rank]) continue;
    const id = rank + card.suit;
    if (!ownIds.has(id) && !seenIds.has(id)) count += 1;
  }
  return count;
}
function isTopRemaining(room, seat, card) {
  return higherUnseenCount(room, seat, card) === 0;
}
function suitLeadCount(room, suit) {
  return (room.botTrickHistory || []).filter((h) => h.leadSuit === suit).length;
}
function willBotPlayFaceDown(room, seat) {
  if (room.trumpActive || seat !== room.trumpHolder || room.trick.length === 0) return false;
  const lead = room.trick[0].card.suit;
  return !(room.hands[seat] || []).some((c) => c.suit === lead);
}
function botCandidateWins(room, seat, card) {
  const candidate = {
    seat,
    card,
    faceDown: willBotPlayFaceDown(room, seat),
    zeroAce: card.rank === "A" && room.aceWonLastTrick[seat],
  };
  const best = bestPlayInTrick([...room.trick, candidate], room.trump, room.trumpActive);
  return best === candidate;
}
function currentWinningSeat(room) {
  if (!room.trick.length) return null;
  return bestPlayInTrick(room.trick, room.trump, room.trumpActive).seat;
}
function cardHoldConfidence(room, seat, card) {
  const leftToPlay = Math.max(0, 4 - (room.trick.length + 1));
  const higher = higherUnseenCount(room, seat, card);
  let confidence = 1 - Math.min(0.85, higher * 0.22);
  if (leftToPlay === 0) confidence = 1;
  else if (leftToPlay === 1) confidence += 0.16;
  if (room.trumpActive && card.suit !== room.trump) {
    const lead = room.trick[0]?.card?.suit || card.suit;
    const playersAfter = [];
    for (let step = 1; step <= leftToPlay; step++) playersAfter.push((seat + step) % 4);
    if (playersAfter.some((s) => isKnownVoid(room, s, lead))) confidence -= 0.35;
  }
  if (isTopRemaining(room, seat, card)) confidence += 0.25;
  return Math.max(0, Math.min(1, confidence));
}
function discardScore(room, seat, card, { beforeReveal = false, defender = false } = {}) {
  const hand = room.hands[seat] || [];
  const counts = suitCounts(hand);
  const value = effectiveBotValue(room, seat, card);
  const trump = knownTrumpSuit(room, seat);
  let score = value * 5 + counts[card.suit] * 2.2;

  // A zero-value back-to-back Ace is an excellent discard.
  if (card.rank === "A" && room.aceWonLastTrick[seat]) score -= 45;
  // Preserve genuine controls and known trumps unless the situation demands them.
  if (isTopRemaining(room, seat, card)) score += 26;
  if (card.rank === "A") score += 16;
  else if (card.rank === "K") score += 9;
  if (trump && card.suit === trump) score += room.trumpActive ? 13 : 24;

  // Before reveal both sides shed weak cards from short suits. Defenders do it
  // more aggressively because becoming void is how they expose trump.
  if (beforeReveal) {
    score += counts[card.suit] * (defender ? 3.5 : 2.3);
    if (counts[card.suit] === 1) score -= defender ? 18 : 10;
    else if (counts[card.suit] === 2) score -= defender ? 8 : 4;
  }
  return score;
}
function chooseBotDiscard(room, seat, cards) {
  const biddingTeam = room.highBid ? TEAM_OF(room.highBid.seat) : null;
  const defender = biddingTeam != null && TEAM_OF(seat) !== biddingTeam;
  const beforeReveal = !room.trumpActive;
  return [...cards].sort((a, b) => {
    const diff = discardScore(room, seat, a, { beforeReveal, defender })
      - discardScore(room, seat, b, { beforeReveal, defender });
    return diff || effectiveBotValue(room, seat, a) - effectiveBotValue(room, seat, b);
  })[0];
}
function chooseControlCard(room, seat, suitCards) {
  const orderedHigh = [...suitCards].sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a));
  const orderedLow = [...orderedHigh].reverse();
  const sure = orderedHigh.find((c) => isTopRemaining(room, seat, c));
  if (sure) return sure;
  const efficient = orderedHigh.find((c) => effectiveBotValue(room, seat, c) >= 10 && higherUnseenCount(room, seat, c) <= 1);
  return efficient || orderedLow[0];
}
function choosePreRevealLead(room, seat, cards) {
  const hand = room.hands[seat] || [];
  const counts = suitCounts(hand);
  const partner = partnerOf(seat);
  const biddingTeam = TEAM_OF(room.highBid.seat);
  const defender = TEAM_OF(seat) !== biddingTeam;
  const opponents = opponentsOf(seat);
  const partnerSignal = room.botLastLeadSuit?.[partner] || null;
  const knownTrump = knownTrumpSuit(room, seat);

  const bySuit = new Map();
  for (const card of cards) {
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, []);
    bySuit.get(card.suit).push(card);
  }

  let bestSuit = null;
  let bestScore = -Infinity;
  for (const [suit, suitCards] of bySuit) {
    let score = 0;
    const count = counts[suit];
    const led = suitLeadCount(room, suit);

    if (defender) {
      // Defenders coordinate on short suits. Returning a partner's lead or
      // leading a suit the partner is already void in accelerates revelation.
      score += 54 / Math.max(1, count);
      if (count === 1) score += 34;
      else if (count === 2) score += 18;
      if (partnerSignal === suit) score += 42;
      if (isKnownVoid(room, partner, suit)) score += 85;
      // Do not give the bidding team free discards when both opponents are known void.
      score -= opponents.filter((o) => isKnownVoid(room, o, suit)).length * 18;
      score -= led * 5;
    } else {
      // Trump-setting team rotates safe suits. Avoid suits defenders have
      // publicly shown short/void in and avoid repeatedly draining one suit.
      score += 36 / Math.max(1, count);
      score -= led * 17;
      score -= opponents.filter((o) => isKnownVoid(room, o, suit)).length * 90;
      score -= opponents.filter((o) => room.botLastLeadSuit?.[o] === suit).length * 22;
      if (knownTrump && suit === knownTrump) score -= 48;
      if (isKnownVoid(room, partner, suit)) score += 8;
    }

    const bestControl = chooseControlCard(room, seat, suitCards);
    if (bestControl && isTopRemaining(room, seat, bestControl)) score += 14;
    if (score > bestScore) { bestScore = score; bestSuit = suit; }
  }

  const suitCards = bySuit.get(bestSuit) || cards;
  return chooseControlCard(room, seat, suitCards);
}
function choosePostRevealLead(room, seat, cards) {
  const partner = partnerOf(seat);
  const biddingTeam = TEAM_OF(room.highBid.seat);
  const myTeam = TEAM_OF(seat);
  const trumpCards = cards.filter((c) => c.suit === room.trump);
  const nonTrump = cards.filter((c) => c.suit !== room.trump);
  const need = Math.max(0, room.highBid.amount - room.tricksWon[biddingTeam]);
  const opponents = opponentsOf(seat);

  // Winning the next live trick after your own previous win scoops the pile.
  // Lead the strongest reliable control rather than a random high card.
  if (room.lastWinnerSeat === seat) {
    const certainTrump = [...trumpCards]
      .sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a))
      .find((c) => isTopRemaining(room, seat, c));
    if (certainTrump) return certainTrump;
    const certain = [...cards]
      .sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a))
      .find((c) => isTopRemaining(room, seat, c));
    if (certain) return certain;
  }

  // If partner is known void in a suit, lead that suit so the partner can cut
  // or discard intelligently. Prefer a low card so we do not waste a control.
  const partnerCutSuit = SUITS.find((s) => s !== room.trump && isKnownVoid(room, partner, s) && cards.some((c) => c.suit === s));
  if (partnerCutSuit) {
    return [...cards.filter((c) => c.suit === partnerCutSuit)]
      .sort((a, b) => effectiveBotValue(room, seat, a) - effectiveBotValue(room, seat, b))[0];
  }

  // Bidding side draws trump when it has control or urgently needs tricks.
  if (trumpCards.length && myTeam === biddingTeam) {
    const topTrump = [...trumpCards].sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a))[0];
    if (isTopRemaining(room, seat, topTrump) || need <= room.pile + 3 || trumpCards.length >= 3) return topTrump;
  }

  // Defenders use a top trump to seize control, but do not burn a weak trump lead.
  if (trumpCards.length && myTeam !== biddingTeam) {
    const topTrump = [...trumpCards].sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a))[0];
    if (isTopRemaining(room, seat, topTrump) && room.pile >= 1) return topTrump;
  }

  const sureWinner = [...nonTrump]
    .sort((a, b) => effectiveBotValue(room, seat, b) - effectiveBotValue(room, seat, a))
    .find((c) => isTopRemaining(room, seat, c) && !opponents.some((o) => isKnownVoid(room, o, c.suit)));
  if (sureWinner) return sureWinner;
  return chooseBotDiscard(room, seat, cards);
}
function chooseBotBid(room, seat) {
  const floor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
  if (floor > 13) return "pass";
  const hand = room.hands[seat] || [];
  const counts = suitCounts(hand);
  let bestSuitPower = 0;
  for (const suit of SUITS) {
    const suited = hand.filter((c) => c.suit === suit);
    const honors = suited.reduce((n, c) => n + Math.max(0, cardStrength(c) - 9), 0);
    const controls = suited.filter((c) => c.rank === "A" || c.rank === "K").length;
    bestSuitPower = Math.max(bestSuitPower, suited.length * 2.4 + honors * 0.8 + controls * 2.2);
  }
  const aces = hand.filter((c) => c.rank === "A").length;
  const kings = hand.filter((c) => c.rank === "K").length;
  const queens = hand.filter((c) => c.rank === "Q").length;
  const voidPotential = Object.values(counts).filter((n) => n <= 1).length;
  const evaluation = bestSuitPower + aces * 2.8 + kings * 1.5 + queens * 0.7 + voidPotential * 0.45;
  let ceiling = 7 + Math.floor(evaluation / 7.2);
  ceiling = Math.max(7, Math.min(11, ceiling));

  // Do not casually outbid a partner in the one-round auction.
  if (room.highBid && TEAM_OF(room.highBid.seat) === TEAM_OF(seat)) {
    if (ceiling <= room.highBid.amount + 1) return "pass";
  }
  return floor <= ceiling ? floor : "pass";
}
function chooseBotTrump(room, seat) {
  const hand = room.hands[seat] || [];
  if (!hand.length) return null;
  const suits = SUITS.map((suit) => {
    const cards = hand.filter((c) => c.suit === suit);
    const honors = cards.reduce((n, c) => n + Math.max(0, cardStrength(c) - 9), 0);
    const controls = cards.filter((c) => c.rank === "A" || c.rank === "K").length;
    const sequence = cards.filter((c) => cardStrength(c) >= 10).length;
    return { suit, cards, score: cards.length * 8 + honors * 2 + controls * 7 + sequence * 2 };
  }).filter((x) => x.cards.length);
  suits.sort((a, b) => b.score - a.score || b.cards.length - a.cards.length);
  const chosenSuit = suits[0];

  // The selected exact card is locked before reveal. Lock the weakest card in
  // the strongest suit, preserving A/K/Q as playable controls.
  const lowest = [...chosenSuit.cards].sort((a, b) => cardStrength(a) - cardStrength(b))[0];
  return lowest?.id || chosenSuit.cards[0]?.id || null;
}
function chooseBotCard(room, seat) {
  const ids = legalMoveIds(room, seat);
  const cards = (room.hands[seat] || []).filter((c) => ids.includes(c.id));
  if (!cards.length) return null;

  if (room.trick.length === 0) {
    const lead = room.trumpActive
      ? choosePostRevealLead(room, seat, cards)
      : choosePreRevealLead(room, seat, cards);
    return (lead || cards[0]).id;
  }

  // The setter's pre-reveal void card will be face down and cannot win.
  if (willBotPlayFaceDown(room, seat)) return chooseBotDiscard(room, seat, cards).id;

  const partner = partnerOf(seat);
  const winningSeat = currentWinningSeat(room);
  const partnerWinning = winningSeat === partner;
  const winningCards = cards
    .filter((c) => botCandidateWins(room, seat, c))
    .sort((a, b) => effectiveBotValue(room, seat, a) - effectiveBotValue(room, seat, b));

  // Never overtake a partner who is already winning. This preserves controls
  // and, after reveal, protects the partner's chance to complete a scoop.
  if (partnerWinning) return chooseBotDiscard(room, seat, cards).id;
  if (!winningCards.length) return chooseBotDiscard(room, seat, cards).id;

  const cheapestWin = winningCards[0];
  const lastToPlay = room.trick.length === 3;
  const biddingTeam = TEAM_OF(room.highBid.seat);
  const myTeam = TEAM_OF(seat);
  const defender = myTeam !== biddingTeam;
  const opponentAboutToScoop = room.trumpActive && winningSeat === room.lastWinnerSeat;
  const bidNeed = Math.max(0, room.highBid.amount - room.tricksWon[biddingTeam]);
  const bidClose = bidNeed <= room.pile + 3;
  const confidence = cardHoldConfidence(room, seat, cheapestWin);

  let shouldWin = lastToPlay || opponentAboutToScoop;
  if (!room.trumpActive) {
    // Before reveal, defenders value the lead because it lets them attack a
    // short suit. The setting team also takes control when it can do so
    // efficiently, instead of blindly throwing away every honor.
    if (defender) shouldWin ||= confidence >= 0.56;
    else shouldWin ||= confidence >= 0.7 || effectiveBotValue(room, seat, cheapestWin) <= 11;
  } else {
    const pileValue = room.pile + 1;
    if (myTeam === biddingTeam) shouldWin ||= bidClose || pileValue >= 2 || confidence >= 0.72;
    else shouldWin ||= bidClose || pileValue >= 2 || confidence >= 0.66;
  }

  if (shouldWin) return cheapestWin.id;
  return chooseBotDiscard(room, seat, cards).id;
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
    case "requestTrumpHighlight": {
      // Private helper: only a seated member of the trump-setting team may
      // request the hidden trump suit. The reply goes only to this socket;
      // nothing is added to shared room state or broadcast to other players.
      if (!room || ws.isSpectator || ws.seat == null) return;
      if (!room.trump || room.trumpHolder == null || room.phase === "lobby" || room.phase === "bidding" || room.phase === "pickTrump") {
        return send(ws, { type: "trumpHighlight", suit: null, message: "Trump has not been selected yet." });
      }
      if (TEAM_OF(ws.seat) !== TEAM_OF(room.trumpHolder)) {
        return send(ws, { type: "trumpHighlight", suit: null, message: "This private highlight is available only to the trump-setting team." });
      }
      return send(ws, { type: "trumpHighlight", suit: room.trump });
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

      // Public partnership inference for bots: a lead is a signal, and failing
      // to follow publicly proves that this seat is void in the led suit.
      if (!lead) room.botLastLeadSuit[ws.seat] = card.suit;
      if (lead && !hasLead && !room.botVoidSuits[ws.seat].includes(lead)) {
        room.botVoidSuits[ws.seat].push(lead);
      }

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
