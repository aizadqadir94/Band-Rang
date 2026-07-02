const SYM={S:"\u2660",H:"\u2665",D:"\u2666",C:"\u2663"};
const SUIT_NAME={S:"Spades",H:"Hearts",D:"Diamonds",C:"Clubs"};
const RED={H:true,D:true};
let ws, state=null, me={seat:null,code:null,name:"",playerId:null,isSpectator:false};
let localSkipTaps={};
let pingTimer=null, reconnectTimer=null, intentionalClose=false, reconnecting=false, lastTrumpActive=false;
try{ me.playerId=sessionStorage.getItem("br_pid")||null; me.code=sessionStorage.getItem("br_code")||null; me.name=sessionStorage.getItem("br_name")||""; me.isSpectator=sessionStorage.getItem("br_role")==="spectator"; }catch(e){}

function startPing(){
  clearInterval(pingTimer);
  pingTimer=setInterval(()=>{ if(ws && ws.readyState===1){ try{ ws.send(JSON.stringify({type:"ping"})); }catch(e){} } },20000);
}
function connect(then){
  const proto=location.protocol==="https:"?"wss":"ws";
  ws=new WebSocket(proto+"://"+location.host);
  ws.onopen=()=>{ reconnecting=false; startPing(); if(then) then(); };
  ws.onclose=()=>{
    clearInterval(pingTimer);
    if(intentionalClose) return;
    if(me.playerId && me.code){
      if(!reconnecting){ reconnecting=true; toast("Reconnecting\u2026"); }
      clearTimeout(reconnectTimer);
      reconnectTimer=setTimeout(()=>{ connect(()=>sendMsg({type:"rejoin",code:me.code,playerId:me.playerId})); }, 1500);
    }
  };
  ws.onerror=()=>{ try{ ws.close(); }catch(e){} };
  ws.onmessage=(ev)=>{
    const m=JSON.parse(ev.data);
    if(m.type==="pong") return;
    if(m.type==="joined"){
      me.seat=m.seat; me.code=m.code; me.playerId=m.playerId; me.isSpectator=!!m.isSpectator;
      try{sessionStorage.setItem("br_pid",m.playerId);sessionStorage.setItem("br_code",m.code);sessionStorage.setItem("br_role",me.isSpectator?"spectator":"player");}catch(e){}
    } else if(m.type==="state"){
      const wasActive = state ? state.trumpActive : false;
      state=m; me.seat=m.you; me.isSpectator=!!m.isSpectator; render(!wasActive && m.trumpActive);
    } else if(m.type==="error") toast(m.message);
  };
}
function sendMsg(o){ if(ws && ws.readyState===1){ ws.send(JSON.stringify(o)); } }
const TEAM_OF=(seat)=>seat%2;
let tt; function toast(t){ const el=document.getElementById("toast"); el.textContent=t; el.classList.add("show"); clearTimeout(tt); tt=setTimeout(()=>el.classList.remove("show"),2800); }

function createRoom(){ const n=document.getElementById("nameInput").value.trim()||"Player"; me.name=n; me.isSpectator=false; try{sessionStorage.setItem("br_name",n);sessionStorage.setItem("br_role","player");}catch(e){} connect(()=>sendMsg({type:"create",name:n,playerId:me.playerId})); }
function joinRoom(){ const n=document.getElementById("nameInput").value.trim()||"Player"; const c=document.getElementById("codeInput").value.trim().toUpperCase(); if(c.length!==4)return toast("Enter the 4-letter code."); me.name=n; me.isSpectator=false; try{sessionStorage.setItem("br_name",n);sessionStorage.setItem("br_role","player");}catch(e){} connect(()=>sendMsg({type:"join",code:c,name:n,playerId:me.playerId})); }
function watchRoom(){ const n=document.getElementById("nameInput").value.trim()||"Spectator"; const c=document.getElementById("codeInput").value.trim().toUpperCase(); if(c.length!==4)return toast("Enter the 4-letter code."); me.name=n; me.isSpectator=true; try{sessionStorage.setItem("br_name",n);sessionStorage.setItem("br_role","spectator");}catch(e){} connect(()=>sendMsg({type:"spectate",code:c,name:n,playerId:me.playerId})); }
function startGame(){ sendMsg({type:"start"}); }
function bid(a){ sendMsg({type:"bid",amount:a}); }
function pickTrump(cardId){ sendMsg({type:"pickTrump",cardId}); }
function playCard(id){ sendMsg({type:"play",cardId:id}); }
function nextHand(){ sendMsg({type:"nextHand"}); }
function skipMe(){ if(!state || state.phase!=="handover" || me.seat==null) return; const n=(localSkipTaps[me.seat]||0)+1; localSkipTaps[me.seat]=n; if(n>=13){ sendMsg({type:"skip"}); } render(false); }
function newMatch(){ sendMsg({type:"newMatch"}); }

