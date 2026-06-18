/**
 * Dirty Espionage v2 — onboarding, rooms, reconnect, cyberpunk UI
 */

const STORAGE = {
  playerId: "de_playerId",
  realName: "de_realName",
  roomCode: "de_roomCode",
  disconnectedAt: "de_disconnectedAt",
};

const RECONNECT_WINDOW_MS = 60_000;
const $ = (id) => document.getElementById(id);

// DOM
const profileChip = $("profileChip");
const profileName = $("profileName");
const statusDot = $("statusDot");
const statusText = $("statusText");
const muteBtn = $("muteBtn");
const screenOnboard = $("screenOnboard");
const screenDashboard = $("screenDashboard");
const screenLobby = $("screenLobby");
const screenGame = $("screenGame");
const screenVoting = $("screenVoting");
const screenResults = $("screenResults");
const decryptOverlay = $("decryptOverlay");
const decryptCount = $("decryptCount");
const decryptBar = $("decryptBar");
const toastEl = $("toast");

let socket = null;
let playerId = null;
let realName = "";
let roomCode = "";
let phase = "ONBOARD";
let inRoom = false;
let isHost = false;
let players = [];
let currentPlayerId = null;
let currentRound = 1;
let history = [];
let groupedHistory = {};
let hasVoted = false;
let myWord = "";
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let turnTimerInterval = null;
let lastTickSecond = -1;
let typingDebounce = null;

// --- Storage ---
function loadProfile() {
  playerId = localStorage.getItem(STORAGE.playerId);
  if (!playerId) {
    playerId = crypto.randomUUID();
    localStorage.setItem(STORAGE.playerId, playerId);
  }
  realName = localStorage.getItem(STORAGE.realName) || "";
  roomCode = localStorage.getItem(STORAGE.roomCode) || "";
}

function saveProfile(name) {
  realName = name.trim().slice(0, 32);
  localStorage.setItem(STORAGE.realName, realName);
}

function saveRoomCode(code) {
  roomCode = code;
  if (code) localStorage.setItem(STORAGE.roomCode, code);
  else localStorage.removeItem(STORAGE.roomCode);
}

function markDisconnected() {
  localStorage.setItem(STORAGE.disconnectedAt, String(Date.now()));
}

function clearDisconnected() {
  localStorage.removeItem(STORAGE.disconnectedAt);
}

function canReconnect() {
  const at = Number(localStorage.getItem(STORAGE.disconnectedAt) || 0);
  return roomCode && at && Date.now() - at < RECONNECT_WINDOW_MS;
}

// --- UI helpers ---
function setStatus(on, label) {
  statusDot.classList.toggle("on", on);
  statusText.textContent = label;
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 3200);
}

function showScreen(name) {
  const map = {
    onboard: screenOnboard,
    dashboard: screenDashboard,
    lobby: screenLobby,
    game: screenGame,
    voting: screenVoting,
    results: screenResults,
  };
  Object.entries(map).forEach(([k, el]) => el.classList.toggle("hidden", k !== name));
}

function updateProfileChip() {
  if (realName) {
    profileChip.classList.remove("hidden");
    profileName.textContent = realName;
  }
}

function wsUrl() {
  const p = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${p}//${window.location.host}/ws`;
}

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t;
  return d.innerHTML;
}

// --- Render ---
function renderTerminalFeed(target, items) {
  target.innerHTML = "";
  if (!items?.length) {
    target.innerHTML = '<p class="muted">// awaiting transmissions…</p>';
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "feed-line";
    const cls = item.skipped ? "skipped" : "";
    row.innerHTML = `
      <div class="meta">R${item.round} · ${escapeHtml(item.alias)}</div>
      <div class="${cls}">${escapeHtml(item.text)}</div>
    `;
    target.appendChild(row);
  }
  target.scrollTop = target.scrollHeight;
}

