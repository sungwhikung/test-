// 최종본 PvP 서버 - 로비(친구/파티) + 팀/공수 배정 + 코어 설치·해체 + 라운드 진행
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const ROUND_TIME = 90;
const CORE_TIMER = 40;
const WINS_NEEDED = 5;
const ROUND_END_DELAY = 4000;
const MATCH_END_DELAY = 6000;
const MAX_HEALTH = 100;
const PARTY_MAX = 5;

const SITE_A = { xMin: -18, xMax: -10, zMin: -4, zMax: 4 };
const SITE_B = { xMin: 10, xMax: 18, zMin: -4, zMax: 4 };
const DEFUSE_RANGE = 2.4;

// ---------- 로비 상태 (친구/파티는 서버 메모리에만 저장 - 재배포 시 초기화됨) ----------
const lobbyPlayers = {};        // socketId -> { id, name, partyId }
const onlineByName = {};        // name -> socketId
const friends = {};             // name -> Set(name)
const pendingFriendRequests = {}; // toName -> Set(fromName), 상대가 오프라인일 때 대기
const parties = {};             // partyId -> { leader: socketId, members: [socketId,...] }

// ---------- 매치 상태 ----------
const players = {}; // socketId -> {id,name,team,x,y,z,yaw,health,alive,pending,kills,shieldUntil,shieldReduce}
const match = {
  state: 'waiting',
  roundTimeLeft: ROUND_TIME,
  scoreA: 0,
  scoreB: 0,
  roundNumber: 0,
  attackingTeam: 'A',
  core: { planted: false, x: 0, y: 0, z: 0, timeLeft: 0, site: null }
};

function teamCounts() {
  let a = 0, b = 0;
  Object.values(players).forEach(p => { if (p.team === 'A') a++; else b++; });
  return { a, b };
}
function aliveCounts() {
  let a = 0, b = 0;
  Object.values(players).forEach(p => {
    if (!p.alive || p.pending) return;
    if (p.team === 'A') a++; else b++;
  });
  return { a, b };
}
function assignTeam() {
  const { a, b } = teamCounts();
  return a <= b ? 'A' : 'B';
}
function assignTeamConsideringParty(me) {
  if (me.partyId && parties[me.partyId]) {
    for (const id of parties[me.partyId].members) {
      if (players[id]) return players[id].team; // 이미 매치 중인 같은 파티원과 같은 팀
    }
  }
  return assignTeam();
}
function spawnPointFor(team) {
  const base = team === 'A' ? { x: -28, z: 0 } : { x: 28, z: 0 };
  return {
    x: base.x + (Math.random() - 0.5) * 10,
    y: 1.7,
    z: base.z + (Math.random() - 0.5) * 10,
    yaw: team === 'A' ? -Math.PI / 2 : Math.PI / 2
  };
}

function broadcastPlayers() { io.emit('playersUpdate', players); }
function broadcastMatchState() { io.emit('matchState', match); }
function broadcastPresence() { io.emit('presenceUpdate', { online: Object.keys(onlineByName) }); }

function resetAllForRound() {
  Object.values(players).forEach(p => {
    p.health = MAX_HEALTH;
    p.alive = true;
    p.pending = false;
    p.shieldUntil = 0;
    p.shieldReduce = 0;
    const sp = spawnPointFor(p.team);
    p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
    io.to(p.id).emit('yourSpawn', sp);
  });
}

function startRound() {
  match.roundNumber++;
  match.roundTimeLeft = ROUND_TIME;
  match.state = 'live';
  match.attackingTeam = (match.roundNumber % 2 === 1) ? 'A' : 'B';
  match.core = { planted: false, x: 0, y: 0, z: 0, timeLeft: 0, site: null };
  resetAllForRound();
  broadcastPlayers();
  broadcastMatchState();
  io.emit('roundStart', { roundNumber: match.roundNumber, attackingTeam: match.attackingTeam });
}

function tryStartIfReady() {
  const { a, b } = teamCounts();
  if (a >= 1 && b >= 1) startRound();
  else { match.state = 'waiting'; broadcastMatchState(); }
}

