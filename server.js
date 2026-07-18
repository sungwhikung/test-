// PvP 서버 - 팀 배정, 라운드 진행, 체력/사망 판정을 서버가 권위있게 관리
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const ROUND_TIME = 60;
const WINS_NEEDED = 5;
const ROUND_END_DELAY = 4000;
const MATCH_END_DELAY = 6000;
const MAX_HEALTH = 100;

const players = {}; // socketId -> {id,name,team,x,y,z,yaw,health,alive,pending,kills}

const match = {
  state: 'waiting', // waiting | live | roundEnd | matchEnd
  roundTimeLeft: ROUND_TIME,
  scoreA: 0,
  scoreB: 0,
  roundNumber: 0
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
  const base = team === 'A' ? { x: -11, z: -11 } : { x: 11, z: 11 };
  return {
    x: base.x + (Math.random() - 0.5) * 4,
    y: 1.7,
    z: base.z + (Math.random() - 0.5) * 4,
    yaw: team === 'A' ? Math.PI * 0.25 : Math.PI * 1.25
  };
}

function broadcastPlayers() { io.emit('playersUpdate', players); }
function broadcastMatchState() { io.emit('matchState', match); }

function resetAllForRound() {
  Object.values(players).forEach(p => {
    p.health = MAX_HEALTH;
    p.alive = true;
    p.pending = false;
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
  resetAllForRound();
  broadcastPlayers();
  broadcastMatchState();
  io.emit('roundStart', { roundNumber: match.roundNumber });
}

function tryStartIfReady() {
  const { a, b } = teamCounts();
  if (a >= 1 && b >= 1) {
    startRound();
  } else {
    match.state = 'waiting';
    broadcastMatchState();
  }
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
  if (match.state !== 'live') return;
  const { a, b } = aliveCounts();
  if (a === 0 && b > 0) endRound('B');
  else if (b === 0 && a > 0) endRound('A');
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
    alive: match.state !== 'live',   // 라운드 진행 중 합류하면 대기(관전)
    pending: match.state === 'live',
    kills: 0
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

  socket.on('shootHit', (data) => {
    const shooter = players[socket.id];
    const target = players[data.targetId];
    if (!shooter || !target) return;
    if (match.state !== 'live') return;
    if (!shooter.alive || !target.alive) return;
    if (shooter.team === target.team) return; // 팀킬 방지

    const dmg = Math.max(1, Math.min(200, Number(data.damage) || 0));
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

// 라운드 타이머 - 서버 기준 1초마다
setInterval(() => {
  if (match.state !== 'live') return;
  match.roundTimeLeft--;
  if (match.roundTimeLeft <= 0) {
    match.roundTimeLeft = 0;
    const { a, b } = aliveCounts();
    if (a === b) {
      match.state = 'roundEnd';
      broadcastMatchState();
      io.emit('roundEnd', { winnerTeam: null, scoreA: match.scoreA, scoreB: match.scoreB });
      finishRoundAndContinue();
    } else {
      endRound(a > b ? 'A' : 'B');
    }
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