function renderGroupedHistory(target, groups) {
  target.innerHTML = "";
  const aliases = ["Alpha", "Bravo", "Charlie"];
  for (const alias of aliases) {
    const col = document.createElement("div");
    col.className = "alias-col";
    const color = players.find((p) => p.alias === alias)?.color || "var(--cyan)";
    col.innerHTML = `<h3 style="color:${color}">${alias}</h3>`;
    const ul = document.createElement("ul");
    const items = groups?.[alias] || [];
    if (!items.length) {
      ul.innerHTML = "<li class='muted'>—</li>";
    } else {
      for (const s of items) {
        const li = document.createElement("li");
        li.innerHTML = `<span class="muted">R${s.round}:</span> ${escapeHtml(s.text)}`;
        ul.appendChild(li);
      }
    }
    col.appendChild(ul);
    target.appendChild(col);
  }
}

function renderLobby(data) {
  phase = "LOBBY";
  showScreen("lobby");
  $("roomCodeLabel").textContent = data.roomCode || roomCode;
  $("lobbyCount").textContent = String(data.count ?? 0);
  console.log("renderLobby called with:", data);
  const list = $("lobbyList");
  list.innerHTML = "";
  const waiting = data.waiting || data.roster || [];
  if (!waiting.length) {
    list.innerHTML = "<li class='muted'>Waiting for operatives…</li>";
  } else {
    for (const p of waiting) {
      const li = document.createElement("li");
      const name = p.realName || p.alias || "?";
      const offline = p.connected === false ? " offline" : "";
      li.className = offline;
      li.textContent = p.id === playerId ? `${name} (you)` : name;
      list.appendChild(li);
    }
  }
  // Enable start button if host and enough players
  const startBtn = $("startGameBtn");
  if (startBtn) {
    const isHost = waiting.length > 0 && waiting[0]?.id === playerId;
    const enoughPlayers = waiting.length >= 3;
    startBtn.disabled = !(isHost && enoughPlayers);
  }
}

function updateTurnUI() {
  const isMyTurn = currentPlayerId === playerId && phase === "ROUND_LOOP";
  const current = players.find((p) => p.id === currentPlayerId);
  const input = $("sentenceInput");
  const submit = $("submitBtn");
  const skip = $("skipBtn");
  const banner = $("turnBanner");
  const panel = $("inputPanel");
  const roundLabel = $("roundLabel");

  // Don't disable input on mobile - prevent submission instead
  submit.disabled = !isMyTurn;
  skip.disabled = !isMyTurn;
  roundLabel.textContent = phase === "ROUND_LOOP" ? `[R${currentRound}/5]` : "";

  // Visual indication for input state
  if (!isMyTurn) {
    input.style.opacity = "0.5";
  } else {
    input.style.opacity = "1";
  }

  panel.classList.toggle("pulse-active", isMyTurn);

  if (phase !== "ROUND_LOOP") {
    banner.className = "turn-banner";
    return;
  }

  if (isMyTurn) {
    banner.className = "turn-banner active";
    banner.textContent = "YOUR TURN — transmit one sentence.";
    setTimeout(() => input.focus(), 100);
  } else if (current) {
    banner.className = "turn-banner";
    banner.textContent = `Awaiting ${current.alias}'s transmission…`;
  } else {
    banner.className = "turn-banner";
    banner.textContent = "Stand by…";
  }
}

function startTurnTimer(deadline) {
  stopTurnTimer();
  const fill = $("timerFill");
  const text = $("timerText");
  const wrap = $("timerWrap");

  function tick() {
    const remaining = Math.max(0, deadline - Date.now() / 1000);
    const pct = (remaining / 30) * 100;
    fill.style.strokeDasharray = `${pct}, 100`;
    const sec = Math.ceil(remaining);
    text.textContent = String(sec);

    fill.classList.toggle("danger", sec <= 5);
    $("turnBanner").classList.toggle("urgent", sec <= 5 && currentPlayerId === playerId);

    if (sec <= 5 && sec !== lastTickSecond) {
      lastTickSecond = sec;
      if (currentPlayerId === playerId) AudioEngine.heartbeat();
      else AudioEngine.tick();
    } else if (sec > 5 && sec !== lastTickSecond) {
      lastTickSecond = sec;
    }

    if (remaining <= 0) stopTurnTimer();
  }

  wrap.classList.remove("hidden");
  tick();
  turnTimerInterval = setInterval(tick, 200);
}

function stopTurnTimer() {
  if (turnTimerInterval) clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  lastTickSecond = -1;
}

