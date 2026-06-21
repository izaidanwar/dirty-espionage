"""
Dirty Espionage — room management, persistence, and game state machine.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
import string
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)

ALIASES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
ALIAS_COLORS = ["#66FCF1", "#45A29E", "#ff2d6a", "#9B59B6", "#F39C12"]
MAX_PLAYERS = 3
MAX_ROUNDS = 1
MAX_SENTENCE_LEN = 150
TURN_TIMEOUT_SEC = 90
RECONNECT_WINDOW_SEC = 60
SENTENCE_PATTERN = re.compile(r"^[^.!?]+[.!?]$")
WORD_PAIRS_PATH = Path(__file__).resolve().parent / "word_pairs.json"


class Phase(str, Enum):
    LOBBY = "LOBBY"
    FREE_CHAT = "FREE_CHAT"
    VOTING = "VOTING"
    REVEAL_SCORING = "REVEAL_SCORING"


def load_word_pairs() -> list[dict[str, str]]:
    with WORD_PAIRS_PATH.open(encoding="utf-8") as fh:
        pairs = json.load(fh)
        random.shuffle(pairs)
        return pairs


def validate_sentence(text: str) -> tuple[bool, str]:
    cleaned = text.strip()
    if not cleaned:
        return False, "Sentence cannot be empty."
    if len(cleaned) > MAX_SENTENCE_LEN:
        return False, f"Maximum {MAX_SENTENCE_LEN} characters allowed."
    return True, ""


def calculate_scores(
    roles: dict[str, str],
    votes: dict[str, str],
    imposter_id: str,
    agent_ids: list[str],
) -> dict[str, int]:
    scores: dict[str, int] = {}
    imposter_votes = sum(1 for target in votes.values() if target == imposter_id)

    for agent_id in agent_ids:
        my_vote = votes.get(agent_id)
        # Count how many fellow agents also voted for the imposter
        fellow_correct = sum(
            1 for aid in agent_ids if aid != agent_id and votes.get(aid) == imposter_id
        )
        if my_vote == imposter_id and fellow_correct == len(agent_ids) - 1:
            scores[agent_id] = 2
        elif my_vote == imposter_id:
            scores[agent_id] = 1
        else:
            scores[agent_id] = 0

    if imposter_votes == 0:
        scores[imposter_id] = 2
    elif imposter_votes == 1:
        scores[imposter_id] = 1
    else:
        scores[imposter_id] = 0
    return scores


def generate_room_code() -> str:
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"ROOM-{suffix}"


@dataclass
class PlayerSlot:
    player_id: str
    real_name: str
    websocket: WebSocket | None = None
    round_alias: str = ""
    color: str = ""
    word: str = ""
    role: str = ""
    disconnected_at: float | None = None
    is_typing: bool = False

    @property
    def is_connected(self) -> bool:
        return self.websocket is not None


@dataclass
class SentenceRecord:
    player_id: str
    alias: str
    round_num: int
    text: str
    skipped: bool = False


@dataclass
class GameRoom:
    code: str
    host_id: str
    players: dict[str, PlayerSlot] = field(default_factory=dict)
    phase: Phase = Phase.LOBBY
    turn_order: list[str] = field(default_factory=list)
    current_turn_index: int = 0
    round_num: int = 1
    sentences: list[SentenceRecord] = field(default_factory=list)
    votes: dict[str, str] = field(default_factory=dict)
    word_pair: dict[str, str] = field(default_factory=dict)
    agents_get_dirty: bool = True
    imposter_id: str = ""
    turn_deadline: float = 0.0
    max_players: int = 3
    _timer_task: asyncio.Task[None] | None = field(default=None, repr=False)
    ready_to_vote: dict[str, bool] = field(default_factory=dict)
    empty_since: float | None = field(default=None, repr=False)

    def occupied_count(self) -> int:
        return len(self.players)

    def connected_count(self) -> int:
        return sum(1 for p in self.players.values() if p.is_connected)

    def lobby_roster(self) -> list[dict[str, str]]:
        return [
            {
                "id": p.player_id,
                "realName": p.real_name,
                "connected": p.is_connected,
            }
            for p in self.players.values()
        ]

    def game_roster(self) -> list[dict[str, str]]:
        return [
            {
                "id": p.player_id,
                "alias": p.round_alias,
                "color": p.color,
            }
            for p in self.players.values()
        ]

    def current_player_id(self) -> str | None:
        if not self.turn_order:
            return None
        return self.turn_order[self.current_turn_index % len(self.turn_order)]

    async def send(self, player_id: str, message: dict[str, Any]) -> None:
        player = self.players.get(player_id)
        if not player or not player.websocket:
            return
        try:
            await player.websocket.send_json(message)
        except Exception:
            player.websocket = None
            player.disconnected_at = time.time()

    async def broadcast(self, message: dict[str, Any]) -> None:
        for pid in list(self.players):
            await self.send(pid, message)

    def cancel_timer(self) -> None:
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = None

    def history_payload(self) -> list[dict[str, Any]]:
        return [
            {
                "playerId": s.player_id,
                "alias": s.alias,
                "round": s.round_num,
                "text": s.text,
                "skipped": s.skipped,
            }
            for s in self.sentences
        ]

    def turn_payload(self) -> dict[str, Any]:
        current = self.current_player_id()
        current_player = self.players.get(current) if current else None
        return {
            "type": "turn_update",
            "phase": self.phase.value,
            "round": self.round_num,
            "currentPlayerId": current,
            "currentAlias": current_player.round_alias if current_player else None,
            "turnNumber": len(self.sentences) + 1,
            "totalTurns": MAX_ROUNDS * self.max_players,
            "turnDeadline": self.turn_deadline,
            "turnTimeoutSec": TURN_TIMEOUT_SEC,
        }

    async def start_game(self) -> None:
        shuffled = list(self.players.keys())
        random.shuffle(shuffled)
        self.turn_order = shuffled

        for idx, pid in enumerate(shuffled):
            slot = self.players[pid]
            slot.round_alias = ALIASES[idx]
            slot.color = ALIAS_COLORS[idx]

        self.word_pair = random.choice(load_word_pairs())
        self.agents_get_dirty = random.choice([True, False])
        num_players = len(shuffled)
        imposter_index = random.randrange(num_players)
        self.imposter_id = shuffled[imposter_index]

        for pid in shuffled:
            slot = self.players[pid]
            if pid == self.imposter_id:
                slot.role = "imposter"
                slot.word = (
                    self.word_pair["normal"]
                    if self.agents_get_dirty
                    else self.word_pair["dirty"]
                )
            else:
                slot.role = "agent"
                slot.word = (
                    self.word_pair["dirty"]
                    if self.agents_get_dirty
                    else self.word_pair["normal"]
                )

        self.phase = Phase.FREE_CHAT
        self.round_num = 1
        self.current_turn_index = 0
        self.ready_to_vote = {}

        await self.broadcast(
            {
                "type": "game_start",
                "phase": self.phase.value,
                "roomCode": self.code,
                "players": self.game_roster(),
            }
        )
        for pid, slot in self.players.items():
            await self.send(pid, {"type": "your_word", "word": slot.word})

        # Send suggestion prompts
        suggestions = [
            "Is it an action or object?",
            "What color is it?",
            "What's the shape?",
            "Is it hard or soft?",
            "Is it big or small?",
            "Is it natural or man-made?"
        ]
        await self.broadcast({
            "type": "suggestion_prompts",
            "suggestions": suggestions
        })

    async def begin_turn(self) -> None:
        self.cancel_timer()
        self.turn_deadline = time.time() + TURN_TIMEOUT_SEC
        await self.broadcast(self.turn_payload())
        self._timer_task = asyncio.create_task(self._turn_timeout())

    async def _turn_timeout(self) -> None:
        try:
            await asyncio.sleep(TURN_TIMEOUT_SEC)
            if self.phase == Phase.ROUND_LOOP:
                await self.skip_current_turn()
        except asyncio.CancelledError:
            pass

    async def skip_current_turn(self) -> None:
        if self.phase != Phase.ROUND_LOOP:
            return
        current = self.current_player_id()
        if not current:
            return
        slot = self.players[current]
        record = SentenceRecord(
            player_id=current,
            alias=slot.round_alias,
            round_num=self.round_num,
            text="[TIMED OUT — NO SUBMISSION]",
            skipped=True,
        )
        self.sentences.append(record)
        await self.broadcast(
            {
                "type": "turn_skipped",
                "playerId": current,
                "alias": slot.round_alias,
                "history": self.history_payload(),
            }
        )
        await self.advance_turn()
        await self.broadcast(self.turn_payload())

    async def advance_turn(self) -> None:
        self.cancel_timer()
        self.current_turn_index += 1
        if self.current_turn_index % self.max_players == 0:
            self.round_num += 1
        if len(self.sentences) >= MAX_ROUNDS * self.max_players:
            await self.begin_voting()
        else:
            await self.begin_turn()

    async def handle_submit_sentence(self, player_id: str, text: str) -> None:
        if self.phase != Phase.FREE_CHAT:
            await self.send(player_id, {"type": "error", "message": "Not in free chat phase."})
            return
        valid, error = validate_sentence(text)
        if not valid:
            await self.send(player_id, {"type": "error", "message": error})
            return

        slot = self.players[player_id]
        self.sentences.append(
            SentenceRecord(
                player_id=player_id,
                alias=slot.round_alias,
                round_num=self.round_num,
                text=text.strip(),
            )
        )
        slot.is_typing = False
        await self.broadcast(
            {
                "type": "sentence_added",
                "playerId": player_id,
                "alias": slot.round_alias,
                "round": self.round_num,
                "text": text.strip(),
                "history": self.history_payload(),
            }
        )

    async def handle_typing(self, player_id: str, is_typing: bool) -> None:
        if self.phase != Phase.FREE_CHAT:
            return
        slot = self.players.get(player_id)
        if not slot:
            return
        slot.is_typing = is_typing
        alias = slot.round_alias if self.phase != Phase.LOBBY else None
        for pid, p in self.players.items():
            if pid == player_id or not p.is_connected:
                continue
            await self.send(
                pid,
                {
                    "type": "typing_update",
                    "alias": slot.round_alias,
                    "isTyping": is_typing,
                },
            )

    async def handle_ready_to_vote(self, player_id: str) -> None:
        if self.phase != Phase.FREE_CHAT:
            await self.send(player_id, {"type": "error", "message": "Not in free chat phase."})
            return
        if player_id not in self.players:
            return

        # Immediately start voting for this player
        await self.begin_voting_for_player(player_id)

    async def handle_rematch(self, player_id: str) -> None:
        if self.phase != Phase.REVEAL_SCORING:
            await self.send(player_id, {"type": "error", "message": "Game not over yet."})
            return
        if player_id != self.host_id:
            await self.send(player_id, {"type": "error", "message": "Only host can start rematch."})
            return

        # Reset game state for rematch
        self.phase = Phase.LOBBY
        self.sentences = []
        self.votes = {}
        self.ready_to_vote = {}
        self.round_num = 1
        self.current_turn_index = 0
        self.word_pair = {}
        self.agents_get_dirty = True
        self.imposter_id = ""

        # Reset player game state
        for slot in self.players.values():
            slot.role = ""
            slot.word = ""
            slot.round_alias = ""
            slot.color = ""

        await self.broadcast(
            {
                "type": "rematch_ready",
                "roomCode": self.code,
                "phase": self.phase.value,
                "players": self.lobby_roster(),
            }
        )

    async def begin_voting(self) -> None:
        self.cancel_timer()
        self.phase = Phase.VOTING
        await self.broadcast(
            {
                "type": "voting_start",
                "phase": self.phase.value,
                "players": self.game_roster(),
                "history": self.history_payload(),
                "groupedHistory": self.grouped_history(),
            }
        )

    async def begin_voting_for_player(self, player_id: str) -> None:
        # Notify all players that someone is ready to vote
        player = self.players.get(player_id)
        if player:
            await self.broadcast(
                {
                    "type": "player_ready_to_vote",
                    "playerId": player_id,
                    "playerAlias": player.alias,
                }
            )

        # Send voting start to this player only
        await self.send(
            player_id,
            {
                "type": "voting_start",
                "phase": Phase.VOTING.value,
                "players": self.game_roster(),
                "history": self.history_payload(),
                "groupedHistory": self.grouped_history(),
            }
        )

    def grouped_history(self) -> dict[str, list[dict[str, Any]]]:
        active_aliases = ALIASES[:self.max_players]
        groups: dict[str, list[dict[str, Any]]] = {a: [] for a in active_aliases}
        for s in self.sentences:
            groups.setdefault(s.alias, []).append(
                {"round": s.round_num, "text": s.text, "skipped": s.skipped}
            )
        return groups

    async def handle_cast_vote(self, player_id: str, target_id: str) -> None:
        if self.phase != Phase.VOTING and self.phase != Phase.FREE_CHAT:
            await self.send(player_id, {"type": "error", "message": "Voting is not open."})
            return
        if target_id == player_id:
            await self.send(player_id, {"type": "error", "message": "You cannot vote for yourself."})
            return
        if target_id not in self.players:
            await self.send(player_id, {"type": "error", "message": "Invalid vote target."})
            return
        if player_id in self.votes:
            await self.send(player_id, {"type": "error", "message": "You already voted."})
            return

        self.votes[player_id] = target_id

        # Set phase to voting if not already
        if self.phase == Phase.FREE_CHAT:
            self.phase = Phase.VOTING

        # Send vote confirmation to the voter
        await self.send(player_id, {"type": "vote_confirmed", "targetId": target_id})

        # Broadcast vote progress
        await self.broadcast(
            {
                "type": "vote_progress",
                "votesCast": len(self.votes),
                "votesNeeded": len(self.players),
            }
        )

        # Check if all active players have voted
        if len(self.votes) >= len(self.players):
            await self.broadcast({"type": "reveal_countdown", "seconds": 3})
            await asyncio.sleep(3)
            await self.reveal_and_score()

    async def reveal_and_score(self) -> None:
        self.phase = Phase.REVEAL_SCORING
        agent_ids = [pid for pid, p in self.players.items() if p.role == "agent"]
        scores = calculate_scores(
            {pid: p.role for pid, p in self.players.items()},
            self.votes,
            self.imposter_id,
            agent_ids,
        )

        vote_details = []
        for voter_id, target_id in self.votes.items():
            voter = self.players[voter_id]
            target = self.players[target_id]
            vote_details.append(
                {
                    "voterId": voter_id,
                    "voterAlias": voter.round_alias,
                    "targetId": target_id,
                    "targetAlias": target.round_alias,
                }
            )

        reveal_players = []
        imposter_won = scores.get(self.imposter_id, 0) >= 2
        for pid, slot in self.players.items():
            reveal_players.append(
                {
                    "id": pid,
                    "realName": slot.real_name,
                    "alias": slot.round_alias,
                    "color": slot.color,
                    "role": slot.role,
                    "word": slot.word,
                    "score": scores[pid],
                    "votesReceived": sum(1 for v in self.votes.values() if v == pid),
                }
            )

        await self.broadcast(
            {
                "type": "game_over",
                "phase": self.phase.value,
                "wordPair": self.word_pair,
                "agentsHadDirtyWord": self.agents_get_dirty,
                "imposterWon": imposter_won,
                "players": reveal_players,
                "votes": vote_details,
                "history": self.history_payload(),
                "groupedHistory": self.grouped_history(),
            }
        )

    def sync_state_for(self, player_id: str) -> list[dict[str, Any]]:
        """Rebuild client state after reconnection."""
        messages: list[dict[str, Any]] = [
            {
                "type": "room_joined",
                "roomCode": self.code,
                "phase": self.phase.value,
                "isHost": player_id == self.host_id,
                "roster": self.lobby_roster() if self.phase == Phase.LOBBY else self.game_roster(),
                "count": self.occupied_count(),
                "needed": self.max_players,
            }
        ]
        if self.phase == Phase.LOBBY:
            return messages

        slot = self.players[player_id]
        messages.append({"type": "your_word", "word": slot.word})
        messages.append(
            {
                "type": "game_start",
                "phase": self.phase.value,
                "roomCode": self.code,
                "players": self.game_roster(),
            }
        )
        if self.sentences:
            messages.append(
                {
                    "type": "sentence_added",
                    "history": self.history_payload(),
                    "sync": True,
                }
            )
        if self.phase == Phase.FREE_CHAT:
            messages.append(
                {
                    "type": "vote_ready_update",
                    "playerId": player_id,
                    "readyCount": len(self.ready_to_vote),
                    "totalPlayers": len(self.players),
                }
            )
        elif self.phase == Phase.VOTING:
            messages.append(
                {
                    "type": "voting_start",
                    "phase": self.phase.value,
                    "players": self.game_roster(),
                    "history": self.history_payload(),
                    "groupedHistory": self.grouped_history(),
                    "alreadyVoted": player_id in self.votes,
                }
            )
            messages.append(
                {
                    "type": "vote_progress",
                    "votesCast": len(self.votes),
                    "votesNeeded": self.max_players,
                }
            )
        elif self.phase == Phase.REVEAL_SCORING:
            pass  # game_over already sent; reconnect late = lobby redirect
        return messages


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, GameRoom] = {}
        self.player_room: dict[str, str] = {}
        self._cleanup_task: asyncio.Task[None] | None = None

    def start_cleanup_loop(self) -> None:
        if self._cleanup_task is None:
            self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def _cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            await self.purge_stale()

    async def purge_stale(self) -> None:
        now = time.time()
        to_delete: list[str] = []
        for code, room in self.rooms.items():
            # Track when room becomes empty
            if room.connected_count() == 0 and room.empty_since is None:
                room.empty_since = now
            elif room.connected_count() > 0:
                room.empty_since = None

            # Remove players who have been disconnected too long
            for pid in list(room.players):
                slot = room.players[pid]
                if (
                    not slot.is_connected
                    and slot.disconnected_at
                    and now - slot.disconnected_at > RECONNECT_WINDOW_SEC
                ):
                    room.players.pop(pid, None)
                    self.player_room.pop(pid, None)

            # Delete room if no players
            if not room.players:
                to_delete.append(code)
                continue

            # Delete empty lobby rooms after 2 minutes (was immediate)
            if room.connected_count() == 0 and room.phase == Phase.LOBBY:
                if room.empty_since and now - room.empty_since > 120:
                    to_delete.append(code)

        for code in to_delete:
            room = self.rooms.pop(code, None)
            if room:
                room.cancel_timer()
                for pid in list(room.players):
                    self.player_room.pop(pid, None)
                logger.info("Purged empty room %s", code)

    def get_room(self, code: str) -> GameRoom | None:
        return self.rooms.get(code.upper())

    async def create_room(
        self, player_id: str, real_name: str, websocket: WebSocket, max_players: int = 3
    ) -> GameRoom:
        code = generate_room_code()
        attempts = 0
        while code in self.rooms:
            attempts += 1
            code = generate_room_code()
            if attempts > 100:
                logger.error("Failed to generate unique room code after 100 attempts")
                code = generate_room_code()

        slot = PlayerSlot(player_id=player_id, real_name=real_name, websocket=websocket)
        room = GameRoom(
            code=code,
            host_id=player_id,
            players={player_id: slot},
            max_players=max_players,
        )
        self.rooms[code] = room
        self.player_room[player_id] = code

        logger.info("Created room %s for player %s. Total rooms: %d", code, player_id, len(self.rooms))
        await self.send_room_state(room, player_id)
        return room

    async def join_room(
        self, code: str, player_id: str, real_name: str, websocket: WebSocket
    ) -> tuple[GameRoom | None, str | None]:
        logger.info("Player %s attempting to join room %s", player_id, code)
        logger.info("Current rooms: %s", list(self.rooms.keys()))
        room = self.get_room(code)
        if not room:
            logger.warning("Room %s not found. Available rooms: %s", code, list(self.rooms.keys()))
            return None, "Room not found. Check the code and try again."

        if player_id in room.players:
            slot = room.players[player_id]
            slot.websocket = websocket
            slot.real_name = real_name
            slot.disconnected_at = None
            self.player_room[player_id] = room.code
            for msg in room.sync_state_for(player_id):
                await self.send(room, player_id, msg)
            await self.broadcast_lobby(room)
            logger.info("Player %s reconnected to room %s", player_id, code)
            return room, None

        if room.occupied_count() >= room.max_players:
            return None, f"Room is full. Maximum {room.max_players} operatives per room."

        if room.phase != Phase.LOBBY:
            return None, "Game already in progress. Reconnect with your saved session."

        slot = PlayerSlot(player_id=player_id, real_name=real_name, websocket=websocket)
        room.players[player_id] = slot
        self.player_room[player_id] = room.code

        await self.send_room_state(room, player_id)
        await self.broadcast_lobby(room)

        logger.info("Player %s joined room %s. Total players: %d", player_id, code, room.occupied_count())
        return room, None

    async def reconnect(
        self, code: str, player_id: str, websocket: WebSocket
    ) -> tuple[GameRoom | None, str | None]:
        room = self.get_room(code)
        if not room:
            return None, "Room session expired."
        slot = room.players.get(player_id)
        if not slot:
            return None, "No saved slot in this room."

        if room.phase == Phase.REVEAL_SCORING:
            return None, "Match has ended. Return to dashboard."

        if slot.disconnected_at and time.time() - slot.disconnected_at > RECONNECT_WINDOW_SEC:
            room.players.pop(player_id, None)
            self.player_room.pop(player_id, None)
            return None, "Reconnect window expired (60s)."

        slot.websocket = websocket
        slot.disconnected_at = None
        self.player_room[player_id] = room.code

        await websocket.send_json(
            {"type": "reconnected", "playerId": player_id, "roomCode": room.code}
        )
        for msg in room.sync_state_for(player_id):
            await self.send(room, player_id, msg)
        await self.broadcast_lobby(room)
        return room, None

    async def leave_room(self, player_id: str) -> None:
        code = self.player_room.pop(player_id, None)
        if not code:
            return
        room = self.rooms.get(code)
        if not room:
            return

        room.players.pop(player_id, None)
        room.cancel_timer()

        if not room.players:
            self.rooms.pop(code, None)
            logger.info("Room %s removed — all players left", code)
            return

        await room.broadcast(
            {
                "type": "player_left",
                "playerId": player_id,
                "count": room.occupied_count(),
                "roster": room.lobby_roster() if room.phase == Phase.LOBBY else room.game_roster(),
            }
        )

        if room.phase == Phase.LOBBY:
            await self.broadcast_lobby(room)

    async def disconnect(self, player_id: str) -> None:
        code = self.player_room.get(player_id)
        if not code:
            return
        room = self.rooms.get(code)
        if not room or player_id not in room.players:
            return

        slot = room.players[player_id]
        slot.websocket = None
        slot.disconnected_at = time.time()
        slot.is_typing = False

        await room.broadcast(
            {
                "type": "player_disconnected",
                "count": room.connected_count(),
                "reconnectSec": RECONNECT_WINDOW_SEC,
            }
        )

    async def send(self, room: GameRoom, player_id: str, message: dict[str, Any]) -> None:
        await room.send(player_id, message)

    async def send_room_state(self, room: GameRoom, player_id: str) -> None:
        await self.send(
            room,
            player_id,
            {
                "type": "room_joined",
                "roomCode": room.code,
                "phase": room.phase.value,
                "isHost": player_id == room.host_id,
                "roster": room.lobby_roster(),
                "count": room.occupied_count(),
                "needed": room.max_players,
            },
        )

    async def broadcast_lobby(self, room: GameRoom) -> None:
        if room.phase != Phase.LOBBY:
            return
        await room.broadcast(
            {
                "type": "lobby_update",
                "roomCode": room.code,
                "phase": room.phase.value,
                "waiting": room.lobby_roster(),
                "count": room.occupied_count(),
                "needed": room.max_players,
            }
        )

    def get_room_for_player(self, player_id: str) -> GameRoom | None:
        code = self.player_room.get(player_id)
        return self.rooms.get(code) if code else None

    async def handle_message(self, player_id: str, data: dict[str, Any]) -> None:
        room = self.get_room_for_player(player_id)
        if not room:
            return
        msg_type = data.get("type")
        if msg_type == "submit_sentence":
            await room.handle_submit_sentence(player_id, str(data.get("text", "")))
        elif msg_type == "cast_vote":
            await room.handle_cast_vote(player_id, str(data.get("targetId", "")))
        elif msg_type == "typing":
            await room.handle_typing(player_id, bool(data.get("isTyping", False)))
        elif msg_type == "ready_to_vote":
            await room.handle_ready_to_vote(player_id)

    async def start_game(self, player_id: str) -> None:
        room = self.get_room_for_player(player_id)
        if not room:
            return
        if player_id != room.host_id:
            return
        if room.phase != Phase.LOBBY:
            return
        if room.occupied_count() < room.max_players:
            return
        await room.start_game()

    async def skip_turn(self, player_id: str) -> None:
        room = self.get_room_for_player(player_id)
        if not room:
            return
        # Skip turn not needed in free chat mode
        if room.phase != Phase.FREE_CHAT:
            return
        # In free chat, skip is not applicable
        pass

    async def finish_game_cleanup(self, room: GameRoom) -> None:
        for pid in list(room.players):
            if pid in self.player_room and self.player_room[pid] == room.code:
                pass  # keep mapping until leave
        room.cancel_timer()
