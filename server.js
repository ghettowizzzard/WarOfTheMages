const fs = require('fs');
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
const CHAT_LOG_LIMIT = 250;
const MAX_WARNINGS_SAVED = 50;
const MAX_BAN_MS = 999 * 24 * 60 * 60 * 1000;

// SHA-256 hash. 
const OWNER_PASSWORD_HASH = '5e99daea91977f49fac49a134507dbe569fa3671d27406200fbfcda926815fd4';

const MOD_DATA_FILE = path.join(ROOT, 'moderation-data.json');
const MAP_STATE_FILE = path.join(ROOT, 'map-state.json');

const MOD_DATA = readJson(MOD_DATA_FILE, {
  meta: {
    ownerDeviceId: null,
  },
  users: {},
  chatLogs: [],
});

const MAP_STATE = readJson(MAP_STATE_FILE, {
  version: 1,
  draft: null,
  published: {
    version: 1,
    revision: 0,
    savedAt: null,
    publishedAt: null,
    baseObjects: [],
    added: [],
  },
});

app.use(express.static(ROOT));
app.use('/Sounds', express.static(path.join(ROOT, 'Sounds')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    players: players.size,
    registeredUsers: Object.keys(MOD_DATA.users).length,
  });
});

app.get('/api/bootstrap', (req, res) => {
  const deviceId = safeId(req.query.deviceId);
  const fingerprint = safeId(req.query.fp);

  const matchedBan = getActiveBanMatch(deviceId, fingerprint);

  res.json({
    ok: true,
    ownerBound: !!MOD_DATA.meta.ownerDeviceId,
    ownerCapable: !MOD_DATA.meta.ownerDeviceId || MOD_DATA.meta.ownerDeviceId === deviceId,
    ban: matchedBan ? serializeBan(matchedBan.ban) : null,
  });
});

app.get('/api/map-state', (_req, res) => {
  res.json({
    ok: true,
    published: MAP_STATE.published || null,
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'WizardGame.html'));
});

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveModData() {
  fs.writeFileSync(MOD_DATA_FILE, JSON.stringify(MOD_DATA, null, 2), 'utf8');
}

