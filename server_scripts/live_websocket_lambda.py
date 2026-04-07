import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


dynamodb = boto3.resource("dynamodb")
CONNECTIONS_TABLE = dynamodb.Table(_require_env("CONNECTIONS_TABLE"))

s3 = boto3.client("s3")
LIVE_BUCKET = _require_env("LIVE_BUCKET")
LIVE_SNAPSHOT_KEY = os.environ.get("LIVE_SNAPSHOT_KEY", "live/current.json")
FINAL_GAMES_PREFIX = os.environ.get("FINAL_GAMES_PREFIX", "games/")

BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "200"))
FLUSH_INTERVAL_MS = int(os.environ.get("FLUSH_INTERVAL_MS", "1500"))
REPLAY_CHUNK_SIZE = int(os.environ.get("REPLAY_CHUNK_SIZE", "200"))
IDLE_TIMEOUT_SECONDS = int(os.environ.get("IDLE_TIMEOUT_SECONDS", "30"))
GAME_END_GRACE_SECONDS = int(os.environ.get("GAME_END_GRACE_SECONDS", "10"))

CACHE: Dict[str, Any] = {
    "meta": None,
    "events": [],
    "pending": [],
    "last_seq": 0,
    "game_id": None,
    "last_flush_ts": 0.0,
    "last_event_ts": 0.0,
    "final": False,
    "saw_game_end": False,
}


def lambda_handler(event, _context):
    route = event["requestContext"]["routeKey"]
    connection_id = event["requestContext"]["connectionId"]
    now = time.time()
    logger.info("route=%s connection=%s", route, connection_id)

    if route == "$connect":
        _add_connection(connection_id)
        return {"statusCode": 200}

    if route == "$disconnect":
        _remove_connection(connection_id)
        return {"statusCode": 200}

    if route == "metadata":
        metadata = _extract_payload(event)
        if not isinstance(metadata, dict):
            logger.warning("Received non-object metadata payload: %s", metadata)
            return {"statusCode": 400}
        _handle_new_metadata(event, metadata, now)
        return {"statusCode": 200}

    if route == "event":
        payload = _extract_payload(event)
        if not isinstance(payload, dict):
            logger.warning("Received non-object event payload: %s", payload)
            return {"statusCode": 400}
        _ingest_events(event, [payload], now)
        return {"statusCode": 200}

    if route == "event_batch":
        payload = _extract_payload(event)
        events = _coerce_event_list(payload)
        if events is None:
            logger.warning("Received non-list event_batch payload: %s", payload)
            return {"statusCode": 400}
        _ingest_events(event, events, now)
        return {"statusCode": 200}

    if route == "replay":
        _replay_state_to_connection(event, connection_id)
        return {"statusCode": 200}

    logger.warning("Unhandled route: %s", route)
    return {"statusCode": 200}


def _extract_payload(event: Dict[str, Any]) -> Optional[Any]:
    body = event.get("body") or "{}"
    if isinstance(body, bytes):
        body = body.decode()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        logger.exception("Failed to parse body: %s", body)
        return None

    data = parsed.get("data")
    if isinstance(data, str):
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            return data
    return data


def _coerce_event_list(payload: Any) -> Optional[List[Dict[str, Any]]]:
    if isinstance(payload, list):
        return [ev for ev in payload if isinstance(ev, dict)]
    if isinstance(payload, dict) and isinstance(payload.get("events"), list):
        return [ev for ev in payload["events"] if isinstance(ev, dict)]
    return None


def _add_connection(connection_id: str) -> None:
    CONNECTIONS_TABLE.put_item(Item={"connectionId": connection_id})


def _remove_connection(connection_id: str) -> None:
    CONNECTIONS_TABLE.delete_item(Key={"connectionId": connection_id})


def _handle_new_metadata(event: Dict[str, Any], metadata: Dict[str, Any], now: float) -> None:
    if CACHE.get("meta") and CACHE.get("events") and not CACHE.get("final"):
        _finalize_game(event, reason="metadata_reset")

    _reset_cache(metadata, now)
    _broadcast(event, {"action": "metadata", "data": metadata})
    _persist_snapshot()


def _reset_cache(metadata: Dict[str, Any], now: float) -> None:
    CACHE["meta"] = metadata
    CACHE["events"] = []
    CACHE["pending"] = []
    CACHE["last_seq"] = 0
    CACHE["game_id"] = _derive_game_id(metadata)
    CACHE["last_flush_ts"] = now
    CACHE["last_event_ts"] = now
    CACHE["final"] = False
    CACHE["saw_game_end"] = False


