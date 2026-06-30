"""In-memory WebSocket watch parties ("Crews").

Ephemeral, sign-up-free synced playback rooms. A room holds the current media
plus a playback clock; members broadcast play / pause / seek and a light chat.
Each viewer still resolves and streams their own copy of the video — only the
*timeline* is synced, so there's no shared video pipe to choke on.

NOTE: state lives in this process's memory, so the app MUST run as a single
worker (which the tunnel / single-VPS deploy is). To scale across workers this
would need a shared backplane (e.g. Redis pub/sub) — out of scope for now.
"""
import asyncio
import secrets
import time
from typing import Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

# Unambiguous alphabet — no 0/O/1/I to make codes easy to read out loud.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _gen_code(n: int = 5) -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(n))


class Member:
    __slots__ = ("id", "name", "ws")

    def __init__(self, mid: str, name: str, ws: WebSocket):
        self.id = mid
        self.name = name
        self.ws = ws


class Room:
    """A crew + its playback clock. Position is stored as a (base, timestamp)
    pair so we can compute the *live* position for late joiners without anyone
    constantly streaming heartbeats."""

    def __init__(self, code: str):
        self.code = code
        self.members: Dict[str, Member] = {}
        self.host_id: Optional[str] = None
        self.media: Optional[dict] = None
        self.paused: bool = True
        self.rate: float = 1.0
        self._base_pos: float = 0.0
        self._base_at: float = time.monotonic()

    def live_position(self) -> float:
        if self.paused or self.media is None:
            return self._base_pos
        return self._base_pos + (time.monotonic() - self._base_at) * self.rate

    def update_clock(self, paused=None, position=None, rate=None):
        # Re-baseline from the current live position before mutating.
        self._base_pos = self.live_position() if position is None else max(0.0, float(position))
        self._base_at = time.monotonic()
        if paused is not None:
            self.paused = bool(paused)
        if rate is not None:
            self.rate = float(rate)

    def snapshot(self) -> dict:
        return {
            "media": self.media,
            "paused": self.paused,
            "position": round(self.live_position(), 3),
            "rate": self.rate,
        }

    def member_list(self):
        return [{"id": m.id, "name": m.name} for m in self.members.values()]


_rooms: Dict[str, Room] = {}
_lock = asyncio.Lock()


async def _broadcast(room: Room, msg: dict, exclude: Optional[str] = None):
    dead = []
    for mid, m in list(room.members.items()):
        if mid == exclude:
            continue
        try:
            await m.ws.send_json(msg)
        except Exception:
            dead.append(mid)
    for mid in dead:
        room.members.pop(mid, None)


@router.websocket("/ws/party/{code}")
async def party_ws(ws: WebSocket, code: str):
    await ws.accept()
    code = (code or "").strip().upper()

    async with _lock:
        if code in ("", "NEW"):
            while True:
                code = _gen_code()
                if code not in _rooms:
                    break
            room = Room(code)
            _rooms[code] = room
        else:
            room = _rooms.get(code)
            if room is None:
                # Joining a code that doesn't exist yet (e.g. via a shared link
                # before the host connected) just creates it.
                room = Room(code)
                _rooms[code] = room

    member_id = secrets.token_hex(4)
    member: Optional[Member] = None
    empty = False

    try:
        hello = await ws.receive_json()
        name = (str(hello.get("name") or "Captain").strip())[:24] or "Captain"
        member = Member(member_id, name, ws)
        async with _lock:
            if not room.members or room.host_id is None:
                room.host_id = member_id
            room.members[member_id] = member

        await ws.send_json({
            "type": "welcome",
            "code": room.code,
            "member_id": member_id,
            "host_id": room.host_id,
            "members": room.member_list(),
            "state": room.snapshot(),
        })
        await _broadcast(room, {
            "type": "member_join",
            "member": {"id": member_id, "name": name},
            "members": room.member_list(),
        }, exclude=member_id)

        while True:
            data = await ws.receive_json()
            t = data.get("type")

            if t == "ping":
                await ws.send_json({"type": "pong"})

            elif t in ("play", "pause", "seek"):
                pos = data.get("position")
                if t == "play":
                    room.update_clock(paused=False, position=pos)
                elif t == "pause":
                    room.update_clock(paused=True, position=pos)
                else:
                    room.update_clock(position=pos)
                await _broadcast(room, {
                    "type": t,
                    "position": round(room.live_position(), 3),
                    "paused": room.paused,
                    "by": member_id,
                    "by_name": name,
                }, exclude=member_id)

            elif t == "set_media":
                room.media = data.get("media") or None
                room.update_clock(paused=True, position=0.0)
                await _broadcast(room, {
                    "type": "set_media",
                    "media": room.media,
                    "by": member_id,
                    "by_name": name,
                }, exclude=member_id)

            elif t == "sync_request":
                await ws.send_json({
                    "type": "state",
                    "state": room.snapshot(),
                    "host_id": room.host_id,
                })

            elif t == "chat":
                txt = (str(data.get("text") or "").strip())[:500]
                if txt:
                    await _broadcast(room, {
                        "type": "chat",
                        "from": member_id,
                        "name": name,
                        "text": txt,
                    })

            elif t == "rename":
                new = (str(data.get("name") or "").strip())[:24]
                if new and member is not None:
                    name = new
                    member.name = new
                    await _broadcast(room, {"type": "members", "members": room.member_list()})

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        async with _lock:
            room.members.pop(member_id, None)
            if room.host_id == member_id:
                room.host_id = next(iter(room.members), None)
            empty = not room.members
            if empty:
                _rooms.pop(room.code, None)
        if member is not None and not empty:
            await _broadcast(room, {
                "type": "member_leave",
                "member_id": member_id,
                "host_id": room.host_id,
                "members": room.member_list(),
            })
