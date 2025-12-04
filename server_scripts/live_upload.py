import os
import json
import time
import win32file
import win32con
import websocket

# -------------------------------------------------------------------
# CONFIG
# -------------------------------------------------------------------

# Folder where the game .tdf files are written
WATCH_DIR = r"C:\path\to\tdf\folder"

# Your API Gateway WebSocket endpoint
WS_URL    = "wss://1km1prnds5.execute-api.ap-southeast-2.amazonaws.com/production"

FILE_EXT  = ".tdf"

# Time (seconds) with no file writes before we assume the game is over
IDLE_GAME_TIMEOUT = 10


# -------------------------------------------------------------------
# WEBSOCKET HANDLING
# -------------------------------------------------------------------

def connect_ws():
    while True:
        try:
            # sslopt={"cert_reqs": 0} avoids cert issues; tighten later if you
            # install proper certs. For now it's fine for internal use.
            ws = websocket.create_connection(WS_URL, sslopt={"cert_reqs": 0})
            print("Connected to WebSocket")
            return ws
        except Exception as e:
            print("Failed to connect, retrying in 3s:", e)
            time.sleep(3)

def send_event(ws, event: dict):
    """
    Send a gameplay event:
      { action: "event", data: "<JSON string>" }
    """
    payload = {
        "action": "event",
        "data": json.dumps(event, ensure_ascii=False)
    }
    ws.send(json.dumps(payload))

def send_metadata(ws, metadata: dict):
    """
    Send game metadata:
      { action: "metadata", data: { ... } }
    """
    payload = {
        "action": "metadata",
        "data": metadata,
    }
    ws.send(json.dumps(payload))


# -------------------------------------------------------------------
# AUTO-DETECT NEWEST .TDF
# -------------------------------------------------------------------

def newest_tdf():
    """Return full path to the newest .tdf file in WATCH_DIR, or None."""
    try:
        candidates = [
            os.path.join(WATCH_DIR, f)
            for f in os.listdir(WATCH_DIR)
            if f.lower().endswith(FILE_EXT)
        ]
    except FileNotFoundError:
        return None

    if not candidates:
        return None

    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return candidates[0]

# -------------------------------------------------------------------
# TAIL A SINGLE FILE, AUTOSWITCH WHEN A NEWER GAME APPEARS
# -------------------------------------------------------------------

def tail_file(ws, path: str):
    print(f"Streaming game file: {path}")
    state = TDFStreamState()

    fh = open(path, "r", encoding="utf-16-le", errors="ignore")
    fh.seek(0, os.SEEK_END)

    dir_path = os.path.dirname(path)
    filename = os.path.basename(path)

    hDir = win32file.CreateFile(
        dir_path,
        win32con.GENERIC_READ,
        win32con.FILE_SHARE_READ | win32con.FILE_SHARE_WRITE | win32con.FILE_SHARE_DELETE,
        None,
        win32con.OPEN_EXISTING,
        win32con.FILE_FLAG_BACKUP_SEMANTICS,
        None,
    )

    last_activity = time.time()

    while True:
        # If a newer .tdf appears, switch immediately
        latest = newest_tdf()
        if latest and latest != path:
            print("Newer game file detected:", latest)
            return latest  # caller will switch to it

        results = win32file.ReadDirectoryChangesW(
            hDir,
            1024,
            False,
            win32con.FILE_NOTIFY_CHANGE_LAST_WRITE,
            None,
            None,
        )

        got_new_data = False

        for action, fname in results:
            if fname == filename:
                line = fh.readline()
                while line:
                    got_new_data = True
                    items = state.process_line(line)
                    for item in items:
                        try:
                            if "__meta__" in item:
                                send_metadata(ws, item["__meta__"])
                            else:
                                send_event(ws, item)
                        except Exception:
                            print("WebSocket send failed, reconnecting...")
                            ws = connect_ws()
                            if "__meta__" in item:
                                send_metadata(ws, item["__meta__"])
                            else:
                                send_event(ws, item)
                    line = fh.readline()

        if got_new_data:
            last_activity = time.time()
        else:
            # If file has been idle for a while, consider game over and switch
            if time.time() - last_activity > IDLE_GAME_TIMEOUT:
                latest = newest_tdf()
                if latest and latest != path:
                    print("Game idle; switching to new file:", latest)
                    return latest
                # If no newer file yet, keep waiting
            time.sleep(0.1)


# -------------------------------------------------------------------
# MAIN LOOP
# -------------------------------------------------------------------

def main():
    ws = connect_ws()
    print("Watching directory:", WATCH_DIR)

    current = None

    while True:
        newest = newest_tdf()
        if newest and newest != current:
            current = newest
            current = tail_file(ws, current)
        else:
            time.sleep(1)

if __name__ == "__main__":
    main()