function finishRoundAndContinue() {
  setTimeout(() => {
    if (match.scoreA >= WINS_NEEDED || match.scoreB >= WINS_NEEDED) {
      const matchWinner = match.scoreA >= WINS_NEEDED ? 'A' : 'B';
      match.state = 'matchEnd';
      broadcastMatchState();
      io.emit('matchEnd', { winnerTeam: matchWinner, scoreA: match.scoreA, scoreB: match.scoreB });
      setTimeout(() => {
        match.scoreA = 0; match.scoreB = 0; match.roundNumber = 0;
        match.state = 'waiting';
        broadcastMatchState();
        tryStartIfReady();
      }, MATCH_END_DELAY);
    } else {
      const { a, b } = teamCounts();
      if (a >= 1 && b >= 1) startRound();
      else { match.state = 'waiting'; broadcastMatchState(); }
    }
  }, ROUND_END_DELAY);
}

function endRound(winnerTeam) {
  match.state = 'roundEnd';
  if (winnerTeam === 'A') match.scoreA++;
  else if (winnerTeam === 'B') match.scoreB++;
  broadcastMatchState();
  io.emit('roundEnd', { winnerTeam, scoreA: match.scoreA, scoreB: match.scoreB });
  finishRoundAndContinue();
}

function checkRoundWinByElimination() {
  if (match.state !== 'live' || match.core.planted) return;
  const alive = aliveCounts();
  const attackers = match.attackingTeam;
  const defenders = attackers === 'A' ? 'B' : 'A';
  const attackersAlive = attackers === 'A' ? alive.a : alive.b;
  const defendersAlive = defenders === 'A' ? alive.a : alive.b;
  if (attackersAlive === 0 && defendersAlive > 0) endRound(defenders);
}

function broadcastPartyUpdate(partyId) {
  const party = parties[partyId];
  if (!party) return;
  const memberInfo = party.members.map(id => ({
    id, name: lobbyPlayers[id] ? lobbyPlayers[id].name : '???', isLeader: id === party.leader
  }));
  io.to(partyId).emit('partyUpdate', { partyId, members: memberInfo });
}

