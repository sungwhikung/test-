// 최종본 PvP 서버 - 팀/공수 배정, 코어 설치·해체, 라운드 진행, 체력/스킬 판정
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const ROUND_TIME = 90;      // 코어 설치 전 라운드 제한시간(초)
const CORE_TIMER = 40;      // 코어 설치 후 폭발까지(초)
const WINS_NEEDED = 5;
const ROUND_END_DELAY = 4000;
const MATCH_END_DELAY = 6000;
const MAX_HEALTH = 100;

// 클라이언트 맵 레이아웃과 반드시 일치해야 하는 사이트 범위
const SITE_A = { xMin: -18, xMax: -10, zMin: -4, zMax: 4 };
const SITE_B = { xMin: 10, xMax: 18, zMin: -4, zMax: 4 };
const DEFUSE_RANGE = 2.4;

const players = {}; // id -> {id,name,team,x,y,z,yaw,health,alive,pending,kills,shieldUntil,shieldReduce}

const match = {
  state: 'waiting', // waiting | live | roundEnd | matchEnd
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

function resetAllForRound() {
  Object.values(players).forEach(p => {
    p.health = MAX_HEALTH;
    p.alive = true;
    p.pending = false;
    p.shieldUntil = 0;
    p.shieldReduce = 0;
    const sp = spawnPointFor(p.team);
    p.x = sp.x; p.y = sp.y; p.z = sp.z; p.yaw = sp.yaw;
    const sock = io.sockets.sockets.get(p.id);
    if (sock) sock.emit('yourSpawn', sp);
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

// 설치 전에만 "공격팀 전멸 -> 수비팀 승리"가 즉시 성립. 설치 후엔 해체/폭발로만 라운드가 끝남
function checkRoundWinByElimination() {
  if (match.state !== 'live' || match.core.planted) return;
  const alive = aliveCounts();
  const attackers = match.attackingTeam;
  const defenders = attackers === 'A' ? 'B' : 'A';
  const attackersAlive = attackers === 'A' ? alive.a : alive.b;
  const defendersAlive = defenders === 'A' ? alive.a : alive.b;
  if (attackersAlive === 0 && defendersAlive > 0) endRound(defenders);
}

io.on('connection', (socket) => {
  const team = assignTeam();
  const spawn = spawnPointFor(team);

  players[socket.id] = {
    id: socket.id,
    name: `Player-${socket.id.slice(0, 4)}`,
    team,
    x: spawn.x, y: spawn.y, z: spawn.z, yaw: spawn.yaw,
    health: MAX_HEALTH,
    alive: match.state !== 'live',
    pending: match.state === 'live',
    kills: 0,
    shieldUntil: 0,
    shieldReduce: 0
  };

  console.log(`플레이어 접속: ${socket.id} (팀 ${team})`);

  socket.emit('yourInfo', { id: socket.id, team });
  socket.emit('yourSpawn', spawn);
  socket.emit('matchState', match);
  broadcastPlayers();

  if (match.state === 'waiting') tryStartIfReady();

  socket.on('setName', (name) => {
    const p = players[socket.id];
    if (p && typeof name === 'string' && name.trim()) {
      p.name = name.trim().slice(0, 16);
      broadcastPlayers();
    }
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.x = data.x; p.y = data.y; p.z = data.z; p.yaw = data.yaw;
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
  });

  // 무기 사격 & 스킬 데미지가 공통으로 사용하는 판정 통로
  socket.on('shootHit', (data) => {
    const shooter = players[socket.id];
    const target = players[data.targetId];
    if (!shooter || !target) return;
    if (match.state !== 'live') return;
    if (!shooter.alive || !target.alive) return;
    if (shooter.team === target.team) return; // 팀킬 방지 (스킬도 동일 적용)

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

  // 회복 스킬
  socket.on('healSelf', (amount) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    const amt = Math.max(0, Math.min(100, Number(amount) || 0));
    p.health = Math.min(MAX_HEALTH, p.health + amt);
    socket.emit('healthUpdate', { id: socket.id, health: p.health });
  });

  // 보호막 스킬 (이후 들어오는 데미지 감소)
  socket.on('activateShield', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    p.shieldUntil = Date.now() + Math.max(0, Math.min(15000, Number(data.duration) || 0));
    p.shieldReduce = Math.max(0, Math.min(0.9, Number(data.reduceRatio) || 0));
  });

  // 시각효과/유틸 스킬은 서버가 그대로 다른 클라이언트에 중계만 함
  socket.on('abilityCast', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive || match.state !== 'live') return;
    socket.broadcast.emit('abilityCast', { ...data, casterId: socket.id, casterTeam: p.team, casterName: p.name });
  });

  // 코어 설치 (공격팀만, 사이트 안에서만)
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

  // 코어 해체 (수비팀만, 설치된 코어 근처에서만)
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

  socket.on('disconnect', () => {
    console.log('플레이어 퇴장:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    checkRoundWinByElimination();
    if (Object.keys(players).length < 2 && match.state !== 'roundEnd' && match.state !== 'matchEnd') {
      match.state = 'waiting';
      broadcastMatchState();
    }
  });
});

// 서버 기준 1초 틱 - 라운드 타이머 또는 코어 타이머 진행
setInterval(() => {
  if (match.state !== 'live') return;

  if (match.core.planted) {
    match.core.timeLeft--;
    if (match.core.timeLeft <= 0) {
      match.core.timeLeft = 0;
      endRound(match.attackingTeam); // 폭발 -> 공격팀 승리
    } else {
      broadcastMatchState();
    }
    return;
  }

  match.roundTimeLeft--;
  if (match.roundTimeLeft <= 0) {
    match.roundTimeLeft = 0;
    const defenders = match.attackingTeam === 'A' ? 'B' : 'A';
    endRound(defenders); // 설치 못하고 시간 종료 -> 수비팀 승리
    return;
  }
  broadcastMatchState();
}, 1000);

app.get('/', (req, res) => {
  res.send('PvP 서버 작동 중. 접속자: ' + Object.keys(players).length + '명');
});

server.listen(PORT, () => {
  console.log(`서버 실행 중, 포트 ${PORT}`);
});