function renderVoteButtons() {
  const container = $("voteButtons");
  container.innerHTML = "";
  for (const p of players) {
    if (p.id === playerId) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-vote";
    btn.disabled = hasVoted;
    btn.innerHTML = `<span class="alias-dot" style="background:${p.color}"></span> Accuse <strong>${p.alias}</strong>`;
    btn.addEventListener("click", () => {
      if (hasVoted) return;
      hasVoted = true;
      container.querySelectorAll(".btn-vote").forEach((b) => (b.disabled = true));
      btn.classList.add("selected");
      send({ type: "cast_vote", targetId: p.id });
      AudioEngine.click();
      showToast(`Vote locked on ${p.alias}`);
    });
    container.appendChild(btn);
  }
}

function showDecryptCountdown(seconds, onDone) {
  decryptOverlay.classList.remove("hidden");
  let left = seconds;
  decryptCount.textContent = String(left);
  decryptBar.style.width = "0%";
  setTimeout(() => { decryptBar.style.width = "100%"; }, 50);

  const iv = setInterval(() => {
    AudioEngine.decryptTick();
    left -= 1;
    if (left > 0) decryptCount.textContent = String(left);
    else {
      clearInterval(iv);
      decryptOverlay.classList.add("hidden");
      onDone();
    }
  }, 1000);
}

function revealResultCards(data) {
  showScreen("results");
  $("pairReveal").textContent =
    `PAIR: "${data.wordPair.normal}" vs "${data.wordPair.dirty}" — Agents held the ${data.agentsHadDirtyWord ? "dirty" : "normal"} word.`;

  const grid = $("resultGrid");
  grid.innerHTML = "";

  if (data.imposterWon) AudioEngine.glitch();
  else if (data.players.some((p) => p.id === playerId && p.score === 2)) AudioEngine.chime();

  for (const p of data.players) {
    const card = document.createElement("div");
    card.className = "flip-card";
    const isMe = p.id === playerId;
    card.innerHTML = `
      <div class="flip-inner">
        <div class="flip-front">${p.alias}</div>
        <div class="flip-back ${p.role}">
          <strong style="color:${p.color}">${p.alias}</strong>
          ${isMe ? `<span class="muted small"> (${p.realName || "you"})</span>` : ""}
          <div class="role-tag muted small" style="margin-top:0.35rem">${p.role.toUpperCase()}</div>
          <div class="small" style="margin-top:0.25rem">Word: ${escapeHtml(p.word)}</div>
          <div class="small muted">Votes: ${p.votesReceived}</div>
          <span class="score-badge score-${p.score}">${p.score} PTS</span>
        </div>
      </div>
    `;
    grid.appendChild(card);
    setTimeout(() => card.classList.add("revealed"), 400 + Math.random() * 600);
  }

  const vb = $("voteBreakdown");
  vb.innerHTML = "";
  for (const v of data.votes) {
    const line = document.createElement("div");
    line.className = "feed-line";
    line.textContent = `${v.voterAlias} → ${v.targetAlias}`;
    vb.appendChild(line);
  }

  groupedHistory = data.groupedHistory || {};
  renderGroupedHistory($("groupedHistoryResults"), groupedHistory);
}

// --- WebSocket ---
function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ playerId, realName, ...payload }));
  }
}

function connect(mode, code = "") {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close();
  }

  setStatus(false, "Connecting…");
  socket = new WebSocket(wsUrl());

  // Add connection timeout for mobile devices
  const connectionTimeout = setTimeout(() => {
    if (socket.readyState !== WebSocket.OPEN) {
      socket.close();
      setStatus(false, "Connection timed out. Check your network.");
      showToast("Connection timed out. Try again.");
    }
  }, 15000); // 15 second timeout for mobile

  socket.addEventListener("open", () => {
    clearTimeout(connectionTimeout);
    reconnectDelayMs = 1000;
    clearDisconnected();
    setStatus(true, "Connected");
    AudioEngine.unlock();
    AudioEngine.startAmbient();

    const payload = { playerId, realName };
    if (mode === "create") send({ type: "create_room", ...payload });
    else if (mode === "join") send({ type: "join_room", roomCode: code.toUpperCase(), ...payload });
    else if (mode === "reconnect") send({ type: "reconnect", roomCode: code.toUpperCase(), ...payload });
  });

  socket.addEventListener("message", (e) => {
    try { handleMessage(JSON.parse(e.data)); }
    catch { showToast("Bad server message"); }
  });

  socket.addEventListener("close", () => {
    clearTimeout(connectionTimeout);
    setStatus(false, "Reconnecting…");
    if (inRoom) markDisconnected();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    clearTimeout(connectionTimeout);
    setStatus(false, "Connection error");
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !inRoom) return;
  if (!canReconnect()) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.5, 10000);
    connect("reconnect", roomCode);
  }, reconnectDelayMs);
}

