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
  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, time: Date.now() }));
  }
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
function trickWinner(trick, trump, trumpActive) {
  // Face-down cards can never win the trick.
  const eligible = trick.filter((p) => !p.faceDown);
  if (eligible.length === 0) return trick[0].seat;
  let best = eligible[0];
  for (const play of eligible) {
    const c = play.card, bc = best.card;
    if (trumpActive) {
      const cT = c.suit === trump, bT = bc.suit === trump;
      if (cT && !bT) best = play;
      else if (cT === bT && c.suit === bc.suit && RANK_VALUE[c.rank] > RANK_VALUE[bc.rank]) best = play;
    } else {
      if (c.suit === bc.suit && RANK_VALUE[c.rank] > RANK_VALUE[bc.rank]) best = play;
    }
  }
  return best.seat;
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
    tricksPlayed: 0,                 // completed tricks in the current hand
    lastWinnerSeat: null,
    liveTrickResolved: false,
    tricksWon: [0, 0],                 // picked/captured pile tricks this hand by each team
    scores: [0, 0],                    // net score: +bid if made, -2×bid if failed
    khoti: null,
    loserTeam: null,                   // which team lost the most recent hand (0 or 1)
    skipsDone: [false, false, false, false], // per-seat: has this player completed the TKMKBSDA skip
    lastScoop: null,                   // {seat,count,id} set briefly when a scoop happens
    shuffler: null,                    // seat shuffling before a deal (loser's duty)
    message: "Waiting for players\u2026",
  };
}
function seatedCount(room) { return room.seats.filter((s) => s && s.connected).length; }
function spectatorCount(room) { return room.spectators.filter((s) => s && s.connected).length; }
function connectedCount(room) { return seatedCount(room) + spectatorCount(room); }
function teamName(team) { return team === 0 ? "Team 1" : "Team 2"; }

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
    players: room.seats.map((s) => (s ? { name: s.name, connected: s.connected } : null)),
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
    tricksPlayed: room.tricksPlayed,
    tricksWon: room.tricksWon,
    scores: room.scores,
    khoti: room.khoti,
    loserTeam: room.loserTeam,
    skipsDone: room.skipsDone,
    lastScoop: room.lastScoop,
    shuffler: room.shuffler,
    message: room.message,
    legal: isSpectator ? [] : legalMoveIds(room, seat),
    isMyTurn: !isSpectator && room.turn === seat && room.phase === "playing",
  };
}
function broadcast(room) {
  room.seats.forEach((s, seat) => {
    if (s && s.connected && s.ws.readyState === 1) s.ws.send(JSON.stringify(stateFor(room, seat, false)));
  });
  room.spectators.forEach((s) => {
    if (s && s.connected && s.ws.readyState === 1) s.ws.send(JSON.stringify(stateFor(room, null, true)));
  });
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------------------------------------------------------------- dealing / flow
function startHand(room) {
  const deck = shuffle(buildDeck());
  const first = (room.dealer + 1) % 4;        // eldest hand bids first
  const h = [[], [], [], []];
  let idx = 0;
  const order = [0, 1, 2, 3].map((i) => (first + i) % 4);
  for (const seat of order) for (let k = 0; k < 5; k++) h[seat].push(deck[idx++]);
  room.hands = h.map(sortHand);
  room.pending = { deck, idx, order };
  // reset per-hand state
  room.bids = [null, null, null, null];
  room.highBid = null;
  room.bidTurn = first;
  room.bidCount = 0;
  room.trump = null;
  room.trumpCard = null;
  room.trumpCardId = null;
  room.trumpActive = false;
  room.trumpHolder = null;
  room.trick = [];
  room.lastTrick = null;
  room.pile = 0;
  room.tricksPlayed = 0;
  room.lastWinnerSeat = null;
  room.liveTrickResolved = false;
  room.tricksWon = [0, 0];
  room.khoti = null;
  room.loserTeam = null;
  room.skipsDone = [false, false, false, false];
  room.lastScoop = null;
  room.shuffler = null;
  room.phase = "bidding";
  room.message = `${room.seats[first].name} bids first. One bidding round only.`;
  broadcast(room);
}

// For a bid of exactly 8: rearrange the back-8 portion of the deck so the bidding team gets
// NO trump cards in their remaining 8 — every leftover trump goes to the two opponents.
// (The two opponents have 16 back-deal slots, at most 13 trumps exist, so this always fits.)
// Mirrors the offline build exactly.
function arrangeBackEightForBid(room) {
  if (!room.highBid || room.highBid.amount !== 8) return;
  const { deck, idx, order } = room.pending;
  const trumpSuit = room.trump;
  const bidderSeat = room.trumpHolder;
  const end = idx + 8 * order.length; // 32 cards make up the back deal
  const slice = deck.slice(idx, end);
  const bidTeam = TEAM_OF(bidderSeat);
  const oppSeats = order.filter((s) => TEAM_OF(s) !== bidTeam);
  const teamSeats = order.filter((s) => TEAM_OF(s) === bidTeam);
  const trumps = slice.filter((c) => c.suit === trumpSuit);
  const nonTrumps = slice.filter((c) => c.suit !== trumpSuit);
  if (trumps.length > oppSeats.length * 8) return; // safety: never happens, leave as-is
  const perSeat = {};
  for (const s of order) perSeat[s] = [];
  let ti = 0, ni = 0, oi = 0;
  while (ti < trumps.length) {
    const seat = oppSeats[oi % oppSeats.length];
    if (perSeat[seat].length < 8) perSeat[seat].push(trumps[ti++]);
    oi++;
  }
  const fillOrder = [...teamSeats, ...oppSeats]; // bidding team filled first, only with non-trumps
  for (const seat of fillOrder) {
    while (perSeat[seat].length < 8 && ni < nonTrumps.length) perSeat[seat].push(nonTrumps[ni++]);
  }
  const out = [];
  for (let round = 0; round < 2; round++)
    for (const seat of order)
      for (let k = 0; k < 4; k++) out.push(perSeat[seat][round * 4 + k]);
  for (let i = 0; i < out.length; i++) deck[idx + i] = out[i];
}

function dealRemaining(room) {
  const { deck, idx, order } = room.pending;
  let i = idx;
  for (let round = 0; round < 2; round++)
    for (const seat of order) for (let k = 0; k < 4; k++) room.hands[seat].push(deck[i++]);
  room.hands = room.hands.map(sortHand);
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
  arrangeBackEightForBid(room);   // on a bid of 8, steer all trumps to the opponents
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

// If we're about to play the FINAL trick and trump was never revealed (suits always followed),
// the bidder's locked trump card could never be played and the hand would stall. Auto-reveal it.
function maybeAutoRevealFinalTrick(room) {
  if (room.trumpActive) return false;
  if (room.trick.length !== 0) return false; // only at the start of a fresh trick
  const cardsLeft = room.hands.reduce((n, h) => n + h.length, 0);
  if (cardsLeft !== 4) return false;          // exactly one card per player = last trick
  room.trumpActive = true;
  room.lastWinnerSeat = null;
  const cardTxt = room.trumpCard ? `${room.trumpCard.rank}${room.trumpCard.suit}` : room.trump;
  room.message = `Final trick — trump auto-revealed: ${cardTxt}.`;
  return true;
}

function resolveTrick(room) {
  // Called when 4 cards are down. Pause so clients can see the full trick, then resolve.
  setTimeout(() => {
    const winner = trickWinner(room.trick, room.trump, room.trumpActive);
    const winningTeam = TEAM_OF(winner);
    const newPile = room.pile + 1;
    const cardsLeft = room.hands.reduce((n, h) => n + h.length, 0);
    const handDone = cardsLeft === 0;

    room.tricksPlayed = (room.tricksPlayed || 0) + 1;

    let pickedTeam = null;
    let pickedCount = 0;

    if (room.trumpActive) {
      const samePlayerTwoInARow = room.liveTrickResolved && room.lastWinnerSeat !== null && winner === room.lastWinnerSeat;
      if (samePlayerTwoInARow) {
        pickedTeam = winningTeam;
        pickedCount = newPile;
      } else if (handDone) {
        // If the hand ends with an unresolved pile, the final trick winner takes the remaining pile.
        pickedTeam = winningTeam;
        pickedCount = newPile;
      }
    } else if (handDone) {
      // Extremely defensive fallback. In normal play the final trick is auto-revealed before it starts.
      pickedTeam = winningTeam;
      pickedCount = newPile;
    }

    if (pickedTeam !== null) {
      room.tricksWon[pickedTeam] += pickedCount;
      room.pile = 0;
      room.lastScoop = { seat: winner, count: pickedCount, id: Date.now() };
      room.message = handDone && !(room.liveTrickResolved && winner === room.lastWinnerSeat)
        ? `${room.seats[winner].name} won the final trick — picked ${pickedCount} for ${teamName(pickedTeam)}.`
        : `${room.seats[winner].name} won 2 in a row — picked ${pickedCount} for ${teamName(pickedTeam)}.`;
      // After a pick, the same player must build a fresh two-in-a-row sequence.
      room.lastWinnerSeat = null;
      room.liveTrickResolved = false;
    } else {
      room.pile = newPile;
      room.message = room.trumpActive
        ? `${room.seats[winner].name} won the trick. Pile is now ${newPile}.`
        : `${room.seats[winner].name} won the trick. Trump is still hidden; pile is now ${newPile}.`;
      if (room.trumpActive) {
        room.lastWinnerSeat = winner;
        room.liveTrickResolved = true;
      } else {
        // No pickup tracking before trump is revealed.
        room.lastWinnerSeat = null;
        room.liveTrickResolved = false;
      }
    }

    room.lastTrick = { trick: room.trick, winner };
    room.trick = [];

    const bidTeam = TEAM_OF(room.highBid.seat);
    const defendTeam = 1 - bidTeam;
    const bid = room.highBid.amount;
    const defenderStopTarget = 14 - bid; // e.g. bid 9 => defenders need 5 picked tricks.

    // Stop only when picked/captured tricks decide the hand.
    if (room.tricksWon[bidTeam] >= bid) {
      endHand(room, [...room.tricksWon], "bid made early");
      return;
    }
    if (room.tricksWon[defendTeam] >= defenderStopTarget) {
      endHand(room, [...room.tricksWon], "bid no longer reachable");
      return;
    }
    if (handDone) {
      endHand(room, [...room.tricksWon], "all 13 tricks played");
      return;
    }

    room.turn = winner;
    maybeAutoRevealFinalTrick(room); // last trick with trump still hidden -> reveal so it can be played
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
  // The team that came out worse this hand must perform the TKMKBSDA skip.
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
  room.trump = null;
  room.trumpCard = null;
  room.trumpCardId = null;
  room.trumpActive = false;
  room.trumpHolder = null;
  room.turn = 0;
  room.trick = [];
  room.lastTrick = null;
  room.pile = 0;
  room.tricksPlayed = 0;
  room.lastWinnerSeat = null;
  room.liveTrickResolved = false;
  room.tricksWon = [0, 0];
  room.scores = [0, 0];
  room.khoti = null;
  room.loserTeam = null;
  room.skipsDone = [false, false, false, false];
  room.lastScoop = null;
  room.shuffler = null;
  room.phase = "lobby";
  room.message = seatedCount(room) < 4 ? `Waiting for players… (${seatedCount(room)}/4)` : "All four seated. Anyone can start.";
  broadcast(room);
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
    }, 30 * 60 * 1000);
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
        else finishBidding(room, (room.dealer + 1) % 4, MIN_BID); // nobody bid -> eldest forced to min
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
      maybeAutoRevealFinalTrick(room); // ensure the locked trump is playable on the last trick
      const legalIds = legalMoveIds(room, ws.seat);
      if (!legalIds.includes(msg.cardId)) return send(ws, { type: "error", message: "That card is not playable now." });

      const hand = room.hands[ws.seat];
      const card = hand.find((c) => c.id === msg.cardId);
      if (!card) return;
      const lead = room.trick.length ? room.trick[0].card.suit : null;
      const effectiveHand = (!room.trumpActive && ws.seat === room.trumpHolder && room.trumpCardId)
        ? hand.filter((c) => c.id !== room.trumpCardId)
        : hand;
      const hasLead = lead ? effectiveHand.some((c) => c.suit === lead) : true;
      const isDefender = room.trumpHolder != null && TEAM_OF(ws.seat) !== TEAM_OF(room.trumpHolder);
      let faceDown = false;

      // Only the trump setter plays vaddrang face down before reveal.
      // The setter's partner plays waste face up.
      if (lead && !hasLead && !room.trumpActive && ws.seat === room.trumpHolder) {
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

      // apply the play
      room.hands[ws.seat] = hand.filter((c) => c.id !== card.id);
      room.trick.push({ seat: ws.seat, card, faceDown });
      room.lastTrick = null;
      room.lastScoop = null;
      if (faceDown) room.message = `${room.seats[ws.seat].name} played a card face down.`;

      if (room.trick.length === 4) { broadcast(room); resolveTrick(room); }
      else { room.turn = (room.turn + 1) % 4; broadcast(room); }
      break;
    }
    case "skip": {
      // A losing player completes their TKMKBSDA skip; broadcast so everyone sees the progress.
      if (!room || room.phase !== "handover" || room.loserTeam == null || ws.seat == null) return;
      if (TEAM_OF(ws.seat) !== room.loserTeam) return; // only losers skip
      if (room.skipsDone[ws.seat]) return;
      room.skipsDone[ws.seat] = true;
      broadcast(room);
      break;
    }
    case "nextHand": {
      if (!room || room.phase !== "handover" || room.khoti) return;
      // Gate: both losing players must have completed their skip first.
      let shufflerSeat = room.dealer;
      if (room.loserTeam != null) {
        const loserSeats = [0, 1, 2, 3].filter((s) => TEAM_OF(s) === room.loserTeam);
        const allSkipped = loserSeats.every((s) => room.skipsDone[s]);
        if (!allSkipped) return send(ws, { type: "error", message: "The losing team must finish their TKMKBSDA first." });
        shufflerSeat = loserSeats[Math.floor(Math.random() * loserSeats.length)];
      }
      // The losing player shuffles for 5 seconds (loser's duty), then we deal.
      room.phase = "shuffling";
      room.shuffler = shufflerSeat;
      room.message = "Shuffling\u2026";
      broadcast(room);
      setTimeout(() => {
        if (room.phase !== "shuffling") return;
        room.shuffler = null;
        room.dealer = (room.dealer + 1) % 4;
        startHand(room);
      }, 5000);
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
