import sys
import re
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
BADGE_DEBUG_LIMIT = 3     # log the raw badge structure for the first few chat events


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


# ---------------------------------------------------------------------------
# Badges.
#
# TikTokLive (v6.x, betterproto2) exposes badges as `user.badge_list`, a list
# of BadgeStruct. (`user.badges` is only a legacy alias of the same list.)
# A BadgeStruct has:
#   badge_scene            enum  (NOT "badge_scene_type")
#   image_badge.image      ImageModel  -> url_list / uri
#   text_badge             .default_pattern
#   string_badge           string badge
#   combine_badge_struct   .icon (ImageModel) + .text  (fan club, gifter level)
# Depending on the generated proto version the content fields can also be named
# image / text / str / combine (a protobuf oneof), so both spellings are tried.
# Every access is defensive: one missing attribute must never kill a chat event.
# ---------------------------------------------------------------------------
_badge_debug_left = BADGE_DEBUG_LIMIT


def _safe(obj, name, default=None):
    try:
        v = getattr(obj, name, default)
    except Exception:
        return default
    return default if callable(v) else v


def _first_attr(obj, *names):
    for n in names:
        v = _safe(obj, n)
        if v is not None:
            return v
    return None


def _scene_name(scene):
    """Badge scene as a lowercase string (enum name if available)."""
    if scene is None:
        return ""
    name = getattr(scene, "name", None)
    return str(name if name else scene).lower()


def _image_info(img):
    """(https url, uri) of an ImageModel; ('', '') if there is none."""
    if img is None:
        return "", ""
    url = ""
    for u in _safe(img, "url_list") or []:
        u = str(u)
        if u.startswith("https://"):
            url = u
        elif u.startswith("http://"):
            url = "https://" + u[7:]   # TikTok CDNs serve https; the server only accepts https
        elif u.startswith("//"):
            url = "https:" + u
        if url:
            break
    return url, str(_safe(img, "uri", "") or "")


def _classify(*hints):
    """Map scene name / image uri / text to a type the overlay can style."""
    h = " ".join(str(x).lower() for x in hints if x)
    if "moderator" in h or "admin" in h:
        return "moderator"
    if "subscri" in h:
        return "subscriber"
    if "gifter" in h or "rank" in h or "grade" in h or "pay_" in h:
        return "gifter"
    if "fans" in h or "fanclub" in h or "member" in h:
        return "fan"
    return ""


def _extract_badge(b):
    """One BadgeStruct -> (scene, url, uri, text)."""
    scene = _scene_name(_first_attr(b, "badge_scene", "badge_scene_type"))
    url = uri = text = ""

    img = _first_attr(b, "image_badge", "image")
    if img is not None:
        url, uri = _image_info(_safe(img, "image") or img)

    tb = _first_attr(b, "text_badge", "text")
    if tb is not None:
        text = str(_safe(tb, "default_pattern", "") or "")

    sb = _first_attr(b, "string_badge", "str")
    if sb is not None and not text:
        text = sb if isinstance(sb, str) else str(_safe(sb, "str", "") or "")

    cb = _first_attr(b, "combine_badge_struct", "combine")
    if cb is not None:
        if not url:
            url, uri = _image_info(_safe(cb, "icon"))
        if not text:
            t = _safe(cb, "text")
            text = str(_safe(t, "default_pattern", "") or _safe(cb, "str", "") or "")

    if "{" in text:       # unresolved template such as "{0:string}"
        text = ""
    return scene, url, uri, text


def badges_of(user):
    global _badge_debug_left
    out, seen = [], set()

    def add(kind, label="", url="", uri=""):
        key = uri or url or kind
        if (kind, key) in seen:
            return
        # A role we already know from a property (moderator, subscriber, ...)
        # is upgraded in place when the real image badge shows up, never doubled.
        for existing in out:
            if existing["type"] == kind and not existing["url"] and kind != "badge":
                if url:
                    existing["url"] = url
                    existing["label"] = existing["label"] if label in ("", kind) else label
                seen.add((kind, key))
                return
        if len(out) >= 6:
            return
        seen.add((kind, key))
        out.append({"type": kind, "label": label or kind, "url": url})

    handle = str(_safe(user, "unique_id", "") or _safe(user, "display_id", "") or "")
    if handle and handle.lower() == username.lower():
        add("broadcaster", "Streamer")
    if _safe(user, "is_moderator", False) is True:
        add("moderator", "Moderator")
    if _safe(user, "is_subscriber", False) is True:
        add("subscriber", "Subscriber")

    raw = []
    for attr in ("badge_list", "badges"):          # badge_list first; badges is a legacy alias
        value = _safe(user, attr)
        if value:
            try:
                raw = list(value)
                break
            except Exception:
                pass

    debug = []
    image_found = False
    for b in raw:
        try:
            scene, url, uri, text = _extract_badge(b)
            kind = _classify(scene, uri, text) or re.sub(r"[^a-z0-9_-]", "", scene) or "badge"
            debug.append(f"{scene or '?'}|{kind}|uri={uri[:40] or '-'}|img={'y' if url else 'n'}|text={text[:20] or '-'}")
            if not (url or text) and kind == "badge":
                continue                            # nothing to show
            image_found = image_found or bool(url)
            add(kind, text or kind, url, uri)
        except Exception as e:
            debug.append(f"error:{type(e).__name__}")

    # Legacy ImageModel lists: only used when the structured badges gave no image.
    if not image_found:
        for attr in ("badge_image_list", "media_badge_image_list"):
            for img in _safe(user, attr) or []:
                try:
                    url, uri = _image_info(img)
                    if url:
                        add(_classify(uri) or "badge", "", url, uri)
                except Exception:
                    continue

    if _badge_debug_left > 0:
        _badge_debug_left -= 1
        log(f"badge debug @{handle or '?'}: {len(raw)} raw -> {debug} => {[b['type'] for b in out]}")
    return out


def gift_in_progress(event):
    """True while a gift streak is still running (only the final event should be shown).

    Newer TikTokLive versions can hand us a gift object without `streakable`,
    and `event.streaking` reads that same attribute, so neither is trusted.
    """
    gift = getattr(event, "gift", None)
    streakable = getattr(gift, "streakable", None)
    if streakable is None:
        gift_type = getattr(gift, "type", None)
        if gift_type is None:
            gift_type = getattr(gift, "gift_type", None)
        if gift_type is None:
            return False  # unknown: show every event rather than hide gifts
        streakable = gift_type == 1
    return bool(streakable) and not bool(getattr(event, "repeat_end", 0))


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
            "badges": badges_of(event.user),
            "id": message_id(event),
            "timestamp": int(time.time() * 1000),
        })

    @client.on(GiftEvent)
    async def on_gift(event: GiftEvent):
        try:
            if gift_in_progress(event):
                return
            gift = getattr(event, "gift", None)
            name = getattr(gift, "name", "") or "a gift"
            count = getattr(event, "repeat_count", 1) or 1
            emit({
                "type": "message",
                "platform": "tiktok",
                "username": display_name(event.user),
                "handle": getattr(event.user, "unique_id", ""),
                "message": f"sent {count}x {name} \U0001F381",
                "avatar": avatar_of(event.user),
                "badges": badges_of(event.user),
                "id": message_id(event),
                "timestamp": int(time.time() * 1000),
            })
        except Exception as e:
            log(f"Gift event skipped: {type(e).__name__}: {e}")

    return client


async def main():
    delay = ERROR_RETRY_MIN_S
    while True:
        client = build_client()
        try:
            status("connecting")
            # start() is NON-blocking: it returns the connection task as soon as
            # the socket is up. Await the task so the process stays alive.
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