if(me.playerId&&me.code){ connect(()=>sendMsg({type:"rejoin",code:me.code,playerId:me.playerId})); }

function render(flashReveal=false){
  const wrap=document.getElementById("wrap");
  if(!state){ landing(wrap); return; }
  document.getElementById("scorebar").style.visibility = state.phase==="lobby"?"hidden":"visible";
  if(state.phase!=="lobby") updateScorebar();
  if(state.phase==="lobby") lobby(wrap); else tableView(wrap, flashReveal);
}
function updateScorebar(){
  if(state.isSpectator || me.seat==null){
    document.getElementById("lab0").textContent="Team 1";
    document.getElementById("lab1").textContent="Team 2";
    document.getElementById("s0").textContent=state.scores[0]||0;
    document.getElementById("s1").textContent=state.scores[1]||0;
    return;
  }
  const myTeam=TEAM_OF(me.seat), opp=1-myTeam;
  const margin=(state.scores[myTeam]||0)-(state.scores[opp]||0);
  document.getElementById("lab0").textContent="Net · you";
  document.getElementById("lab1").textContent="Net · opp";
  document.getElementById("s0").textContent=margin>0?margin:0;
  document.getElementById("s1").textContent=margin<0?-margin:0;
}
function landing(wrap){
  wrap.innerHTML=`<div class="lobby"><h2>Play Band Rang online</h2>
    <p>Four players, two teams. One bidding round only. Create a room, share the code, and everyone plays from their own phone.</p>
    <input id="nameInput" placeholder="Your name" maxlength="16" value="${esc(me.name)}" />
    <div class="row"><button class="btn" onclick="createRoom()">Create a room</button></div>
    <div class="or">— or join/watch —</div>
    <div class="row"><input id="codeInput" class="code" placeholder="CODE" maxlength="4" /><button class="btn ghost" onclick="joinRoom()">Join</button><button class="btn ghost" onclick="watchRoom()">Watch</button></div></div>`;
}
function lobby(wrap){
  const seated=state.players.filter(p=>p&&p.connected).length;
  const spectators=(state.spectators||[]).filter(p=>p&&p.connected);
  wrap.innerHTML=`<div class="lobby"><h2>Room</h2><div class="codebig">${state.code}</div>
    <p class="hint">Share this code. The game starts when all four seats are filled.</p>
    <div class="seatlist">${state.players.map((p,i)=>`<div class="seatrow"><span class="dot ${p&&p.connected?'on':''}"></span><span>Seat ${i+1}${i===me.seat?' (you)':''}: ${p?esc(p.name):'<i style="color:#6c8479">empty</i>'}${p&&!p.connected?' <span style="color:#caa">(offline)</span>':''}</span></div>`).join("")}</div>
    ${spectators.length?`<p class="hint">Watching: ${spectators.map(s=>esc(s.name)).join(", ")}</p>`:""}
    <p class="hint">Teams: seats 1 & 3 vs 2 & 4 — partners sit across.</p>
    <button class="btn" onclick="startGame()" ${seated===4?'':'disabled'}>${seated===4?'Start the game':`Waiting (${seated}/4)`}</button></div>`;
}
function pos(seat){ if(state && state.isSpectator) return ["bottom","left","top","right"][seat]; return ["bottom","left","top","right"][(seat-me.seat+4)%4]; }
function teamName(t){ if(state && state.isSpectator) return t===0?"Team 1":"Team 2"; return t===TEAM_OF(me.seat)?"your team":"opponents"; }
function cardText(c){ return c ? `${c.rank}${SYM[c.suit]}` : ""; }
function trumpBadgeHtml(){
  if(state.trumpActive && state.trumpCard){
    return `<span class="l">Trump</span><span class="sym ${RED[state.trumpCard.suit]?'red':'black'}">${cardText(state.trumpCard)}</span>`;
  }
  if(state.trumpActive && state.trump){
    return `<span class="l">Trump</span><span class="sym ${RED[state.trump]?'red':'black'}">${SYM[state.trump]}</span>`;
  }
  return `<span class="l">Trump</span><span class="hid">hidden</span>`;
}

