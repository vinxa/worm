import json
import logging
import os
from decimal import Decimal
from typing import Any, Dict, List, Optional

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
STATE_TABLE = dynamodb.Table(_require_env("STATE_TABLE"))
STATE_PK = os.environ.get("STATE_PK", "current")
MAX_EVENT_HISTORY = int(os.environ.get("MAX_EVENT_HISTORY", "600"))


def lambda_handler(event, _context):
    """
    Entry point for the API Gateway WebSocket integration. Route keys supported:
      - $connect:    store connection id and replay cached metadata/events
      - $disconnect: drop connection id
      - metadata:    cache latest metadata and broadcast to all connections
      - event:       append gameplay event to cache and broadcast
    """
    route = event["requestContext"]["routeKey"]
    connection_id = event["requestContext"]["connectionId"]
    logger.info("route=%s connection=%s", route, connection_id)

    if route == "$connect":
        _add_connection(connection_id)
        # Do not replay inside $connect; the connection isn’t fully open yet.
        # Clients can request a replay explicitly once the socket is established.
        return {"statusCode": 200}

    if route == "$disconnect":
        _remove_connection(connection_id)
        return {"statusCode": 200}

    if route == "metadata":
        metadata = _extract_payload(event)
        if not isinstance(metadata, dict):
            logger.warning("Received non-object metadata payload: %s", metadata)
            return {"statusCode": 400}
        _set_metadata(metadata)
        _broadcast(event, {"action": "metadata", "data": metadata})
        return {"statusCode": 200}

    if route == "event":
        payload = _extract_payload(event)
        if not isinstance(payload, dict):
            logger.warning("Received non-object event payload: %s", payload)
            return {"statusCode": 400}
        _append_event(payload)
        _broadcast(event, {"action": "event", "data": payload})
        return {"statusCode": 200}

    if route == "replay":
        # Explicit client request to resend cached metadata/events
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
            # Some clients send already-serialized JSON strings; fall back to raw string.
            return data
    return data


def _add_connection(connection_id: str) -> None:
    CONNECTIONS_TABLE.put_item(Item={"connectionId": connection_id})


def _remove_connection(connection_id: str) -> None:
    CONNECTIONS_TABLE.delete_item(Key={"connectionId": connection_id})


def _set_metadata(metadata: Dict[str, Any]) -> None:
    # When a new game starts, reset the event buffer.
    STATE_TABLE.put_item(
        Item={
            "pk": STATE_PK,
            "metadata": metadata,
            "events": [],
        }
    )


def _append_event(event: Dict[str, Any]) -> None:
    # Store events as JSON strings so floats remain precise for DynamoDB.
    serialized = json.dumps(event, separators=(",", ":"))
    resp = STATE_TABLE.update_item(
        Key={"pk": STATE_PK},
        UpdateExpression="SET events = list_append(if_not_exists(events, :empty), :evt)",
        ExpressionAttributeValues={
            ":empty": [],
            ":evt": [serialized],
        },
        ReturnValues="ALL_NEW",
    )
    events: List[str] = resp["Attributes"].get("events", [])
    if len(events) > MAX_EVENT_HISTORY:
        trimmed = events[-MAX_EVENT_HISTORY:]
        STATE_TABLE.update_item(
            Key={"pk": STATE_PK},
            UpdateExpression="SET events = :trimmed",
            ExpressionAttributeValues={":trimmed": trimmed},
        )


def _replay_state_to_connection(event: Dict[str, Any], connection_id: str) -> None:
    item = STATE_TABLE.get_item(Key={"pk": STATE_PK}).get("Item")
    if not item:
        logger.info("Replay requested by %s but no state found", connection_id)
        return

    client = _api_client(event)

    metadata = _normalize(item.get("metadata"))
    if metadata:
        if not _safe_post(client, connection_id, {"action": "metadata", "data": metadata}):
            logger.info("Replay metadata to %s failed; keeping connection for future events", connection_id)
            return
    else:
        logger.info("Replay requested by %s but no metadata present", connection_id)

    events: List[str] = item.get("events") or []
    logger.info("Replaying %d events to %s", len(events), connection_id)
    for serialized in events:
        try:
            parsed = json.loads(serialized)
        except json.JSONDecodeError:
            logger.warning("Skipping corrupt cached event: %s", serialized)
            continue
        if not _safe_post(client, connection_id, {"action": "event", "data": parsed}):
            logger.info("Replay event to %s failed; keeping connection for future events", connection_id)
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
    data = json.dumps(payload).encode("utf-8")
    endpoint = getattr(getattr(client, "meta", None), "endpoint_url", None)
    try:
        logger.info("Sending payload to %s", connection_id)
        client.post_to_connection(ConnectionId=connection_id, Data=data)
        return True
    except client.exceptions.GoneException as e:
        # 410 Gone usually means the endpoint URL (domain/stage) doesn't match
        # the live connection, or the client disconnected immediately.
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


def _normalize(value: Any) -> Any:
    if isinstance(value, Decimal):
        if value % 1 == 0:
            return int(value)
        return float(value)
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items()}
    return value
