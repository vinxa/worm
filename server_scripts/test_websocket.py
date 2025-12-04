import json
import time
import websocket
from pathlib import Path
from tdf_parser import TDFStreamState 

# -------------------------------------------------------------------
# CONFIG
# -------------------------------------------------------------------

TDF_FILE = r"/Users/gabby/Downloads/1-26-20250223183301-ZLTAC-Training-Full-Game.tdf"
WS_URL   = "wss://1km1prnds5.execute-api.ap-southeast-2.amazonaws.com/production"

# Playback speed multiplier:
SPEED = 10

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


# -------------------------------------------------------------------
# MAIN SIMULATOR
# -------------------------------------------------------------------

def simulate_live_stream():
    tdf_path = Path(TDF_FILE)
    raw = tdf_path.read_text(encoding="utf-16-le", errors="ignore").splitlines()

    ws = connect_ws()
    parser = TDFStreamState()

    last_time = None

    for line in raw:
        items = parser.process_line(line)
        for item in items:
            if "__meta__" in item:
                send_metadata(ws, item["__meta__"])
            else:
                ev = item
                send_event(ws, ev)

                # Simulate timing between events
                # Using "time" field inside events for realism
                if last_time is not None:
                    dt = ev["time"] - last_time
                    if dt > 0:
                        time.sleep(dt / SPEED)
                last_time = ev["time"]

    print("=== Simulation Complete ===")
    ws.close()


if __name__ == "__main__":
    simulate_live_stream()