function tableView(wrap, flashReveal){
  const playByPos={}; const src = state.trick.length?state.trick:(state.lastTrick?state.lastTrick.trick:[]);
  src.forEach(pl=>playByPos[pos(pl.seat)]=pl);
  const partnerSeat=state.isSpectator ? null : (me.seat+2)%4;
  const cardsRemaining=state.handCounts.reduce((a,b)=>a+b,0);
  const completed=Math.floor((52-cardsRemaining-state.trick.length)/4);
  const roundNum = state.phase==="playing" ? Math.min(13,completed+1) : null;
  const bidTeam = state.highBid ? (state.highBid.seat%2) : null;
  const myTeam=state.isSpectator ? 0 : TEAM_OF(me.seat), oppTeam=1-myTeam;
  const netMargin=(state.scores[myTeam]||0)-(state.scores[oppTeam]||0);

  function seatBox(p){
    let seat=null; for(let s=0;s<4;s++) if(pos(s)===p) seat=s;
    if(seat===null || (p==="bottom" && !state.isSpectator)) return "";
    const pl=state.players[seat];
    const active=(state.phase==="playing"&&state.turn===seat)||(state.phase==="bidding"&&state.bidTurn===seat)||(state.phase==="pickTrump"&&state.trumpHolder===seat);
    const nm=pl?esc(pl.name):"empty";
    const isP=seat===partnerSeat;
    const isHolder=state.trumpHolder===seat;
    const bidShown = state.phase==="bidding"&&state.bids[seat]!=null ? (state.bids[seat]==="pass"?"pass":"bid "+state.bids[seat]) : "";
    return `<div class="seat ${p} ${active?'active':''} ${pl&&!pl.connected?'offline':''}">
      <div class="avatar">${nm[0]?nm[0].toUpperCase():'?'}</div>
      <div class="seatname">${nm}${isP?' <span class="tag">partner</span>':''}${isHolder?' <span class="tag">\u2756</span>':''}</div>
      ${bidShown?`<div class="tag">${bidShown}</div>`:''}
      <div class="seatname" style="font-size:10px;color:#9bb3a8">${state.handCounts[seat]} cards</div></div>`;
  }
  function playedHtml(p){
    const pl=playByPos[p]; if(!pl)return "";
    if(pl.faceDown || !pl.card) return `<div class="played ${p} back"><span>hidden</span></div>`;
    const c=pl.card; const isT=state.trumpActive&&c.suit===state.trump; const col=RED[c.suit]?"red":"black";
    return `<div class="played ${p} ${col}"><span class="c">${c.rank}</span><span class="p">${SYM[c.suit]}</span>${pl.zeroAce?'<span class="tdot">0</span>':(isT?'<span class="tdot"></span>':'')}</div>`;
  }

  const myTurn=!state.isSpectator && state.turn===me.seat;
  const handHtml=state.hand.map((c,i)=>{
    const locked=!state.trumpActive && state.trumpCardId===c.id;
    if(locked){
      return `<button class="card locked" style="margin-left:${i===0?0:-22}px;z-index:${i}" disabled title="Your hidden trump — locked until revealed"><span class="lock">\uD83D\uDD12</span><span class="small">trump</span></button>`;
    }
    const playable=state.phase==="playing"&&myTurn&&state.legal.includes(c.id);
    const dim=state.phase==="playing"&&myTurn&&!state.legal.includes(c.id);
    const col=RED[c.suit]?"red":"black";
    return `<button class="card ${col} ${playable?'playable':''} ${dim?'dim':''}" style="margin-left:${i===0?0:-22}px;z-index:${i}" ${playable?`onclick="playCard('${c.id}')"`:'disabled'}><span class="c">${c.rank}</span><span class="p">${SYM[c.suit]}</span></button>`;
  }).join("");

  wrap.innerHTML=`<div class="table ${flashReveal?'flash':''}">
    <div class="trumpbadge">${trumpBadgeHtml()}</div>
    ${state.highBid?`<div class="bidbadge">Bid ${state.highBid.amount} \u00b7 ${teamName(bidTeam)}</div>`:''}
    <div class="infostack">
      <div class="roundb">${roundNum?`Round ${roundNum} / 13`:(state.phase==="bidding"?"Bidding":state.phase==="pickTrump"?"Choosing trump":"\u2014")}</div>
      <div class="pileb"><span class="n">${state.pile}</span><span class="l">in pile</span></div>
      <div class="scorecard">
        <div class="sline"><span class="nm">Your team</span><span class="nu" style="color:${myTeam===bidTeam?'#c9a23f':'#dce7e0'}">${state.tricksWon[myTeam]}${state.highBid&&bidTeam===myTeam?` / ${state.highBid.amount}`:''}</span></div>
        <div class="sline"><span class="nm">Opponents</span><span class="nu" style="color:${oppTeam===bidTeam?'#c9a23f':'#dce7e0'}">${state.tricksWon[oppTeam]}${state.highBid&&bidTeam===oppTeam?` / ${state.highBid.amount}`:''}</span></div>
      </div>
      ${!state.trumpActive&&state.phase==="playing"?`<div class="hintb">Tricks pile up — no score until trump is revealed</div>`:''}
    </div>
    ${seatBox("top")}${seatBox("left")}${seatBox("right")}
    <div class="felt">${playedHtml("top")}${playedHtml("left")}${playedHtml("right")}${playedHtml("bottom")}<div class="feltmsg">${esc(state.message)}</div></div>
    ${biddingPanel()}
    ${trumpPanel()}
    <div class="handbottom"><div class="youtag">${state.isSpectator?"Watching as spectator":(myTurn&&state.phase==="playing"?"Your turn":(state.canBidNow?"Your bid":""))}</div><div class="fan">${handHtml}</div></div>
    ${handoverOverlay(netMargin)}
  </div>`;
  if(flashReveal){ const t=wrap.querySelector(".table"); if(t) setTimeout(()=>t.classList.remove("flash"),1200); }
}

