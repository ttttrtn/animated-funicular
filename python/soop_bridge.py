"""SOOP (AfreecaTV) chat bridge. Unofficial: uses the `afreeca` library.
Usage: python soop_bridge.py <bj_id>
Optional env: SOOP_ID / SOOP_PW (only if reading chat needs a login).
Prints one JSON object per line for server.js to read."""
import asyncio
import json
import os
import sys


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


async def main(bj):
    try:
        from afreeca import AfreecaTV, UserCredential
    except ImportError:
        emit(type="error", fatal=True, message="Python package missing: pip install afreeca")
        return

    emit(type="status", status="connecting")
    uid, pw = os.getenv("SOOP_ID"), os.getenv("SOOP_PW")
    try:
        if uid and pw:
            client = AfreecaTV(credential=await UserCredential.login(uid, pw))
        else:
            client = AfreecaTV()
        chat = await client.create_chat(bj)
    except Exception as e:  # BJ offline, bad id, login problem...
        emit(type="error", message=f"{type(e).__name__}: {e}")
        return

    async def on_chat(c):
        emit(
            type="message",
            username=str(getattr(c, "nickname", "") or "viewer"),
            message=str(getattr(c, "message", "") or ""),
        )

    chat.add_callback(on_chat)
    emit(type="status", status="connected")
    emit(type="log", message=f"Joined chat of {bj}")
    await chat.start()  # returns when the chat closes (stream ended / dropped)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        emit(type="error", fatal=True, message="No BJ id given")
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except Exception as e:
        emit(type="error", message=f"{type(e).__name__}: {e}")
