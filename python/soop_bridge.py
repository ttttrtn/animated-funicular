"""SOOP (AfreecaTV) chat bridge, no third-party SOOP library.
Usage: python soop_bridge.py <bj_id>
Reads chat anonymously (works for public, non-age-restricted, non-password lives).
Prints one JSON object per line for server.js to read.

Protocol notes come from open-source clients (unofficial; SOOP can change it):
  1. POST player_live_api.php  -> chat server (CHDOMAIN, CHPT, CHATNO) of the current live
  2. wss://{CHDOMAIN}:{CHPT+1}/Websocket/{bj}  with subprotocol "chat"
  3. send CONNECT packet, then JOIN packet (with CHATNO), ping every 60 s
"""
import asyncio
import json
import ssl
import sys
import urllib.parse
import urllib.request

import websockets

F = "\x0c"
ESC = "\x1b\t"
API_HOSTS = ["live.sooplive.co.kr", "live.afreecatv.com"]  # new domain first, old as fallback


def emit(**kw):
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def fetch_live_info(bj):
    """Blocking HTTP call; returns the CHANNEL dict of the current broadcast."""
    last = "no response"
    for host in API_HOSTS:
        url = f"https://{host}/afreeca/player_live_api.php?bjid={urllib.parse.quote(bj)}"
        body = urllib.parse.urlencode({
            "bid": bj, "bno": "", "type": "live", "confirm_adult": "false",
            "player_type": "html5", "mode": "landing", "from_api": "0",
            "pwd": "", "stream_type": "common", "quality": "HD",
        }).encode()
        req = urllib.request.Request(url, data=body, headers={
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": f"https://play.{host.split('.', 1)[1]}/{bj}",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                ch = json.loads(r.read().decode("utf-8", "replace")).get("CHANNEL") or {}
        except Exception as e:  # network error / bad JSON -> try next host
            last = f"{host}: {type(e).__name__}: {e}"
            continue
        if ch.get("CHDOMAIN") and ch.get("CHATNO"):
            return ch
        last = f"{host}: not live or restricted (RESULT={ch.get('RESULT')})"
    raise RuntimeError(f"Cannot get live info for '{bj}' ({last}). Is the streamer live right now?")


def parse_chat(data):
    """Return (nickname, text) for a chat packet, else None."""
    if isinstance(data, str):
        data = data.encode("utf-8", "replace")
    parts = [p.decode("utf-8", "replace") for p in data.split(b"\x0c")]
    if len(parts) > 6 and parts[1] not in ("-1", "1") and "|" not in parts[1] and parts[1].strip():
        return (parts[6] or parts[2] or "viewer"), parts[1]
    return None


def byte_size(s):
    return len(s.encode("utf-8")) + 6


async def main(bj):
    emit(type="status", status="connecting")
    try:
        ch = await asyncio.to_thread(fetch_live_info, bj)
    except Exception as e:
        emit(type="error", message=str(e))
        return

    domain = str(ch["CHDOMAIN"]).lower()
    port = str(int(ch["CHPT"]) + 1)
    chatno = str(ch["CHATNO"])
    uri = f"wss://{domain}:{port}/Websocket/{bj}"
    emit(type="log", message=f"Chat server {domain}:{port} (room {chatno})")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    connect_pkt = f"{ESC}000100000600{F*3}16{F}"
    join_pkt = f"{ESC}0002{byte_size(chatno):06}00{F}{chatno}{F*5}"
    ping_pkt = f"{ESC}000000000100{F}"

    try:
        async with websockets.connect(uri, subprotocols=["chat"], ssl=ctx, ping_interval=None,
                                      open_timeout=15, max_size=None) as ws:
            await ws.send(connect_pkt)
            await asyncio.sleep(2)
            await ws.send(join_pkt)
            emit(type="status", status="connected")
            emit(type="log", message=f"Joined chat of {bj}")

            async def pinger():
                while True:
                    await asyncio.sleep(60)
                    await ws.send(ping_pkt)

            ping_task = asyncio.create_task(pinger())
            try:
                async for data in ws:
                    chat = parse_chat(data)
                    if chat:
                        emit(type="message", username=chat[0], message=chat[1])
            finally:
                ping_task.cancel()
    except Exception as e:
        emit(type="error", message=f"WebSocket: {type(e).__name__}: {e}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        emit(type="error", fatal=True, message="No BJ id given")
        sys.exit(1)
    try:
        asyncio.run(main(sys.argv[1]))
    except Exception as e:
        emit(type="error", message=f"{type(e).__name__}: {e}")
