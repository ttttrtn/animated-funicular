import sys
import json
import time
import uuid
import asyncio

from TikTokLive import TikTokLiveClient
from TikTokLive.events import ConnectEvent, DisconnectEvent, CommentEvent, GiftEvent

if len(sys.argv) < 2:
    print(json.dumps({"type": "error", "message": "No TikTok username provided", "fatal": True}), flush=True)
    sys.exit(1)

username = sys.argv[1].replace("@", "").strip()

OFFLINE_RETRY_S = 30      # streamer not live yet: check again every 30s
ERROR_RETRY_MIN_S = 5
ERROR_RETRY_MAX_S = 120


def emit(obj):
    print(json.dumps(obj), flush=True)  # ensure_ascii keeps emoji safe on any console


def log(msg):
    emit({"type": "log", "message": msg})


def status(s):
    emit({"type": "status", "status": s, "handle": username, "username": username})


def avatar_of(user):
    for attr in ("avatar_thumb", "avatar_medium", "avatar_large"):
        img = getattr(user, attr, None)
        urls = getattr(img, "url_list", None) if img else None
        if urls:
            return str(urls[0])
    return ""


def message_id(event):
    common = getattr(event, "common", None)
    mid = getattr(common, "msg_id", None)
    return f"tiktok-{mid}" if mid else f"tiktok-{uuid.uuid4().hex[:12]}"


def display_name(user):
    return (getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "TikTok user")


def build_client():
    client = TikTokLiveClient(unique_id=username)

    @client.on(ConnectEvent)
    async def on_connect(event: ConnectEvent):
        status("connected")

    @client.on(DisconnectEvent)
    async def on_disconnect(event: DisconnectEvent):
        status("disconnected")

    @client.on(CommentEvent)
    async def on_comment(event: CommentEvent):
        text = event.comment
        if not text:
            return
        emit({
            "type": "message",
            "platform": "tiktok",
            "username": display_name(event.user),
            "handle": getattr(event.user, "unique_id", ""),
            "message": text,
            "avatar": avatar_of(event.user),
            "id": message_id(event),
            "timestamp": int(time.time() * 1000),
        })

    @client.on(GiftEvent)
    async def on_gift(event: GiftEvent):
        # Streakable gifts fire repeatedly while the streak is running; only
        # report the final one.
        if event.gift.streakable and event.streaking:
            return
        count = event.repeat_count or 1
        emit({
            "type": "message",
            "platform": "tiktok",
            "username": display_name(event.user),
            "handle": getattr(event.user, "unique_id", ""),
            "message": f"sent {count}x {event.gift.name} \U0001F381",
            "avatar": avatar_of(event.user),
            "id": message_id(event),
            "timestamp": int(time.time() * 1000),
        })

    return client


async def main():
    delay = ERROR_RETRY_MIN_S
    while True:
        client = build_client()
        try:
            status("connecting")
            # start() is NON-blocking: it returns the connection task as soon as
            # the socket is up. The old script returned right here, so the
            # process exited a moment after "connected". Await the task instead.
            task = await client.start()
            delay = ERROR_RETRY_MIN_S
            await task
            log("Connection ended, reconnecting in 5s")
            await asyncio.sleep(5)
        except Exception as e:
            name = type(e).__name__
            if name == "UserNotFoundError":
                emit({"type": "error", "message": f"TikTok user @{username} not found", "fatal": True})
                return
            if name == "UserOfflineError":
                log(f"@{username} is not live. Checking again in {OFFLINE_RETRY_S}s")
                status("connecting")
                await asyncio.sleep(OFFLINE_RETRY_S)
                continue
            hint = ""
            if name in ("WebcastBlockedError", "WebcastBlocked200Error", "SignAPIError",
                        "SignatureRateLimitError", "UnexpectedSignatureError", "SignatureMissingTokensError"):
                hint = " (TikTok or the signing service is blocking this server; datacenter IPs such as Render are often blocked)"
            emit({"type": "error", "message": f"{name}: {e}{hint}"})
            await asyncio.sleep(delay)
            delay = min(delay * 2, ERROR_RETRY_MAX_S)
        finally:
            try:
                await client.disconnect()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