function leaveRoom() {
  send({ type: "leave_room" });
  inRoom = false;
  saveRoomCode("");
  stopTurnTimer();
  if (socket) socket.close();
  socket = null;
  showScreen("dashboard");
  setStatus(false, "Offline");
}

function handleMessage(data) {
  console.log("Received message:", data.type, data);
  switch (data.type) {
    case "connected":
      inRoom = true;
      if (data.playerId) {
        playerId = data.playerId;
      }
      if (data.roomCode) {
        roomCode = data.roomCode;
        saveRoomCode(data.roomCode);
        $("roomCodeLabel").textContent = data.roomCode;
      }
      break;

    case "room_joined":
    case "lobby_update":
      isHost = data.isHost ?? isHost;
      if (data.roomCode) {
        roomCode = data.roomCode;
        saveRoomCode(data.roomCode);
      }
      if (data.roster) players = data.roster;
      if (data.waiting) players = data.waiting;
      // Update alias if in game
      if (data.phase && data.phase !== "LOBBY") {
        const myPlayer = players.find((p) => p.id === playerId);
        if (myPlayer && myPlayer.alias) {
          $("myAlias").textContent = myPlayer.alias;
        }
      }
      renderLobby(data);
      break;

    case "reconnected":
      showToast("Reconnected to active match.");
      break;

    case "game_start":
      phase = data.phase;
      players = data.players || [];
      history = [];
      hasVoted = false;
      console.log("game_start received:", { playerId, players });
      const myPlayer = players.find((p) => p.id === playerId);
      if (myPlayer && myPlayer.alias) {
        $("myAlias").textContent = myPlayer.alias;
        console.log("Alias set:", myPlayer.alias);
      } else {
        console.log("Player not found in roster:", { playerId, players });
        $("myAlias").textContent = "Unknown";
      }
      showScreen("game");
      renderTerminalFeed($("history"), history);
      updateTurnUI();
      break;

    case "your_word":
      myWord = data.word || "";
      $("secretWord").textContent = myWord;
      // Also try to set alias from players array if not set
      if ($("myAlias").textContent === "—" || $("myAlias").textContent === "Unknown") {
        const myPlayer = players.find((p) => p.id === playerId);
        if (myPlayer && myPlayer.alias) {
          $("myAlias").textContent = myPlayer.alias;
        }
      }
      break;

    case "turn_update":
      phase = data.phase;
      currentPlayerId = data.currentPlayerId;
      currentRound = data.round;
      // Update alias if not set
      if ($("myAlias").textContent === "—" || $("myAlias").textContent === "Loading...") {
        const myPlayer = players.find((p) => p.id === playerId);
        if (myPlayer && myPlayer.alias) {
          $("myAlias").textContent = myPlayer.alias;
        }
      }
      updateTurnUI();
      if (data.turnDeadline) startTurnTimer(data.turnDeadline);
      break;

    case "typing_update":
      if (data.isTyping && data.alias) {
        $("typingAlias").textContent = data.alias;
        $("typingIndicator").classList.remove("hidden");
      } else {
        $("typingIndicator").classList.add("hidden");
      }
      break;

    case "sentence_added":
      history = data.history || [];
      renderTerminalFeed($("history"), history);
      $("sentenceInput").value = "";
      $("charCount").textContent = "0";
      if (!data.sync) AudioEngine.click();
      updateTurnUI();
      break;

    case "turn_skipped":
      history = data.history || [];
      renderTerminalFeed($("history"), history);
      AudioEngine.alarm();
      showToast(`${data.alias} timed out.`);
      break;

    case "voting_start":
      phase = data.phase;
      players = data.players || [];
      history = data.history || [];
      groupedHistory = data.groupedHistory || {};
      hasVoted = !!data.alreadyVoted;
      stopTurnTimer();
      showScreen("voting");
      renderGroupedHistory($("groupedHistory"), groupedHistory);
      renderVoteButtons();
      $("voteProgress").textContent = "Votes: 0 / 3";
      break;

    case "vote_progress":
      $("voteProgress").textContent = `Votes: ${data.votesCast} / ${data.votesNeeded}`;
      break;

    case "reveal_countdown":
      showDecryptCountdown(data.seconds || 3, () => {});
      break;

    case "game_over":
      stopTurnTimer();
      inRoom = false;
      saveRoomCode("");
      decryptOverlay.classList.add("hidden");
      revealResultCards(data);
      break;

    case "player_left":
    case "player_disconnected":
      if (data.roster) renderLobby({ ...data, waiting: data.roster, roomCode });
      if (data.message) showToast(data.message);
      else if (data.type === "player_disconnected") {
        showToast(`Operative disconnected — ${data.reconnectSec}s to rejoin.`);
      }
      break;

    case "left_room":
      inRoom = false;
      saveRoomCode("");
      showScreen("dashboard");
      break;

    case "error":
      showToast(data.message || "Error");
      if (data.message?.includes("full")) AudioEngine.alarm();
      break;

    case "pong":
      break;
  }
}

