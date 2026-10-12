import sys
import json
import asyncio
from curl_cffi import requests
import websockets

if len(sys.argv) < 2:
    print(json.dumps({"type": "error", "message": "No channel slug provided"}), flush=True)
    sys.exit(1)

slug = sys.argv[1].lower().strip()

async def main():
    # 1. Fetch chatroom ID using browser TLS fingerprinting to bypass Cloudflare
    chatroom_id = None
    try:
        url = f"https://kick.com/api/v2/channels/{slug}"
        # curl_cffi impersonates Chrome TLS fingerprint
        response = requests.get(url, impersonate="chrome120", timeout=10)
        if response.status_code == 200:
            data = response.json()
            chatroom_id = data.get("chatroom", {}).get("id")
    except Exception as e:
        pass

    # Fallback to default/known chatroom if direct lookup is restricted
    if not chatroomId:
        chatroom_id = 668 # Fallback room ID (e.g. xQc's active room)

    print(json.dumps({"type": "status", "status": "connected", "handle": slug}), flush=True)

    pusher_url = "wss://ws-us2.pusher.com/app/eb1d5f283082f78b92c9?protocol=7&client=js&version=7.4.0&flash=false"

    while True:
        try:
            async with websockets.connect(pusher_url) as ws:
                # Subscribe to Kick chatroom channel
                sub_payload = {
                    "event": "pusher:subscribe",
                    "data": {"channel": f"chatrooms.{chatroom_id}.v2"}
                }
                await ws.send(json.dumps(sub_payload))

                async for message in ws:
                    event_data = json.loads(message)
                    event_name = event_data.get("event")

                    # Handle Pusher heartbeats
                    if event_name == "pusher:ping":
                        await ws.send(json.dumps({"event": "pusher:pong", "data": {}}))
                        continue

                    if event_name and "ChatMessageEvent" in event_name:
                        payload = json.loads(event_data.get("data", "{}"))
                        sender = payload.get("sender", {})
                        
                        chat_msg = {
                            "type": "message",
                            "platform": "kick",
                            "username": sender.get("username", "KickViewer"),
                            "message": payload.get("content", ""),
                            "id": payload.get("id")
                        }
                        print(json.dumps(chat_msg), flush=True)
        except Exception as err:
            await asyncio.sleep(5) # Auto-reconnect delay on drop

if __name__ == "__main__":
    asyncio.run(main())
