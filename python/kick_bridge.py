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
        # Initialize KickAPI client
        api = KickAPI()

        # Define message handler matching kickpython specification
        async def message_handler(message):
            try:
                # Handle dictionary or object attributes safely based on kickpython specs
                if isinstance(message, dict):
                    username_val = message.get('sender_username', 'KickUser')
                    content_val = message.get('content', '')
                    chat_id_val = message.get('chat_id', '')
                else:
                    username_val = getattr(message, 'sender_username', 'KickUser')
                    content_val = getattr(message, 'content', '')
                    chat_id_val = getattr(message, 'chat_id', '')

                data = {
                    "type": "message",
                    "platform": "kick",
                    "username": username_val,
                    "message": content_val,
                    "id": str(chat_id_val)
                }
                print(json.dumps(data), flush=True)
            except Exception as e:
                pass

        # Register the handler
        api.add_message_handler(message_handler)

        # Notify Node.js server that status is connected
        print(json.dumps({"type": "status", "status": "connected", "handle": username}), flush=True)

        # Connect to the channel's chatroom stream
        await api.connect_to_chatroom(username)

    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)

if __name__ == "__main__":
    asyncio.run(main())
