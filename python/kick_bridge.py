import sys
import json
import asyncio
from kickpython import KickAPI

if len(sys.argv) < 2:
    print(json.dumps({"type": "error", "message": "No channel username provided"}), flush=True)
    sys.exit(1)

username = sys.argv[1].replace("@", "").strip()

async def main():
    try:
        # Initialize KickAPI (unauthenticated public mode for chat listening)
        api = KickAPI()
        
        print(json.dumps({"type": "status", "status": "connected", "handle": username}), flush=True)

        # Register message handler event
        @api.add_message_handler
        async def handle_message(message):
            data = {
                "type": "message",
                "platform": "kick",
                "username": message.sender.username if hasattr(message, 'sender') else "KickUser",
                "message": message.content if hasattr(message, 'content') else str(message),
                "id": str(getattr(message, 'id', ''))
            }
            print(json.dumps(data), flush=True)

        # Connect to the channel's chatroom
        await api.connect_to_chatroom(username)

    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)

if __name__ == "__main__":
    asyncio.run(main())
