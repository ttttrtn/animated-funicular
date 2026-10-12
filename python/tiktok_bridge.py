#!/usr/bin/env python3
"""TikTok live chat bridge for server.js.

Usage: python3 -u tiktok_bridge.py <username>
Protocol: one JSON object per stdout line:
  {"type": "log" | "status" | "message" | "error", ...}
Requires: pip install TikTokLive
"""
import asyncio
import json
import sys

try:
    from TikTokLive import TikTokLiveClient
    from TikTokLive.events import CommentEvent, ConnectEvent, DisconnectEvent
except Exception as exc:  # missing package or incompatible version
    print(json.dumps({"type": "error", "fatal": True,
                      "message": f"TikTokLive is not installed or failed to import: {exc}"}), flush=True)
    sys.exit(1)

OFFLINE_RETRY_S = 30


def emit(**obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def first_url(img):
    try:
        urls = getattr(img, "urls", None) or getattr(img, "url_list", None) or []
        return urls[0] if urls else ""
    except Exception:
        return ""


async def run(username):
    client = TikTokLiveClient(unique_id=f"@{username}")

    @client.on(ConnectEvent)
    async def on_connect(_event):
        emit(type="status", status="connected", handle=username)
        emit(type="log", message=f"Connected to @{username}")

    @client.on(DisconnectEvent)
    async def on_disconnect(_event):
        emit(type="log", message="Disconnected from TikTok")

    @client.on(CommentEvent)
    async def on_comment(event):
        user = event.user
        name = getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "TikTok user"
        text = getattr(event, "comment", "") or ""
        if not text:
            return
        emit(type="message", username=name, message=text,
             avatar=first_url(getattr(user, "avatar_thumb", None)))

    while True:
        try:
            if not await client.is_live():
                emit(type="status", status="connecting", handle=username)
                emit(type="log", message=f"@{username} is not live. Checking again in {OFFLINE_RETRY_S}s")
                await asyncio.sleep(OFFLINE_RETRY_S)
                continue
            await client.connect()  # blocks until the stream or socket ends
            emit(type="log", message="Stream ended or socket closed; checking again")
            await asyncio.sleep(5)
        except Exception as exc:
            name = type(exc).__name__
            if "UserNotFound" in name:
                emit(type="error", fatal=True, message=f"TikTok user @{username} not found")
                return 1
            # Anything else: let server.js restart us with backoff.
            emit(type="error", message=f"{name}: {exc}")
            return 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        emit(type="error", fatal=True, message="No TikTok username given")
        sys.exit(1)
    try:
        sys.exit(asyncio.run(run(sys.argv[1].lstrip("@"))) or 0)
    except KeyboardInterrupt:
        sys.exit(0)