io.on('connection', (socket) => {
  lobbyPlayers[socket.id] = { id: socket.id, name: `Guest${socket.id.slice(0, 4)}`, partyId: null };
  console.log('로비 접속:', socket.id);

  socket.emit('matchState', match);
  broadcastPresence();

  function leavePartyInternal() {
    const me = lobbyPlayers[socket.id];
    if (!me || !me.partyId) return;
    const partyId = me.partyId;
    const party = parties[partyId];
    socket.leave(partyId);
    me.partyId = null;
    socket.emit('partyUpdate', { partyId: null, members: [] });
    if (party) {
      party.members = party.members.filter(id => id !== socket.id);
      if (party.members.length === 0) {
        delete parties[partyId];
      } else {
        if (party.leader === socket.id) party.leader = party.members[0];
        broadcastPartyUpdate(partyId);
      }
    }
  }

  // ---------- 닉네임 설정 ----------
  socket.on('setName', (name) => {
    const me = lobbyPlayers[socket.id];
    if (!me) return;
    const base = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 16) : me.name;
    let finalName = base, suffix = 1;
    while (onlineByName[finalName] && onlineByName[finalName] !== socket.id) {
      finalName = `${base}${suffix}`; suffix++;
    }
    delete onlineByName[me.name];
    me.name = finalName;
    onlineByName[finalName] = socket.id;
    if (players[socket.id]) players[socket.id].name = finalName;

    socket.emit('nameConfirmed', { name: finalName });
    socket.emit('friendListUpdate', { friends: friends[finalName] ? Array.from(friends[finalName]) : [] });

    if (pendingFriendRequests[finalName]) {
      pendingFriendRequests[finalName].forEach(fromName => socket.emit('friendRequestReceived', { fromName }));
    }
    broadcastPresence();
  });

  // ---------- 친구 ----------
  socket.on('sendFriendRequest', (toName) => {
    const me = lobbyPlayers[socket.id];
    if (!me || typeof toName !== 'string' || !toName.trim() || toName === me.name) return;
    const target = toName.trim().slice(0, 16);
    const targetSocketId = onlineByName[target];
    if (targetSocketId) {
      io.to(targetSocketId).emit('friendRequestReceived', { fromName: me.name });
    } else {
      if (!pendingFriendRequests[target]) pendingFriendRequests[target] = new Set();
      pendingFriendRequests[target].add(me.name);
    }
    socket.emit('friendRequestSent', { toName: target });
  });

  socket.on('respondFriendRequest', (data) => {
    const me = lobbyPlayers[socket.id];
    if (!me || !data) return;
    const fromName = data.fromName;
    if (pendingFriendRequests[me.name]) pendingFriendRequests[me.name].delete(fromName);
    if (data.accept) {
      if (!friends[me.name]) friends[me.name] = new Set();
      if (!friends[fromName]) friends[fromName] = new Set();
      friends[me.name].add(fromName);
      friends[fromName].add(me.name);
      socket.emit('friendListUpdate', { friends: Array.from(friends[me.name]) });
      const fromSocketId = onlineByName[fromName];
      if (fromSocketId) io.to(fromSocketId).emit('friendListUpdate', { friends: Array.from(friends[fromName]) });
    }
  });

  // ---------- 파티 ----------
  socket.on('invitePartyMember', (toName) => {
    const me = lobbyPlayers[socket.id];
    if (!me || typeof toName !== 'string') return;
    if (!me.partyId) {
      const partyId = 'party_' + socket.id;
      parties[partyId] = { leader: socket.id, members: [socket.id] };
      me.partyId = partyId;
      socket.join(partyId);
      broadcastPartyUpdate(partyId);
    }
    if (parties[me.partyId].members.length >= PARTY_MAX) { socket.emit('partyFull'); return; }
    const targetSocketId = onlineByName[toName.trim()];
    if (targetSocketId) {
      io.to(targetSocketId).emit('partyInviteReceived', { fromName: me.name, partyId: me.partyId });
    }
  });

  socket.on('respondPartyInvite', (data) => {
    const me = lobbyPlayers[socket.id];
    if (!me || !data || !data.accept) return;
    const party = parties[data.partyId];
    if (!party) return;
    if (party.members.length >= PARTY_MAX) { socket.emit('partyFull'); return; }
    leavePartyInternal();
    party.members.push(socket.id);
    me.partyId = data.partyId;
    socket.join(data.partyId);
    broadcastPartyUpdate(data.partyId);
  });

  socket.on('leaveParty', leavePartyInternal);

  // ---------- 매치 참가 (여기서 실제로 팀 배정 + 라운드 로직에 편입됨) ----------
  socket.on('readyToPlay', () => {
    if (players[socket.id]) return;
    const me = lobbyPlayers[socket.id];
    if (!me) return;

    const team = assignTeamConsideringParty(me);
    const spawn = spawnPointFor(team);
    players[socket.id] = {
      id: socket.id, name: me.name, team,
      x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw,
      health: MAX_HEALTH,
      alive: match.state !== 'live',
      pending: match.state === 'live',
      kills: 0, shieldUntil: 0, shieldReduce: 0
    };

    socket.emit('yourInfo', { id: socket.id, team });
    socket.emit('yourSpawn', spawn);
    socket.emit('matchState', match);
    broadcastPlayers();
    if (match.state === 'waiting') tryStartIfReady();
  });

  // ---------- 무기 사격 & 스킬 데미지 ----------
  socket.on('shootHit', (data) => {
    const shooter = players[socket.id];
    const target = players[data.targetId];
    if (!shooter || !target) return;
    if (match.state !== 'live') return;
    if (!shooter.alive || !target.alive) return;
    if (shooter.team === target.team) return;

    let dmg = Math.max(1, Math.min(200, Number(data.damage) || 0));
    if (target.shieldUntil && target.shieldUntil > Date.now()) {
      dmg = dmg * (1 - (target.shieldReduce || 0));
    }
    target.health -= dmg;

    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      shooter.kills++;
      io.emit('playerKilled', {
        targetId: target.id, targetName: target.name,
        killerId: shooter.id, killerName: shooter.name
      });
      checkRoundWinByElimination();
    } else {
      io.emit('healthUpdate', { id: target.id, health: target.health });
    }
  });

  socket.on('healSelf', (amount) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    const amt = Math.max(0, Math.min(100, Number(amount) || 0));
    p.health = Math.min(MAX_HEALTH, p.health + amt);
    socket.emit('healthUpdate', { id: socket.id, health: p.health });
  });

  socket.on('activateShield', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    p.shieldUntil = Date.now() + Math.max(0, Math.min(15000, Number(data.duration) || 0));
    p.shieldReduce = Math.max(0, Math.min(0.9, Number(data.reduceRatio) || 0));
  });

  socket.on('abilityCast', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    socket.broadcast.emit('abilityCast', { ...data, casterId: socket.id, casterTeam: p.team, casterName: p.name });
  });

  socket.on('weaponFired', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    socket.broadcast.emit('weaponFired', { ...data, shooterId: socket.id });
  });

  socket.on('plantCore', () => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live' || match.core.planted) return;
    if (p.team !== match.attackingTeam) return;
    const inA = p.x >= SITE_A.xMin && p.x <= SITE_A.xMax && p.z >= SITE_A.zMin && p.z <= SITE_A.zMax;
    const inB = p.x >= SITE_B.xMin && p.x <= SITE_B.xMax && p.z >= SITE_B.zMin && p.z <= SITE_B.zMax;
    if (!inA && !inB) return;
    match.core = { planted: true, x: p.x, y: 1, z: p.z, timeLeft: CORE_TIMER, site: inA ? 'A' : 'B' };
    broadcastMatchState();
    io.emit('corePlanted', { byId: p.id, byName: p.name, site: match.core.site });
  });

  socket.on('defuseCore', () => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live' || !match.core.planted) return;
    const defenders = match.attackingTeam === 'A' ? 'B' : 'A';
    if (p.team !== defenders) return;
    const dx = p.x - match.core.x, dz = p.z - match.core.z;
    if (Math.sqrt(dx * dx + dz * dz) > DEFUSE_RANGE) return;
    io.emit('coreDefused', { byId: p.id, byName: p.name });
    endRound(defenders);
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.x = data.x; p.y = data.y; p.z = data.z; p.yaw = data.yaw;
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
  });

  socket.on('disconnect', () => {
    console.log('접속 종료:', socket.id);
    const me = lobbyPlayers[socket.id];
    if (me) delete onlineByName[me.name];
    leavePartyInternal();
    delete lobbyPlayers[socket.id];

    if (players[socket.id]) {
      delete players[socket.id];
      io.emit('playerLeft', socket.id);
      checkRoundWinByElimination();
      if (Object.keys(players).length < 2 && match.state !== 'roundEnd' && match.state !== 'matchEnd') {
        match.state = 'waiting';
        broadcastMatchState();
      }
    }
    broadcastPresence();
  });
});

setInterval(() => {
  if (match.state !== 'live') return;
  if (match.core.planted) {
    match.core.timeLeft--;
    if (match.core.timeLeft <= 0) { match.core.timeLeft = 0; endRound(match.attackingTeam); }
    else broadcastMatchState();
    return;
  }
  match.roundTimeLeft--;
  if (match.roundTimeLeft <= 0) {
    match.roundTimeLeft = 0;
    const defenders = match.attackingTeam === 'A' ? 'B' : 'A';
    endRound(defenders);
    return;
  }
  broadcastMatchState();
}, 1000);

app.get('/', (req, res) => {
  res.send('PvP 서버 작동 중. 로비: ' + Object.keys(lobbyPlayers).length + '명, 매치: ' + Object.keys(players).length + '명');
});

server.listen(PORT, () => console.log(`서버 실행 중, 포트 ${PORT}`));