// --- Events ---
$("onboardForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("usernameInput").value.trim();
  if (!name) return;
  saveProfile(name);
  updateProfileChip();
  $("dashboardName").textContent = realName;
  showScreen("dashboard");
  AudioEngine.unlock();
});

$("createRoomBtn").addEventListener("click", () => {
  connect("create");
  showScreen("lobby");
});

$("showJoinBtn").addEventListener("click", () => {
  $("joinForm").classList.toggle("hidden");
});

$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  let code = $("joinCodeInput").value.trim().toUpperCase();
  if (!code) return;
  if (!code.startsWith("ROOM-")) code = `ROOM-${code.replace(/^ROOM-?/, "")}`;
  connect("join", code);
  showScreen("lobby");
});

$("leaveRoomBtn").addEventListener("click", leaveRoom);
$("leaveRoomBtnVote")?.addEventListener("click", leaveRoom);

$("startGameBtn").addEventListener("click", () => {
  send({ type: "start_game" });
});

$("skipBtn").addEventListener("click", () => {
  send({ type: "skip_turn" });
});

$("backDashboardBtn").addEventListener("click", () => {
  showScreen("dashboard");
  setStatus(false, "Offline");
});

muteBtn.addEventListener("click", () => {
  const muted = AudioEngine.toggleMute();
  muteBtn.textContent = muted ? "🔇" : "🔊";
});

$("sentenceInput").addEventListener("input", () => {
  const len = $("sentenceInput").value.length;
  $("charCount").textContent = String(len);
  clearTimeout(typingDebounce);
  send({ type: "typing", isTyping: true });
  typingDebounce = setTimeout(() => send({ type: "typing", isTyping: false }), 800);
});

// Mobile: Ensure keyboard opens when tapping input
$("sentenceInput").addEventListener("click", (e) => {
  const isMyTurn = currentPlayerId === playerId && phase === "ROUND_LOOP";
  if (isMyTurn) {
    e.target.focus();
  }
});

$("sentenceForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("sentenceInput").value.trim();
  if (!text || currentPlayerId !== playerId) return;
  send({ type: "submit_sentence", text });
  send({ type: "typing", isTyping: false });
  AudioEngine.click();
  $("submitBtn").disabled = true;
  $("sentenceInput").value = "";
  $("charCount").textContent = "0";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && inRoom && canReconnect()) {
    connect("reconnect", roomCode);
  }
});
window.addEventListener("online", () => {
  if (inRoom && canReconnect()) connect("reconnect", roomCode);
});

setInterval(() => { if (socket?.readyState === WebSocket.OPEN) send({ type: "ping" }); }, 30000);

// --- Boot ---
loadProfile();
updateProfileChip();

if (realName) {
  $("dashboardName").textContent = realName;
  if (canReconnect()) {
    showScreen("lobby");
    connect("reconnect", roomCode);
  } else {
    showScreen("dashboard");
  }
} else {
  showScreen("onboard");
}