def _ingest_events(event: Dict[str, Any], events: Iterable[Dict[str, Any]], now: float) -> None:
    if not events:
        return

    if CACHE.get("final"):
        logger.info("Ignoring events after finalization")
        return

    _maybe_finalize_idle(event, now)

    for ev in events:
        CACHE["last_seq"] += 1
        ev_with_seq = dict(ev)
        ev_with_seq["seq"] = CACHE["last_seq"]
        CACHE["events"].append(ev_with_seq)
        CACHE["pending"].append(ev_with_seq)
        CACHE["last_event_ts"] = now
        if ev.get("type") == "game end":
            CACHE["saw_game_end"] = True

    if _should_flush(now):
        _flush_pending(event, now)

    if CACHE.get("saw_game_end"):
        _finalize_after_grace(event, now)


def _should_flush(now: float) -> bool:
    if len(CACHE["pending"]) >= BATCH_SIZE:
        return True
    elapsed_ms = (now - CACHE["last_flush_ts"]) * 1000.0
    return elapsed_ms >= FLUSH_INTERVAL_MS


def _flush_pending(event: Dict[str, Any], now: float) -> None:
    if not CACHE["pending"]:
        return

    pending = CACHE["pending"]
    CACHE["pending"] = []

    for chunk in _chunk_events(pending, BATCH_SIZE):
        seq_start = chunk[0].get("seq")
        seq_end = chunk[-1].get("seq")
        payload = {
            "action": "batch",
            "data": {
                "events": chunk,
                "seqStart": seq_start,
                "seqEnd": seq_end,
                "lastSeq": CACHE["last_seq"],
            },
        }
        _broadcast(event, payload)

    CACHE["last_flush_ts"] = now
    _persist_snapshot()


def _chunk_events(events: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    if size <= 0:
        yield events
        return
    for i in range(0, len(events), size):
        yield events[i : i + size]


def _finalize_after_grace(event: Dict[str, Any], now: float) -> None:
    if CACHE.get("final"):
        return

    last_seen = CACHE.get("last_event_ts", now)
    # Sleep for a short grace period to allow late events to arrive.
    time.sleep(GAME_END_GRACE_SECONDS)
    if CACHE.get("last_event_ts") != last_seen:
        # New events arrived during grace period; skip finalization for now.
        return

    _finalize_game(event, reason="game_end")


def _maybe_finalize_idle(event: Dict[str, Any], now: float) -> None:
    if CACHE.get("final"):
        return
    last_event = CACHE.get("last_event_ts")
    if not last_event:
        return
    if now - last_event > IDLE_TIMEOUT_SECONDS:
        _finalize_game(event, reason="idle_timeout")


def _finalize_game(event: Dict[str, Any], reason: str) -> None:
    if CACHE.get("final"):
        return

    logger.info("Finalizing game (reason=%s)", reason)
    _flush_pending(event, time.time())

    meta = CACHE.get("meta")
    if not meta:
        logger.warning("Finalization skipped: missing metadata")
        return

    final_events = [_strip_seq(ev) for ev in CACHE.get("events", [])]
    final_payload = {
        "gameDuration": meta.get("gameDuration"),
        "penalty": meta.get("penalty"),
        "startTime": meta.get("startTime"),
        "gameType": meta.get("gameType"),
        "teams": meta.get("teams"),
        "players": meta.get("players"),
        "events": final_events,
    }

    game_id = CACHE.get("game_id") or _derive_game_id(meta)
    title = _safe_title(meta.get("gameType", "Game"))
    key = f"{FINAL_GAMES_PREFIX}{game_id}@{title}.json"

    s3.put_object(
        Bucket=LIVE_BUCKET,
        Key=key,
        Body=json.dumps(final_payload, separators=(",", ":"), ensure_ascii=False),
        ContentType="application/json",
    )

    CACHE["final"] = True
    _persist_snapshot(final=True)


def _strip_seq(event: Dict[str, Any]) -> Dict[str, Any]:
    if "seq" not in event:
        return event
    clone = dict(event)
    clone.pop("seq", None)
    return clone


def _persist_snapshot(final: bool = False) -> None:
    meta = CACHE.get("meta")
    if not meta:
        return

    snapshot = {
        "gameId": CACHE.get("game_id"),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "meta": meta,
        "events": CACHE.get("events", []),
        "lastSeq": CACHE.get("last_seq", 0),
        "final": bool(final or CACHE.get("final")),
    }

    s3.put_object(
        Bucket=LIVE_BUCKET,
        Key=LIVE_SNAPSHOT_KEY,
        Body=json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False),
        ContentType="application/json",
        CacheControl="no-store",
    )


