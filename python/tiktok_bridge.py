import sys
import json
import asyncio
from TikTokLive import TikTokLiveClient
from TikTokLive.events import ConnectEvent, DisconnectEvent, CommentEvent, GiftEvent

if len(sys.argv) < 2:
    print(json.dumps({"type": "error", "message": "No TikTok username provided"}), flush=True)
    sys.exit(1)

username = sys.argv[1].replace("@", "").strip()
client = TikTokLiveClient(unique_id=username)

@client.on(ConnectEvent)
async def on_connect(event: ConnectEvent):
    print(json.dumps({"type": "status", "status": "connected", "username": username}), flush=True)

@client.on(DisconnectEvent)
async def on_disconnect(event: DisconnectEvent):
    print(json.dumps({"type": "status", "status": "disconnected", "username": username}), flush=True)

@client.on(CommentEvent)
async def on_comment(event: CommentEvent):
    data = {
        "type": "message",
        "platform": "tiktok",
        "username": event.user.nickname or event.user.unique_id,
        "handle": event.user.unique_id,
        "message": event.comment,
        "avatar": event.user.avatar.urls[0] if event.user.avatar and event.user.avatar.urls else "",
        "id": str(event.message_id or event.timestamp),
        "timestamp": event.timestamp
    }
    print(json.dumps(data), flush=True)

@client.on(GiftEvent)
async def on_gift(event: GiftEvent):
    if event.gift.streakable and not event.gift.repeat_end:
        return
    data = {
        "type": "message",
        "platform": "tiktok",
        "username": event.user.nickname or event.user.unique_id,
        "handle": event.user.unique_id,
        "message": f"sent {event.gift.count}x {event.gift.info.name} 🎁",
        "avatar": event.user.avatar.urls[0] if event.user.avatar and event.user.avatar.urls else "",
        "id": str(event.message_id or event.timestamp),
        "timestamp": event.timestamp
    }
    print(json.dumps(data), flush=True)

async def main():
    try:
        await client.start()
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)

if __name__ == "__main__":
    asyncio.run(main())