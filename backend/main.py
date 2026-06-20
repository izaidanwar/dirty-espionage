"""
Dirty Espionage — FastAPI server with WebSocket multiplayer.
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from game import RoomManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"

rooms = RoomManager()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    rooms.start_cleanup_loop()
    yield


app = FastAPI(title="Dirty Espionage", version="2.0.0", lifespan=lifespan)

# Enable CORS for Vercel frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    player_id: str | None = None
    joined = False
    voluntary_leave = False

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data: dict[str, Any] = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json(
                    {"type": "error", "message": "Invalid JSON payload."}
                )
                continue

            msg_type = data.get("type")

            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if not joined:
                player_id = str(data.get("playerId", "")).strip()
                real_name = str(data.get("realName", "")).strip()[:32]

                if not player_id or not real_name:
                    await websocket.send_json(
                        {"type": "error", "message": "playerId and realName required."}
                    )
                    continue

                if msg_type == "create_room":
                    room = await rooms.create_room(player_id, real_name, websocket)
                    joined = True
                    await websocket.send_json(
                        {
                            "type": "connected",
                            "playerId": player_id,
                            "roomCode": room.code,
                        }
                    )
                elif msg_type == "join_room":
                    code = str(data.get("roomCode", "")).strip().upper()
                    room, err = await rooms.join_room(
                        code, player_id, real_name, websocket
                    )
                    if err:
                        await websocket.send_json({"type": "error", "message": err})
                        continue
                    joined = True
                    await websocket.send_json(
                        {
                            "type": "connected",
                            "playerId": player_id,
                            "roomCode": room.code if room else code,
                        }
                    )
                elif msg_type == "reconnect":
                    code = str(data.get("roomCode", "")).strip().upper()
                    room, err = await rooms.reconnect(code, player_id, websocket)
                    if err:
                        await websocket.send_json({"type": "error", "message": err})
                        continue
                    joined = True
                    await websocket.send_json(
                        {
                            "type": "connected",
                            "playerId": player_id,
                            "roomCode": room.code if room else code,
                        }
                    )
                else:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "Send create_room, join_room, or reconnect first.",
                        }
                    )
                continue

            if not player_id:
                continue

            if msg_type == "leave_room":
                await rooms.leave_room(player_id)
                joined = False
                voluntary_leave = True
                await websocket.send_json({"type": "left_room"})
            elif msg_type == "start_game":
                await rooms.start_game(player_id)
            elif msg_type == "skip_turn":
                await rooms.skip_turn(player_id)
            elif msg_type in ("submit_sentence", "cast_vote", "typing"):
                await rooms.handle_message(player_id, data)
            else:
                await websocket.send_json(
                    {"type": "error", "message": f"Unknown message: {msg_type}"}
                )

    except WebSocketDisconnect:
        logger.info("Player %s disconnected", player_id)
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        if player_id and joined and not voluntary_leave:
            await rooms.disconnect(player_id)