function saveMapState() {
  fs.writeFileSync(MAP_STATE_FILE, JSON.stringify(MAP_STATE, null, 2), 'utf8');
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeHexColor(value, fallback = '#c9ced8') {
  const out = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(out) ? out : fallback;
}

function sanitizeMapEntry(entry = {}, kind = 'base') {
  let safeMeta = {};
  try {
    safeMeta = entry && typeof entry.meta === 'object' && entry.meta
      ? JSON.parse(JSON.stringify(entry.meta))
      : {};
  } catch {
    safeMeta = {};
  }

  return {
    id: safeId(entry.id, 96) || crypto.randomUUID(),
    kind: kind === 'added' ? 'added' : 'base',
    assetId: clampText(entry.assetId, 64) || 'prop',
    label: clampText(entry.label, 96) || 'Map Object',
    position: {
      x: clampNumber(entry.position?.x, -5000, 5000, 0),
      y: clampNumber(entry.position?.y, -500, 2000, 0),
      z: clampNumber(entry.position?.z, -5000, 5000, 0),
    },
    rotationY: clampNumber(entry.rotationY, -1000, 1000, 0),
    scale: {
      x: clampNumber(entry.scale?.x, 0.1, 100, 1),
      y: clampNumber(entry.scale?.y, 0.1, 100, 1),
      z: clampNumber(entry.scale?.z, 0.1, 100, 1),
    },
    hidden: !!entry.hidden,
    lockedDelete: !!entry.lockedDelete,
    textureStyle: clampText(entry.textureStyle, 48) || 'default',
    color: safeHexColor(entry.color, '#c9ced8'),
    meta: safeMeta,
  };
}

function sanitizeMapState(input = {}) {
  const baseObjects = Array.isArray(input.baseObjects)
    ? input.baseObjects.slice(0, 5000).map(entry => sanitizeMapEntry(entry, 'base'))
    : [];

  const added = Array.isArray(input.added)
    ? input.added.slice(0, 2500).map(entry => sanitizeMapEntry(entry, 'added'))
    : [];

  return {
    version: 1,
    revision: clampNumber(input.revision, 0, 999999, 0),
    savedAt: Date.now(),
    publishedAt: input.publishedAt ? clampNumber(input.publishedAt, 0, 9999999999999, Date.now()) : null,
    baseObjects,
    added,
  };
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function clampText(value, max = 300) {
  return String(value ?? '').trim().slice(0, max);
}

function safeId(value, max = 160) {
  const out = clampText(value, max);
  return out || null;
}

function sendJson(ws, type, payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(type, payload, exclude = null, predicate = null) {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client === exclude || client.readyState !== 1) continue;
    if (predicate && !predicate(client)) continue;
    client.send(message);
  }
}

function getSocketByPlayerId(targetId) {
  for (const client of wss.clients) {
    if (client.playerId === targetId && client.readyState === 1) {
      return client;
    }
  }
  return null;
}

function sendToPlayer(targetId, type, payload) {
  const target = getSocketByPlayerId(targetId);
  if (!target) return false;
  sendJson(target, type, payload);
  return true;
}

function listVisiblePlayersFor(client) {
  return Array.from(players.values()).filter((player) => {
    return !player.adminFlags?.invisible || !!client.isOwner;
  });
}

function isBanActive(ban) {
  return !!ban && Number(ban.until) > Date.now();
}

function serializeBan(ban) {
  if (!isBanActive(ban)) return null;
  const remainingMs = Math.max(0, Number(ban.until) - Date.now());
  return {
    reason: ban.reason || '',
    until: Number(ban.until),
    createdAt: Number(ban.createdAt || Date.now()),
    remainingMs,
    active: remainingMs > 0,
  };
}

function clearExpiredBans() {
  let dirty = false;
  for (const user of Object.values(MOD_DATA.users)) {
    if (user?.ban && !isBanActive(user.ban)) {
      user.ban = null;
      dirty = true;
    }
  }
  if (dirty) saveModData();
}

function ensureRegistryUser({ deviceId, fingerprint = null, name = 'Wizard' } = {}) {
  if (!deviceId) return null;

  const existing = MOD_DATA.users[deviceId] || {
    deviceId,
    deviceFingerprint: fingerprint,
    lastName: name,
    nameHistory: [],
    warnings: [],
    ban: null,
    frozen: false,
    online: false,
    currentPlayerId: null,
    lastSeen: Date.now(),
    ownerTrusted: false,
  };

  MOD_DATA.users[deviceId] = existing;

  if (fingerprint) existing.deviceFingerprint = fingerprint;
  if (name) {
    existing.lastName = name;
    if (!existing.nameHistory.includes(name)) {
      existing.nameHistory.unshift(name);
      existing.nameHistory = existing.nameHistory.slice(0, 12);
    }
  }

  return existing;
}

function syncRegistryUser({ deviceId, fingerprint, name, playerId = null, online = null } = {}) {
  const user = ensureRegistryUser({ deviceId, fingerprint, name });
  if (!user) return false;

  let changed = false;

  if (fingerprint && user.deviceFingerprint !== fingerprint) {
    user.deviceFingerprint = fingerprint;
    changed = true;
  }

  if (name && user.lastName !== name) {
    user.lastName = name;
    changed = true;
  }

  if (name && !user.nameHistory.includes(name)) {
    user.nameHistory.unshift(name);
    user.nameHistory = user.nameHistory.slice(0, 12);
    changed = true;
  }

  if (typeof online === 'boolean' && user.online !== online) {
    user.online = online;
    changed = true;
  }

  if ((user.currentPlayerId || null) !== (playerId || null)) {
    user.currentPlayerId = playerId || null;
    changed = true;
  }

  user.lastSeen = Date.now();
  return changed;
}

function getActiveBanMatch(deviceId, fingerprint) {
  clearExpiredBans();

  for (const user of Object.values(MOD_DATA.users)) {
    if (!user?.ban) continue;

    if (deviceId && user.deviceId === deviceId) {
      return { user, ban: user.ban };
    }

    if (fingerprint && user.deviceFingerprint && user.deviceFingerprint === fingerprint) {
      return { user, ban: user.ban };
    }
  }

  return null;
}

function serializeRegistryUser(user) {
  clearExpiredBans();

  return {
    deviceId: user.deviceId,
    lastName: user.lastName || 'Wizard',
    nameHistory: Array.isArray(user.nameHistory) ? user.nameHistory.slice(0, 12) : [],
    warningCount: Array.isArray(user.warnings) ? user.warnings.length : 0,
    warnings: Array.isArray(user.warnings) ? user.warnings.slice(-25) : [],
    activeBan: serializeBan(user.ban),
    frozen: !!user.frozen,
    online: !!user.online,
    currentPlayerId: user.currentPlayerId || null,
    lastSeen: user.lastSeen || null,
    ownerTrusted: !!user.ownerTrusted,
  };
}

function buildOwnerState() {
  clearExpiredBans();

  const users = Object.values(MOD_DATA.users)
    .sort((a, b) => {
      if (Number(b.online) !== Number(a.online)) return Number(b.online) - Number(a.online);
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    })
    .map(serializeRegistryUser);

  return {
    users,
    chatLogs: MOD_DATA.chatLogs.slice(-200),
    ownerDeviceBound: MOD_DATA.meta.ownerDeviceId || null,
  };
}

function notifyOwners() {
  const payload = buildOwnerState();
  broadcast('owner_state', payload, null, (client) => !!client.isOwner);
}

function pushChatLog(entry) {
  MOD_DATA.chatLogs.push(entry);
  MOD_DATA.chatLogs = MOD_DATA.chatLogs.slice(-CHAT_LOG_LIMIT);
  saveModData();
  notifyOwners();
}

function sanitizePlayer(playerId, payload = {}, existing = {}) {
  const adminFlags = {
    ...(existing.adminFlags || {}),
    ...(payload.adminFlags || {}),
  };

  return {
    ...existing,
    ...payload,
    id: playerId,
    deviceId: payload.deviceId ?? existing.deviceId ?? null,
    deviceFingerprint: payload.deviceFingerprint ?? existing.deviceFingerprint ?? null,
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
    frozen: payload.frozen ?? existing.frozen ?? false,
    adminFlags: {
      invisible: !!adminFlags.invisible,
      godMode: !!adminFlags.godMode,
    },
    emote: {
      activePose:    clampText(payload.emote?.activePose    || existing.emote?.activePose    || '', 32) || null,
      idleStyle:     clampText(payload.emote?.idleStyle     || existing.emote?.idleStyle     || '', 32) || 'normal',
      walkStyle:     clampText(payload.emote?.walkStyle     || existing.emote?.walkStyle     || '', 32) || 'normal',
      runStyle:      clampText(payload.emote?.runStyle      || existing.emote?.runStyle      || '', 32) || 'normal',
      triggeredExpr: clampText(payload.emote?.triggeredExpr || existing.emote?.triggeredExpr || '', 32) || null,
    },
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

    if (player.adminFlags?.invisible) {
      broadcast('player_respawn', { player }, null, (client) => !!client.isOwner);
    } else {
      broadcast('player_respawn', { player });
    }
  }, RESPAWN_MS);

  respawnTimers.set(playerId, handle);
}

