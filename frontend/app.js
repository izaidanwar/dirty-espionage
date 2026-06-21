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

// Player count selector
let selectedMaxPlayers = 3;

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
  // No longer uses header profile chip - nickname shown in dashboard pill
}

function wsUrl() {
  const configured = (window.BACKEND_URL || "").trim();
  const base = configured || "https://dirty-espionage-production.up.railway.app";
  const normalized = base.replace(/\/+$/, "");

  // Accept either full URLs or plain hostnames.
  const isHttp = /^https?:\/\//i.test(normalized);
  const isWs = /^wss?:\/\//i.test(normalized);
  const raw = isHttp || isWs ? normalized : `https://${normalized}`;

  const url = new URL(raw);
  const protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.protocol = protocol;
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/ws";
  } else if (!url.pathname.endsWith("/ws")) {
    url.pathname = url.pathname.replace(/\/+$/, "") + "/ws";
  }
  return url.toString();
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
  const allAliases = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
  const activeAliases = allAliases.slice(0, selectedMaxPlayers);
  for (const alias of activeAliases) {
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
  if ($("lobbyNeeded")) $("lobbyNeeded").textContent = String(data.needed || selectedMaxPlayers);
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
  // Enable start button only for the actual host.
  const startBtn = $("startGameBtn");
  if (startBtn) {
    const isHostNow = data.isHost ?? (waiting.length > 0 && waiting[0]?.id === playerId);
    const enoughPlayers = waiting.length >= (data.needed || selectedMaxPlayers || 3);
    startBtn.disabled = !(isHostNow && enoughPlayers);
  }
}

function updateTurnUI() {
  const isFreeChat = phase === "FREE_CHAT";
  const input = $("sentenceInput");
  const submit = $("submitBtn");
  const readyToVote = $("readyToVoteBtn");
  const banner = $("turnBanner");
  const panel = $("inputPanel");
  const roundLabel = $("roundLabel");

  // In free chat mode, input is always enabled
  submit.disabled = false;
  readyToVote.disabled = false;
  roundLabel.textContent = phase === "FREE_CHAT" ? `[R${currentRound}/5]` : "";

  // Visual indication for input state
  input.style.opacity = "1";

  panel.classList.toggle("pulse-active", isFreeChat);

  if (phase === "FREE_CHAT") {
    banner.className = "turn-banner active";
    banner.textContent = "Free Chat — Discuss and write sentences freely!";
    setTimeout(() => input.focus(), 100);
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

function renderSuggestions(suggestions) {
  const container = $("suggestionList");
  if (!container) return;
  container.innerHTML = "";
  suggestions.forEach(suggestion => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.textContent = suggestion;
    container.appendChild(div);
  });
}

function updateVoteReadyStatus(readyCount, totalPlayers) {
  const readyToVoteBtn = $("readyToVoteBtn");
  if (!readyToVoteBtn) return;
  if (readyCount >= totalPlayers) {
    readyToVoteBtn.textContent = "All Ready — Starting Voting...";
    readyToVoteBtn.disabled = true;
  } else {
    readyToVoteBtn.textContent = `Go for Voting (${readyCount}/${totalPlayers})`;
  }
}

function handleRematchReady() {
  showScreen("lobby");
  phase = "LOBBY";
  history = [];
  hasVoted = false;
  showToast("Ready for rematch!");
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

  // Show rematch button for host
  const rematchBtn = $("rematchBtn");
  if (rematchBtn) {
    rematchBtn.style.display = "block";
  }

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
    if (mode === "create") send({ type: "create_room", maxPlayers: selectedMaxPlayers, ...payload });
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
    showToast("Unable to reach the game server. Check the backend URL and try again.");
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

    case "suggestion_prompts":
      renderSuggestions(data.suggestions || []);
      break;

    case "vote_ready_update":
      updateVoteReadyStatus(data.readyCount, data.totalPlayers);
      break;

    case "rematch_ready":
      handleRematchReady();
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
      const maxPlayers = data.needed || selectedMaxPlayers || 3;
      $("voteProgress").textContent = `Votes: 0 / ${maxPlayers}`;
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
  console.log("Onboard form submitted");
  const name = $("usernameInput").value.trim();
  console.log("Name entered:", name);
  if (!name) {
    console.log("Name is empty, returning");
    return;
  }
  saveProfile(name);
  updateProfileChip();
  $("dashboardName").textContent = realName;
  showScreen("dashboard");
  console.log("AudioEngine:", AudioEngine);
  if (AudioEngine && AudioEngine.unlock) {
    AudioEngine.unlock();
  }
});

$("createRoomBtn").addEventListener("click", () => {
  // Read selected player count
  const activeCountBtn = document.querySelector(".count-btn.active");
  selectedMaxPlayers = activeCountBtn ? parseInt(activeCountBtn.dataset.count) : 3;
  connect("create");
  showScreen("lobby");
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

$("readyToVoteBtn").addEventListener("click", () => {
  send({ type: "ready_to_vote" });
});

$("rematchBtn").addEventListener("click", () => {
  send({ type: "rematch" });
});

$("backDashboardBtn").addEventListener("click", () => {
  showScreen("dashboard");
  setStatus(false, "Offline");
});

// --- Player Count Selector ---
document.querySelectorAll(".count-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".count-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedMaxPlayers = parseInt(btn.dataset.count);
  });
});

// --- Game Rules Modal ---
function openRulesModal() {
  $("rulesModal").classList.remove("hidden");
}
function closeRulesModal() {
  $("rulesModal").classList.add("hidden");
}
$("rulesBtnOnboard")?.addEventListener("click", openRulesModal);
$("rulesBtnDashboard")?.addEventListener("click", openRulesModal);
$("closeRulesBtn")?.addEventListener("click", closeRulesModal);
$("rulesModal")?.addEventListener("click", (e) => {
  if (e.target === $("rulesModal")) closeRulesModal();
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
