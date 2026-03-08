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
const respawnTimers = new Map();
const RESPAWN_MS = 10000;

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

function sanitizePlayer(playerId, payload = {}, existing = {}) {
  return {
    ...existing,
    ...payload,
    id: playerId,
    name: payload.name ?? existing.name ?? 'Wizard',
    magic: payload.magic ?? existing.magic ?? 'storm',
    alignment: payload.alignment ?? existing.alignment ?? 'light',
    hp: payload.hp ?? existing.hp ?? 100,
    maxHP: payload.maxHP ?? existing.maxHP ?? 100,
    energy: payload.energy ?? existing.energy ?? 100,
    maxEnergy: payload.maxEnergy ?? existing.maxEnergy ?? 100,
    dead: existing.dead ?? payload.dead ?? false,
    aiming: payload.aiming ?? existing.aiming ?? false,
    castActive: payload.castActive ?? existing.castActive ?? false,
    appearance: payload.appearance ?? existing.appearance ?? null,
    respawnAt: existing.respawnAt ?? null,
    position: payload.position ?? existing.position ?? { x: 0, y: 8, z: 0 },
    velocity: payload.velocity ?? existing.velocity ?? { x: 0, y: 0, z: 0 },
    rotationY: payload.rotationY ?? existing.rotationY ?? 0,
    yaw: payload.yaw ?? existing.yaw ?? 0,
    pitch: payload.pitch ?? existing.pitch ?? 0,
    lastSpellId: payload.lastSpellId ?? existing.lastSpellId ?? null,
    spawnPoint: payload.spawnPoint ?? existing.spawnPoint ?? { x: 0, y: 8, z: 0 },
    updatedAt: Date.now(),
  };
}

function clearRespawnTimer(playerId) {
  const handle = respawnTimers.get(playerId);
  if (handle) {
    clearTimeout(handle);
    respawnTimers.delete(playerId);
  }
}

function scheduleRespawn(playerId) {
  clearRespawnTimer(playerId);

  const handle = setTimeout(() => {
    const existing = players.get(playerId);
    if (!existing) return;

    const spawn = existing.spawnPoint || { x: 0, y: 8, z: 0 };
    const player = {
      ...existing,
      dead: false,
      respawnAt: null,
      hp: existing.maxHP ?? 100,
      energy: existing.maxEnergy ?? 100,
      position: spawn,
      velocity: { x: 0, y: 0, z: 0 },
      updatedAt: Date.now(),
    };

    players.set(playerId, player);
    respawnTimers.delete(playerId);
    broadcast('player_respawn', { player });
  }, RESPAWN_MS);

  respawnTimers.set(playerId, handle);
}

wss.on('connection', (ws) => {
  const playerId = crypto.randomUUID();
  ws.playerId = playerId;

  ws.send(JSON.stringify({
    type: 'welcome',
    payload: {
      playerId,
      players: Array.from(players.values()),
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
        const existing = players.get(playerId) || {};
        const player = sanitizePlayer(playerId, payload, existing);

        if (existing.dead) {
          player.dead = true;
          player.respawnAt = existing.respawnAt ?? null;
        }

        players.set(playerId, player);
        broadcast(type === 'hello' ? 'player_joined' : 'player_state', { player }, ws);
        break;
      }

      case 'player_cast': {
        broadcast('player_cast', {
          playerId,
          ...payload,
          at: Date.now(),
        }, ws);
        break;
      }

      case 'player_died': {
        const existing = players.get(playerId) || {};
        const base = sanitizePlayer(playerId, payload.player || {}, existing);
        const respawnAt = Date.now() + RESPAWN_MS;

        const player = {
          ...base,
          dead: true,
          respawnAt,
          updatedAt: Date.now(),
        };

        players.set(playerId, player);
        scheduleRespawn(playerId);

        broadcast('player_died', {
          playerId,
          player,
          reason: payload.reason || 'defeated',
          respawnAt,
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearRespawnTimer(playerId);
    players.delete(playerId);
    broadcast('player_left', { playerId });
  });
});

server.listen(PORT, () => {
  console.log(`War of the Mages running on port ${PORT}`);
});