function handleOwnerAction(ws, payload = {}) {
  const action = clampText(payload.action, 48);
  const targetDeviceId = safeId(payload.targetDeviceId);
  const targetUser = targetDeviceId ? MOD_DATA.users[targetDeviceId] : null;

  const ownerPlayer = players.get(ws.playerId) || null;
  const targetPlayer = targetUser?.currentPlayerId ? players.get(targetUser.currentPlayerId) : null;
  const targetSocket = targetUser?.currentPlayerId ? getSocketByPlayerId(targetUser.currentPlayerId) : null;

  switch (action) {
    case 'teleport_to': {
      if (ownerPlayer && targetPlayer?.position) {
        sendJson(ws, 'admin_force_teleport', {
          position: targetPlayer.position,
        });
      }
      break;
    }

    case 'teleport_to_me': {
      if (ownerPlayer?.position && targetSocket) {
        sendJson(targetSocket, 'admin_force_teleport', {
          position: ownerPlayer.position,
        });
      }
      break;
    }

    case 'freeze_toggle': {
      if (!targetUser) break;

      targetUser.frozen = !targetUser.frozen;

      if (targetPlayer) {
        targetPlayer.frozen = targetUser.frozen;
        targetPlayer.velocity = { x: 0, y: 0, z: 0 };
      }

      if (targetSocket) {
        sendJson(targetSocket, 'admin_freeze_state', {
          frozen: targetUser.frozen,
          by: ownerPlayer?.name || 'Owner',
        });
      }

      saveModData();
      notifyOwners();
      break;
    }

    case 'kill': {
      if (targetSocket) {
        sendJson(targetSocket, 'admin_kill', {
          reason: 'Owner action',
        });
      }
      break;
    }

    case 'warn': {
      if (!targetUser) break;

      const reason = clampText(payload.reason, 240);
      const warning = {
        text: reason,
        createdAt: Date.now(),
        by: ownerPlayer?.name || 'Owner',
      };

      if (!Array.isArray(targetUser.warnings)) {
        targetUser.warnings = [];
      }

      targetUser.warnings.push(warning);
      targetUser.warnings = targetUser.warnings.slice(-MAX_WARNINGS_SAVED);

      if (targetSocket) {
        sendJson(targetSocket, 'admin_warning', {
          text: reason,
          totalWarnings: targetUser.warnings.length,
          at: warning.createdAt,
        });
      }

      saveModData();
      notifyOwners();
      break;
    }

    case 'ban': {
      if (!targetUser) break;

      const reason = clampText(payload.reason, 240);
      const durationMs = Math.max(1000, Math.min(Number(payload.durationMs) || 0, MAX_BAN_MS));
      const until = Date.now() + durationMs;

      targetUser.ban = {
        reason,
        createdAt: Date.now(),
        until,
        by: ownerPlayer?.name || 'Owner',
      };

      targetUser.frozen = false;
      saveModData();
      notifyOwners();

      if (targetSocket) {
        sendJson(targetSocket, 'banned_kick', {
          ban: serializeBan(targetUser.ban),
        });

        setTimeout(() => {
          try {
            targetSocket.close();
          } catch {}
        }, 150);
      }

      break;
    }

    case 'unban': {
      if (!targetUser) break;
      targetUser.ban = null;
      saveModData();
      notifyOwners();

      if (targetSocket) {
        sendJson(targetSocket, 'ban_status', { ban: null });
      }
      break;
    }
  }
}

