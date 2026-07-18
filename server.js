// 멀티플레이어 서버 (Glitch에 그대로 올려서 사용)
// 하는 일: 접속한 플레이어들의 위치를 서로에게 중계만 함 (아직 사격/판정은 없음)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // 어떤 도메인(우리 HTML 파일)에서든 접속 허용
});

const PORT = process.env.PORT || 3000;

// 현재 접속 중인 플레이어들: { 소켓id: {x,y,z,yaw,name} }
const players = {};

io.on('connection', (socket) => {
  console.log('플레이어 접속:', socket.id);

  // 새로 들어온 플레이어 등록 (스폰 위치는 매번 살짝 다르게)
  players[socket.id] = {
    x: (Math.random() - 0.5) * 6,
    y: 1.7,
    z: (Math.random() - 0.5) * 6,
    yaw: 0,
    name: `Player-${socket.id.slice(0, 4)}`
  };

  // 방금 들어온 사람에게: 기존에 있던 모든 플레이어 목록을 알려줌
  socket.emit('currentPlayers', players);

  // 기존에 있던 사람들에게: 새 플레이어가 들어왔다고 알려줌
  socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

  // 위치 갱신 (클라이언트가 초당 몇 번씩 보냄)
  socket.on('move', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].z = data.z;
    players[socket.id].yaw = data.yaw;
    socket.broadcast.emit('playerMoved', { id: socket.id, ...players[socket.id] });
  });

  // 접속 종료
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    console.log('플레이어 퇴장:', socket.id);
  });
});

app.get('/', (req, res) => {
  res.send('멀티플레이어 서버가 작동 중입니다. 현재 접속자: ' + Object.keys(players).length + '명');
});

server.listen(PORT, () => {
  console.log(`서버 실행 중, 포트 ${PORT}`);
});