function biddingPanel(){
  if(!state.canBidNow) return "";
  const floor=state.bidFloor; const opts=[]; for(let b=floor;b<=13;b++)opts.push(b);
  const title = floor > 13 ? "No higher bid possible" : `Your bid (min ${floor})`;
  return `<div class="panel"><span class="t">${title}</span>
    ${opts.length ? `<div class="bidgrid">${opts.map(b=>`<button class="bidbtn" onclick="bid(${b})">${b}</button>`).join("")}</div>` : `<div class="hint">Only pass is available.</div>`}
    <button class="passbtn" onclick="bid('pass')">Pass</button></div>`;
}
function trumpPanel(){
  if(!state.isMyTrumpPick) return "";
  return `<div class="panel"><span class="t">Tap one card to hide as trump</span>
    <div class="pickcards">${state.hand.map(c=>`<button class="pickcard ${RED[c.suit]?'red':'black'}" onclick="pickTrump('${c.id}')"><span style="font-size:15px;font-weight:700;line-height:1">${c.rank}</span><span style="font-size:18px;line-height:1">${SYM[c.suit]}</span></button>`).join("")}</div></div>`;
}
function handoverOverlay(netMargin){
  if(state.phase!=="handover") return "";
  if(state.khoti){
    return `<div class="overlay"><div class="ocard" style="border:2px solid var(--gold)"><div class="t" style="font-size:20px;line-height:1.45">Losing team is a khoti Randi,</div><div class="sc" style="font-size:15px;color:var(--gold)">Winning team gets 20% discount with Nagma</div><div class="sc">Won by a margin of ${state.khoti.margin}.</div><button class="btn" onclick="newMatch()">New match</button></div></div>`;
  }
  const myTeam = state.isSpectator ? 0 : TEAM_OF(me.seat);
  const loserSeats = state.loserTeam==null ? [] : [0,1,2,3].filter(s=>TEAM_OF(s)===state.loserTeam);
  const allSkipped = loserSeats.length ? loserSeats.every(s=>state.skipsDone && state.skipsDone[s]) : true;
  const skipHtml = loserSeats.length && !allSkipped ? `<div class="sc">Losing team must finish TKMKBSDA before the next hand.</div><div class="skipgrid">${loserSeats.map(s=>skipBox(s)).join("")}</div>` : "";
  return `<div class="overlay"><div class="ocard"><div class="t">${esc(state.message)}</div><div class="sc">Final tricks — ${state.isSpectator?`Team 1 ${state.tricksWon[0]} · Team 2 ${state.tricksWon[1]}`:`Us ${state.tricksWon[TEAM_OF(me.seat)]} · Them ${state.tricksWon[1-TEAM_OF(me.seat)]}`}</div><div class="sc">Net lead: ${state.isSpectator?`Team 1 ${state.scores[0]} · Team 2 ${state.scores[1]}`:(netMargin===0?"level":(netMargin>0?`your team +${netMargin}`:`opponents +${-netMargin}`))}</div>${skipHtml}<div class="row"><button class="btn" onclick="nextHand()" ${allSkipped?"":"disabled"}>${allSkipped?"Deal next hand":"Waiting for TKMKBSDA"}</button><button class="btn ghost" onclick="newMatch()">Reset match</button></div></div></div>`;
}
function skipBox(seat){
  const p=state.players[seat];
  const done=state.skipsDone && state.skipsDone[seat];
  const mine=!state.isSpectator && seat===me.seat;
  const taps=localSkipTaps[seat]||0;
  const dx=((taps*37)%90)-45, dy=((taps*23)%46)-23;
  if(done) return `<div class="skipcard"><div class="skipname">${esc(p?p.name:"Seat "+(seat+1))}</div><div class="skipdone">✓ TKMKBSDA done</div></div>`;
  if(mine) return `<div class="skipcard"><div class="skipname">${esc(p?p.name:"You")}</div><button class="btn skipbtn" style="transform:translate(${dx}px,${dy}px)" onclick="skipMe()">TKMKBSDA</button><div class="skipcount">${Math.max(0,13-taps)} taps left</div></div>`;
  return `<div class="skipcard"><div class="skipname">${esc(p?p.name:"Seat "+(seat+1))}</div><button class="btn skipbtn" disabled>TKMKBSDA</button><div class="skipcount">waiting</div></div>`;
}
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
render();