wss.on('connection', (ws) => {
  const playerId = crypto.randomUUID();
  ws.playerId = playerId;
  ws.isOwner = false;
  ws.deviceId = null;
  ws.deviceFingerprint = null;

  sendJson(ws, 'welcome', {
    playerId,
    players: listVisiblePlayersFor(ws),
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const { type, payload = {} } = message;

    switch (type) {
      case 'owner_auth': {
        const password = String(payload.password ?? '');
        const deviceId = safeId(payload.deviceId);
        const fingerprint = safeId(payload.fingerprint);

        if (!deviceId) {
          sendJson(ws, 'owner_auth_result', {
            ok: false,
            message: 'Missing device id.',
          });
          break;
        }

        if (hashText(password) !== OWNER_PASSWORD_HASH) {
          sendJson(ws, 'owner_auth_result', {
            ok: false,
            message: 'Wrong password.',
          });
          break;
        }

        if (MOD_DATA.meta.ownerDeviceId && MOD_DATA.meta.ownerDeviceId !== deviceId) {
          sendJson(ws, 'owner_auth_result', {
            ok: false,
            message: 'This device is not the bound owner device.',
          });
          break;
        }

        if (!MOD_DATA.meta.ownerDeviceId) {
          MOD_DATA.meta.ownerDeviceId = deviceId;
        }

        ws.isOwner = true;
        ws.deviceId = deviceId;
        ws.deviceFingerprint = fingerprint;

        const registryUser = ensureRegistryUser({
          deviceId,
          fingerprint,
          name: players.get(playerId)?.name || 'Owner',
        });

        if (registryUser) {
          registryUser.ownerTrusted = true;
        }

        saveModData();

        sendJson(ws, 'owner_auth_result', {
          ok: true,
          message: 'Owner panel unlocked.',
          state: buildOwnerState(),
        });

        notifyOwners();
        break;
      }

      case 'owner_state_request': {
        if (!ws.isOwner) break;
        sendJson(ws, 'owner_state', buildOwnerState());
        break;
      }

      case 'owner_self_flags': {
        if (!ws.isOwner) break;

        const existing = players.get(playerId);
        if (!existing) break;

        const wasInvisible = !!existing.adminFlags?.invisible;
        const nextInvisible = !!payload.invisible;
        const nextGodMode = !!payload.godMode;

        existing.adminFlags = {
          ...(existing.adminFlags || {}),
          invisible: nextInvisible,
          godMode: nextGodMode,
        };

        players.set(playerId, existing);

        if (!wasInvisible && nextInvisible) {
          broadcast('player_left', { playerId }, ws, (client) => !client.isOwner);
        } else if (wasInvisible && !nextInvisible) {
          broadcast('player_joined', { player: existing }, ws);
        }

        sendJson(ws, 'owner_self_state', {
          invisible: nextInvisible,
          godMode: nextGodMode,
        });

        break;
      }

      case 'owner_action': {
        if (!ws.isOwner) break;
        handleOwnerAction(ws, payload);
        break;
      }

            case 'owner_map_save': {
        if (!ws.isOwner) break;
        MAP_STATE.draft = sanitizeMapState(payload.state || {});
        saveMapState();
        sendJson(ws, 'owner_map_saved', {
          savedAt: MAP_STATE.draft.savedAt,
        });
        break;
      }

      case 'owner_map_publish': {
        if (!ws.isOwner) break;

        const next = sanitizeMapState(payload.state || {});
        next.revision = Number(MAP_STATE.published?.revision || 0) + 1;
        next.publishedAt = Date.now();
        MAP_STATE.published = next;
        MAP_STATE.draft = next;
        saveMapState();

        broadcast('map_force_reload', {
          state: MAP_STATE.published,
          revision: MAP_STATE.published.revision,
          publishedAt: MAP_STATE.published.publishedAt,
          message: 'New Map Update!',
        });

        sendJson(ws, 'owner_map_saved', {
          savedAt: MAP_STATE.published.savedAt,
          publishedAt: MAP_STATE.published.publishedAt,
          revision: MAP_STATE.published.revision,
        });
        break;
      }

      case 'hello':
      case 'player_state': {
        const deviceId = safeId(payload.deviceId);
        const fingerprint = safeId(payload.deviceFingerprint);

        ws.deviceId = deviceId || ws.deviceId;
        ws.deviceFingerprint = fingerprint || ws.deviceFingerprint;

        const matchedBan = getActiveBanMatch(ws.deviceId, ws.deviceFingerprint);
        if (matchedBan) {
          sendJson(ws, 'ban_status', {
            ban: serializeBan(matchedBan.ban),
          });

          setTimeout(() => {
            try {
              ws.close();
            } catch {}
          }, 100);

          break;
        }

        const existing = players.get(playerId) || {};
        const player = sanitizePlayer(playerId, payload, existing);

        if (existing.dead) {
          player.dead = true;
          player.respawnAt = existing.respawnAt ?? null;
        }

        const registryChanged = syncRegistryUser({
          deviceId: player.deviceId,
          fingerprint: player.deviceFingerprint,
          name: player.name,
          playerId,
          online: true,
        });

        const registryUser = player.deviceId ? MOD_DATA.users[player.deviceId] : null;
        if (registryUser?.frozen) {
          player.frozen = true;
          player.position = existing.position ?? player.position;
          player.velocity = { x: 0, y: 0, z: 0 };
        }

        players.set(playerId, player);

        if (type === 'hello') {
          if (player.adminFlags?.invisible) {
            broadcast('player_joined', { player }, ws, (client) => !!client.isOwner);
          } else {
            broadcast('player_joined', { player }, ws);
          }

          sendJson(ws, 'admin_freeze_state', {
            frozen: !!player.frozen,
          });

          if (registryChanged) {
            saveModData();
            notifyOwners();
          }
        } else {
          if (player.adminFlags?.invisible) {
            broadcast('player_state', { player }, ws, (client) => !!client.isOwner);
          } else {
            broadcast('player_state', { player }, ws);
          }

          if (registryChanged) {
            saveModData();
            notifyOwners();
          }
        }

        break;
      }

      case 'player_cast': {
        const current = players.get(playerId);
        const castPayload = {
          playerId,
          ...payload,
          at: Date.now(),
        };

        if (current?.adminFlags?.invisible) {
          broadcast('player_cast', castPayload, ws, (client) => !!client.isOwner);
        } else {
          broadcast('player_cast', castPayload, ws);
        }
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

        const deathPayload = {
          playerId,
          player,
          reason: payload.reason || 'defeated',
          respawnAt,
        };

        if (player.adminFlags?.invisible) {
          broadcast('player_died', deathPayload, null, (client) => !!client.isOwner);
        } else {
          broadcast('player_died', deathPayload);
        }
        break;
      }

      case 'chat_public': {
        const sender = players.get(playerId);
        const entry = {
          kind: 'public',
          from: playerId,
          name: sender?.name ?? 'Wizard',
          senderId: playerId,
          sender: sender?.name ?? 'Wizard',
          text: clampText(payload.text, 300),
          at: Date.now(),
        };

        pushChatLog(entry);
        broadcast('chat_public', entry, ws);
        break;
      }

      case 'chat_private': {
        const sender = players.get(playerId);
        const targetId = payload.to;

        if (targetId) {
          const entry = {
            kind: 'private',
            from: playerId,
            to: targetId,
            name: sender?.name ?? 'Wizard',
            text: clampText(payload.text, 300),
            at: Date.now(),
          };

          pushChatLog(entry);

          sendToPlayer(targetId, 'chat_private', {
            from: playerId,
            name: sender?.name ?? 'Wizard',
            senderId: playerId,
            sender: sender?.name ?? 'Wizard',
            text: entry.text,
            at: entry.at,
          });
        }
        break;
      }

      case 'voice_ready': {
        broadcast('voice_ready', { playerId }, ws);
        break;
      }

      case 'voice_offer': {
        sendToPlayer(payload.to, 'voice_offer', {
          from: playerId,
          sdp: payload.sdp,
        });
        break;
      }

      case 'voice_answer': {
        sendToPlayer(payload.to, 'voice_answer', {
          from: playerId,
          sdp: payload.sdp,
        });
        break;
      }

      case 'voice_ice': {
        sendToPlayer(payload.to, 'voice_ice', {
          from: playerId,
          candidate: payload.candidate,
        });
        break;
      }

      case 'voice_speaking': {
        broadcast('voice_speaking', {
          playerId,
          speaking: !!payload.speaking,
        }, ws);
        break;
      }

      case 'time_sync': {
        // Relay one player's current game clock to all others for shared day/night.
        // The client already sends this every 10 seconds; server just forwards it.
        const gameTime = Number(payload.gameTime);
        if (Number.isFinite(gameTime) && gameTime >= 0 && gameTime < 24) {
          broadcast('time_sync', { gameTime }, ws);
        }
        break;
      }

      case 'player_report': {
        const reporter = players.get(playerId);
        const report = {
          kind:         'report',
          from:         playerId,
          reporterName: clampText(payload.reporterName, 80) || reporter?.name || 'Unknown',
          targetId:     safeId(payload.targetId) || '',
          targetName:   clampText(payload.targetName, 80),
          reportType:   clampText(payload.reportType, 80),
          description:  clampText(payload.description, 500),
          at:           Date.now(),
        };

        // Log it alongside chat so it appears in owner panel logs
        MOD_DATA.chatLogs.push(report);
        MOD_DATA.chatLogs = MOD_DATA.chatLogs.slice(-CHAT_LOG_LIMIT);
        saveModData();
        notifyOwners();
        break;
      }
    }
  });

  ws.on('close', () => {
    clearRespawnTimer(playerId);

    const existing = players.get(playerId);
    if (existing?.deviceId) {
      const changed = syncRegistryUser({
        deviceId: existing.deviceId,
        fingerprint: existing.deviceFingerprint,
        name: existing.name,
        playerId: null,
        online: false,
      });

      if (changed) {
        saveModData();
        notifyOwners();
      }
    }

    players.delete(playerId);
    broadcast('player_left', { playerId });
  });
});

server.listen(PORT, () => {
  console.log(`War of the Mages running on port ${PORT}`);
});
