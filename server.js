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
};
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(__dirname, "public", urlPath);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
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
function legalMoves(hand, trick) {
  if (trick.length === 0) return hand;
  const lead = trick[0].card.suit;
  const inSuit = hand.filter((c) => c.suit === lead);
  return inSuit.length ? inSuit : hand;
}
function trickWinner(trick, trump, trumpActive) {
  let best = trick[0];
  for (const play of trick) {
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
    seats: [null, null, null, null],   // each: { id, name, ws, connected }
    phase: "lobby",                    // lobby | bidding | pickTrump | playing | handover
    dealer: 0,
    hands: [[], [], [], []],
    pending: null,                     // { deck, idx, order } for the deferred 8-card deal
    // bidding
    bids: [null, null, null, null],    // number | "pass" | null
    highBid: null,                     // { seat, amount }
    bidTurn: 0,
    // play
    trump: null,
    trumpActive: false,
    trumpHolder: null,
    turn: 0,
    trick: [],
    lastTrick: null,
    pile: 0,
    lastWinnerSeat: null,
    liveTrickResolved: false,
    tricksWon: [0, 0],
    scores: [0, 0],
    message: "Waiting for players\u2026",
  };
}
function seatedCount(room) { return room.seats.filter((s) => s && s.connected).length; }

// View sent to ONE seat: public state + only that seat's hand.
function stateFor(room, seat) {
  const legal =
    room.phase === "playing" && room.turn === seat
      ? legalMoves(room.hands[seat], room.trick).map((c) => c.id)
      : [];
  // bidding helper: the minimum this seat could bid right now
  const bidFloor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
  return {
    type: "state",
    you: seat,
    code: room.code,
    phase: room.phase,
    players: room.seats.map((s) => (s ? { name: s.name, connected: s.connected } : null)),
    handCounts: room.hands.map((h) => h.length),
    hand: seat != null && seat >= 0 ? room.hands[seat] : [],
    dealer: room.dealer,
    // bidding
    bids: room.bids,
    highBid: room.highBid,
    bidTurn: room.bidTurn,
    bidFloor,
    canBidNow: room.phase === "bidding" && room.bidTurn === seat &&
               room.bids[seat] !== "pass" && !(room.highBid && room.highBid.seat === seat),
    // trump: only reveal the suit once it is active, OR to the holder during their own pickTrump
    trump: room.trumpActive ? room.trump : (room.phase === "pickTrump" && room.trumpHolder === seat ? null : null),
    trumpActive: room.trumpActive,
    trumpHolder: room.trumpHolder,
    isMyTrumpPick: room.phase === "pickTrump" && room.trumpHolder === seat,
    // play
    turn: room.turn,
    trick: room.trick,
    lastTrick: room.lastTrick,
    pile: room.pile,
    tricksWon: room.tricksWon,
    scores: room.scores,
    message: room.message,
    legal,
    isMyTurn: room.turn === seat && room.phase === "playing",
  };
}
function broadcast(room) {
  room.seats.forEach((s, seat) => {
    if (s && s.connected && s.ws.readyState === 1) s.ws.send(JSON.stringify(stateFor(room, seat)));
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
  room.trump = null; room.trumpActive = false; room.trumpHolder = null;
  room.trick = []; room.lastTrick = null; room.pile = 0;
  room.lastWinnerSeat = null; room.liveTrickResolved = false;
  room.tricksWon = [0, 0];
  room.phase = "bidding";
  room.message = `${room.seats[first].name} bids first.`;
  broadcast(room);
}

function dealRemaining(room) {
  const { deck, idx, order } = room.pending;
  let i = idx;
  for (let round = 0; round < 2; round++)
    for (const seat of order) for (let k = 0; k < 4; k++) room.hands[seat].push(deck[i++]);
  room.hands = room.hands.map(sortHand);
}

function nextBidder(from, bids, high) {
  for (let step = 1; step <= 4; step++) {
    const s = (from + step) % 4;
    if (bids[s] === "pass") continue;
    if (high && s === high.seat) continue;
    return s;
  }
  return null;
}
function biddingOver(bids, high) {
  if (!high) return false;
  if (high.amount === 13) return true;
  for (let s = 0; s < 4; s++) {
    if (s === high.seat) continue;
    if (bids[s] !== "pass") return false;
  }
  return true;
}
function finishBidding(room, winnerSeat, amount) {
  room.trumpHolder = winnerSeat;
  room.highBid = { seat: winnerSeat, amount };
  // Deal the remaining 8 to everyone now. (The bidder chooses trump from the FIRST 5 only;
  // we keep their displayed pick honest by requiring the pick before they can act on the rest —
  // they don't get to play until trump is locked, and the client shows all 13 only after.)
  // To strictly limit the bidder's view to 5 during the pick, we defer the deal until the pick
  // for a human winner.
  room.phase = "pickTrump";
  room.turn = winnerSeat;
  room.message = `${room.seats[winnerSeat].name} won the bid at ${amount} and is choosing the trump\u2026`;
  broadcast(room);
}

function applyTrumpPick(room, suit) {
  dealRemaining(room);            // now everyone gets their full 13
  room.trump = suit;
  room.phase = "playing";
  room.turn = room.trumpHolder;   // bid winner leads
  room.message = `Trump is hidden. ${room.seats[room.trumpHolder].name} leads. Bid: ${room.highBid.amount}.`;
  broadcast(room);
}

function resolveTrick(room) {
  // Called when 4 cards are down. Pause so clients can see the full trick, then resolve.
  setTimeout(() => {
    const winner = trickWinner(room.trick, room.trump, room.trumpActive);
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
      room.message = `${room.seats[winner].name} won 2 in a row \u2014 scooped ${newPile} trick(s) for ${scoopTeam === 0 ? "Team 1" : "Team 2"}.`;
    } else {
      room.pile = newPile;
      room.message = `${room.seats[winner].name} won the trick. Pile is now ${newPile}.`;
    }
    room.lastWinnerSeat = winner;
    room.lastTrick = { trick: room.trick, winner };
    room.trick = [];
    if (room.trumpActive) room.liveTrickResolved = true;

    if (handDone) {
      let finalTricks = [...room.tricksWon];
      if (scoopTeam === null && newPile > 0) finalTricks[TEAM_OF(winner)] += newPile;
      endHand(room, finalTricks, "all 13 tricks played");
      return;
    }
    // Early auto-end: bidders' best case = banked + live pile + remaining tricks.
    const bidTeam = TEAM_OF(room.highBid.seat);
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
  const winningTeam = made ? bidTeam : 1 - bidTeam;
  room.scores[winningTeam]++;
  room.tricksWon = finalTricks;
  room.phase = "handover";
  const bidderName = bidTeam === 0 ? "Team 1" : "Team 2";
  const winnerName = winningTeam === 0 ? "Team 1" : "Team 2";
  room.message = made
    ? `${bidderName} made the bid: ${finalTricks[bidTeam]} \u2265 ${room.highBid.amount}. Hand won.`
    : `${bidderName} fell short: ${finalTricks[bidTeam]} of ${room.highBid.amount} (${reason}). ${winnerName} take the hand.`;
  broadcast(room);
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.roomCode = null; ws.seat = null; ws.playerId = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m && m.type === "ping") { ws.isAlive = true; try { ws.send(JSON.stringify({ type: "pong" })); } catch {} return; }
    handle(ws, m);
  });
  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room || ws.seat == null) return;
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
          r.message = `${seat.name} disconnected \u2014 waiting for them to rejoin\u2026`;
          broadcast(r);
        }
      }, 4000);
    }
    setTimeout(() => {
      const r = rooms.get(ws.roomCode);
      if (r && r.seats.every((x) => !x || !x.connected)) rooms.delete(ws.roomCode);
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
  ws.roomCode = room.code; ws.seat = seat; ws.playerId = id;
  send(ws, { type: "joined", code: room.code, seat, playerId: id });
  room.message = seatedCount(room) < 4
    ? `Waiting for players\u2026 (${seatedCount(room)}/4)`
    : "All four seated. Anyone can start.";
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
    case "rejoin": {
      const r = rooms.get((msg.code || "").toUpperCase());
      if (!r) return send(ws, { type: "error", message: "Room no longer exists." });
      const seat = r.seats.findIndex((s) => s && s.id === msg.playerId);
      if (seat === -1) return send(ws, { type: "error", message: "Could not find your seat." });
      const wasDown = !r.seats[seat].connected;
      r.seats[seat].ws = ws; r.seats[seat].connected = true;
      ws.roomCode = r.code; ws.seat = seat; ws.playerId = msg.playerId;
      ws.isAlive = true;
      if (wasDown) r.message = `${r.seats[seat].name} rejoined.`;
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
      if (!room || room.phase !== "bidding" || room.bidTurn !== ws.seat) return;
      const amount = msg.amount; // number or "pass"
      const floor = room.highBid ? room.highBid.amount + 1 : MIN_BID;
      if (amount !== "pass" && (typeof amount !== "number" || amount < floor || amount > 13)) {
        return send(ws, { type: "error", message: `Bid must be ${floor}\u201313 or pass.` });
      }
      room.bids[ws.seat] = amount;
      const newHigh = amount !== "pass" ? { seat: ws.seat, amount } : room.highBid;
      if (amount !== "pass") room.highBid = newHigh;
      room.message = amount === "pass" ? `${room.seats[ws.seat].name} passes.` : `${room.seats[ws.seat].name} bids ${amount}.`;
      if (biddingOver(room.bids, newHigh)) {
        if (newHigh) finishBidding(room, newHigh.seat, newHigh.amount);
        else { room.dealer = room.dealer; finishBidding(room, (room.dealer + 1) % 4, MIN_BID); }
        return;
      }
      const next = nextBidder(ws.seat, room.bids, newHigh);
      if (next === null) {
        if (newHigh) finishBidding(room, newHigh.seat, newHigh.amount);
        else finishBidding(room, (room.dealer + 1) % 4, MIN_BID);
      } else { room.bidTurn = next; broadcast(room); }
      break;
    }
    case "pickTrump": {
      if (!room || room.phase !== "pickTrump" || room.trumpHolder !== ws.seat) return;
      if (!SUITS.includes(msg.suit)) return;
      applyTrumpPick(room, msg.suit);
      break;
    }
    case "play": {
      if (!room || room.phase !== "playing" || room.turn !== ws.seat || room.trick.length >= 4) return;
      const hand = room.hands[ws.seat];
      const card = hand.find((c) => c.id === msg.cardId);
      if (!card) return;
      const lead = room.trick.length ? room.trick[0].card.suit : null;
      const hasLead = lead ? hand.some((c) => c.suit === lead) : true;
      // must follow suit
      if (lead && hasLead && card.suit !== lead) return send(ws, { type: "error", message: "You must follow suit." });
      const isDefender = TEAM_OF(ws.seat) !== TEAM_OF(room.trumpHolder);
      // defender void in lead, trump hidden -> reveal + must cut with trump if held
      if (lead && !hasLead && !room.trumpActive && isDefender) {
        const myTrumps = hand.filter((c) => c.suit === room.trump);
        if (myTrumps.length && card.suit !== room.trump) {
          // reveal first, then require a trump card
          room.trumpActive = true; room.lastWinnerSeat = null;
          room.message = `${room.seats[ws.seat].name} couldn't follow \u2014 trump revealed! Must cut.`;
          broadcast(room);
          return send(ws, { type: "error", message: `Trump revealed \u2014 you must play a trump (${room.trump}).` });
        }
        // reveal now (either they're cutting, or hold no trump and may sluff)
        room.trumpActive = true; room.lastWinnerSeat = null;
        room.message = `${room.seats[ws.seat].name} couldn't follow \u2014 trump revealed!`;
      }
      // apply the play
      room.hands[ws.seat] = hand.filter((c) => c.id !== card.id);
      room.trick.push({ seat: ws.seat, card });
      room.lastTrick = null;
      if (room.trick.length === 4) { broadcast(room); resolveTrick(room); }
      else { room.turn = (room.turn + 1) % 4; broadcast(room); }
      break;
    }
    case "nextHand": {
      if (!room || room.phase !== "handover") return;
      room.dealer = (room.dealer + 1) % 4;
      startHand(room);
      break;
    }
  }
}

server.listen(PORT, () => console.log(`Band Rang server on http://localhost:${PORT}`));