def _load_snapshot() -> Optional[Dict[str, Any]]:
    if CACHE.get("meta") or CACHE.get("events"):
        return {
            "meta": CACHE.get("meta"),
            "events": CACHE.get("events", []),
            "lastSeq": CACHE.get("last_seq", 0),
            "final": CACHE.get("final", False),
        }

    try:
        obj = s3.get_object(Bucket=LIVE_BUCKET, Key=LIVE_SNAPSHOT_KEY)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("NoSuchKey", "404"):
            return None
        logger.exception("Failed to load snapshot from S3")
        return None

    try:
        body = obj["Body"].read().decode("utf-8")
        parsed = json.loads(body)
    except Exception:
        logger.exception("Failed to parse snapshot body")
        return None

    # Warm the cache to reduce further S3 reads.
    CACHE["meta"] = parsed.get("meta")
    CACHE["events"] = parsed.get("events", [])
    CACHE["last_seq"] = parsed.get("lastSeq", 0)
    CACHE["final"] = parsed.get("final", False)
    return {
        "meta": CACHE.get("meta"),
        "events": CACHE.get("events", []),
        "lastSeq": CACHE.get("last_seq", 0),
        "final": CACHE.get("final", False),
    }


def _replay_state_to_connection(event: Dict[str, Any], connection_id: str) -> None:
    _maybe_finalize_idle(event, time.time())
    snapshot = _load_snapshot()
    if not snapshot:
        logger.info("Replay requested by %s but no snapshot found", connection_id)
        return

    client = _api_client(event)
    meta = snapshot.get("meta")
    events = snapshot.get("events") or []
    last_seq = snapshot.get("lastSeq", 0)
    final = snapshot.get("final", False)

    if not events:
        payload = {
            "action": "snapshot",
            "data": {
                "meta": meta,
                "events": [],
                "lastSeq": last_seq,
                "final": final,
                "isFirst": True,
                "isLast": True,
            },
        }
        _safe_post(client, connection_id, payload)
        return

    chunks = list(_chunk_events(events, REPLAY_CHUNK_SIZE))
    for idx, chunk in enumerate(chunks):
        payload = {
            "action": "snapshot",
            "data": {
                "meta": meta if idx == 0 else None,
                "events": chunk,
                "seqStart": chunk[0].get("seq"),
                "seqEnd": chunk[-1].get("seq"),
                "lastSeq": last_seq,
                "final": final,
                "isFirst": idx == 0,
                "isLast": idx == len(chunks) - 1,
            },
        }
        if not _safe_post(client, connection_id, payload):
            return


def _broadcast(event: Dict[str, Any], payload: Dict[str, Any]) -> None:
    client = _api_client(event)
    scan_kwargs: Dict[str, Any] = {}
    stale: List[str] = []

    while True:
        resp = CONNECTIONS_TABLE.scan(**scan_kwargs)
        for item in resp.get("Items", []):
            connection_id = item["connectionId"]
            if not _safe_post(client, connection_id, payload):
                stale.append(connection_id)
        if "LastEvaluatedKey" not in resp:
            break
        scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

    for connection_id in stale:
        _remove_connection(connection_id)


def _api_client(event: Dict[str, Any]):
    domain = event["requestContext"]["domainName"]
    stage = event["requestContext"]["stage"]
    endpoint = f"https://{domain}/{stage}"
    return boto3.client("apigatewaymanagementapi", endpoint_url=endpoint)


def _safe_post(client, connection_id: str, payload: Dict[str, Any]) -> bool:
    data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    endpoint = getattr(getattr(client, "meta", None), "endpoint_url", None)
    try:
        client.post_to_connection(ConnectionId=connection_id, Data=data)
        return True
    except client.exceptions.GoneException as e:
        logger.info(
            "Connection %s is gone (endpoint=%s): %s",
            connection_id,
            endpoint,
            e,
        )
        return False
    except ClientError as e:
        logger.exception(
            "Failed to send payload to %s (endpoint=%s): %s",
            connection_id,
            endpoint,
            e,
        )
        return False


def _derive_game_id(meta: Dict[str, Any]) -> str:
    raw = meta.get("gameId")
    if raw:
        return str(raw)

    start = meta.get("startTime", "")
    digits = re.sub(r"\D", "", str(start))
    if len(digits) >= 12:
        return digits[:12]

    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M")


def _safe_title(value: str) -> str:
    cleaned = re.sub(r"\s+", "_", value.strip())
    cleaned = re.sub(r"[^A-Za-z0-9_\-]", "", cleaned)
    return cleaned or "Game"
