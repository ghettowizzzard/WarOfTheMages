const path = require('path');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const players = new Map();

app.use(express.static(ROOT));
app.use('/Sounds', express.static(path.join(ROOT, 'Sounds')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, players: players.size });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'WizardGame.html'));
});

function broadcast(type, payload, exclude = null) {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  const playerId = crypto.randomUUID();
  ws.playerId = playerId;

  ws.send(JSON.stringify({
    type: 'welcome',
    payload: {
      playerId,
      players: Array.from(players.values())
    }
  }));

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload = {} } = message;

    switch (type) {
      case 'hello':
      case 'player_state': {
        const player = {
          ...(players.get(playerId) || {}),
          ...payload,
          id: playerId,
          updatedAt: Date.now()
        };

        players.set(playerId, player);
        broadcast(type === 'hello' ? 'player_joined' : 'player_state', { player }, ws);
        break;
      }

      case 'player_cast': {
        broadcast('player_cast', {
          playerId,
          ...payload,
          at: Date.now()
        }, ws);
        break;
      }

      case 'player_died': {
        const existing = players.get(playerId) || {};
        const player = {
          ...existing,
          ...(payload.player || {}),
          id: playerId,
          dead: true,
          updatedAt: Date.now()
        };
        players.set(playerId, player);

        broadcast('player_died', {
          playerId,
          player,
          reason: payload.reason || 'defeated',
          at: Date.now()
        }, ws);
        break;
      }

      case 'player_respawn': {
        const existing = players.get(playerId) || {};
        const player = {
          ...existing,
          ...(payload.player || {}),
          id: playerId,
          dead: false,
          updatedAt: Date.now()
        };
        players.set(playerId, player);

        broadcast('player_respawn', { player }, ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(playerId);
    broadcast('player_left', { playerId });
  });
});

server.listen(PORT, () => {
  console.log(`War of the Mages running on port ${PORT}`);
});