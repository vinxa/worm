import json
import time
import websocket
from pathlib import Path
from tdf_parser import TDFStreamState 

# -------------------------------------------------------------------
# CONFIG
# -------------------------------------------------------------------

TDF_FILE = r"/Users/gabby/Downloads/1-26 20260401210336 - Force Field Competition.tdf"
WS_URL   = "wss://1km1prnds5.execute-api.ap-southeast-2.amazonaws.com/production"

# Playback speed multiplier:
SPEED = 10

# Batch events to reduce WebSocket messages
BATCH_SIZE = 50
BATCH_INTERVAL = 1.0

# -------------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------------

def connect_ws():
    while True:
        try:
            ws = websocket.create_connection(WS_URL, sslopt={"cert_reqs": 0})
            print("Connected to Live WebSocket")
            return ws
        except Exception as e:
            print("Failed to connect:", e)
            time.sleep(1)


def send_metadata(ws, metadata):
    payload = {"action": "metadata", "data": metadata}
    ws.send(json.dumps(payload))
    print(">>> METADATA SENT")


def send_event(ws, event):
    payload = {"action": "event", "data": json.dumps(event)}
    ws.send(json.dumps(payload))
    print(">>> EVENT:", event)

def send_event_batch(ws, events):
    if not events:
        return
    payload = {"action": "event_batch", "data": events}
    ws.send(json.dumps(payload))
    print(f">>> EVENT BATCH: {len(events)}")

# -------------------------------------------------------------------
# MAIN SIMULATOR
# -------------------------------------------------------------------

def simulate_live_stream():
    tdf_path = Path(TDF_FILE)
    raw = tdf_path.read_text(encoding="utf-16-le", errors="ignore").splitlines()

    ws = connect_ws()
    parser = TDFStreamState()

    last_time = None
    event_buffer = []
    last_flush = time.time()

    for line in raw:
        items = parser.process_line(line)
        for item in items:
            if "__meta__" in item:
                if event_buffer:
                    send_event_batch(ws, event_buffer)
                    event_buffer = []
                    last_flush = time.time()
                send_metadata(ws, item["__meta__"])
            else:
                ev = item
                event_buffer.append(ev)
                now = time.time()
                if len(event_buffer) >= BATCH_SIZE or (now - last_flush) >= BATCH_INTERVAL:
                    send_event_batch(ws, event_buffer)
                    event_buffer = []
                    last_flush = now

                # Simulate timing between events
                # Using "time" field inside events for realism
                if last_time is not None:
                    dt = ev["time"] - last_time
                    if dt > 0:
                        time.sleep(dt / SPEED)
                last_time = ev["time"]

    if event_buffer:
        send_event_batch(ws, event_buffer)

    print("=== Simulation Complete ===")
    ws.close()


if __name__ == "__main__":
    simulate_live_stream()
