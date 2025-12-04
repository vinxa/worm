import collections

# -------------------------------------------------------------------
# STREAMING TDF PARSER
# -------------------------------------------------------------------

KNOWN_HEADERS = {
    "info":          ["file-version", "program-version", "centre"],
    "mission":       ["type", "desc", "start", "duration", "penalty"],
    "team":          ["index", "desc", "colour-enum", "colour-desc", "colour-rgb"],
    "event":         ["time", "type", "varies"],
    "entity-start":  ["time", "id", "type", "desc", "team", "level", "category", "battlesuit", "memberId"],
    "player-state":  ["time", "entity", "state"],
    "score":         ["time", "entity", "old", "delta", "new"],
    "entity-end":    ["time", "id", "type", "score"],
}

class TDFStreamState:
    """
    Incremental parser for a Laserforce-style TDF log.

    - Keeps lightweight state for mission, teams, players, bases.
    - Maintains a small window of recent records to reconstruct composite events.
    - Emits:
        - metadata once (when mission + teams + players known)
        - gameplay events continuously.
    """
    def __init__(self):
        self.code_to_section = {}         # "0" -> "info", "4" -> "event", etc.
        self.mission_row = None           # mission row dict
        self.teams_by_index = {}          # "0" -> team dict
        self.players = {}                 # playerId -> {id, name, team}
        self.bases = {}                   # baseId   -> {id, name, team}
        self.raw_window = collections.deque(maxlen=5)
        self.metadata_sent = False
        self._last_meta_player_count = 0
        self._last_meta_base_count = 0

    # ------------- low-level parsing -------------

    def parse_row(self, line: str):
        """
        Parse a single TDF line into (section_name, row_dict) or (None, None).
        """
        line = line.lstrip("\ufeff").rstrip("\r\n")
        if not line:
            return None, None

        parts = line.split("\t")
        if not parts:
            return None, None

        first = parts[0]

        # Section header row: ;0/info, ;1/mission, etc.
        if first.startswith(";"):
            semi = first[1:]
            if "/" in semi:
                code, rest = semi.split("/", 1)
                section = rest.split()[0]      # "info", "mission", "event", etc.
                if section in KNOWN_HEADERS:
                    self.code_to_section[code] = section
            return None, None

        # Data row
        code = first
        section = self.code_to_section.get(code)
        if not section:
            return None, None

        if section == "event":
            if len(parts) < 3:
                return None, None
            row = {
                "time": parts[1],
                "type": parts[2],
                "varies": " ".join(parts[3:]).strip()
            }
        else:
            headers = KNOWN_HEADERS[section]
            data = parts[1:]
            row = {k: v for k, v in zip(headers, data)}

        return section, row

    # ------------- section handlers -------------

    def handle_section(self, section: str, row: dict):
        if section == "mission":
            # type, desc, start (YYYYMMDDHHMMSS), duration (ms), penalty
            self.mission_row = row

        elif section == "team":
            desc = row["desc"]
            index = row["index"]
            if "Neutral" in desc:
                return
            if "Yellow" in desc:
                team = {
                    "id": "green",
                    "index": index,
                    "name": "Green Team",
                    "color": "#008140"
                }
            else:
                team = {
                    "id": desc.lower().split(" ")[0],
                    "index": index,
                    "name": desc,
                    "color": row["colour-rgb"]
                }
            self.teams_by_index[index] = team

        elif section == "entity-start":
            ttype = row["type"]
            idx = row["team"]
            team = self.teams_by_index.get(idx)
            team_id = team["id"] if team else None

            if ttype == "player":
                self.players[row["id"]] = {
                    "id": row["id"],
                    "name": row["desc"],
                    "team": team_id
                }
            elif ttype == "standard-target":
                self.bases[row["id"]] = {
                    "id": row["id"],
                    "name": row["desc"],
                    "team": team_id
                }

    # ------------- metadata -------------

    def metadata_ready(self) -> bool:
        if not self.mission_row:
            return False
        if not self.teams_by_index:
            return False
        if not self.players:
            return False
        return True

    def build_metadata(self) -> dict:
        m = self.mission_row
        raw = m["start"]  # "YYYYMMDDHHMMSS"

        # Format start time as "YYYY-MM-DD HH:MM"
        start = f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]} {raw[8:10]}:{raw[10:12]}"

        metadata = {
            "gameDuration": int(int(m["duration"]) / 1000),
            "penalty": int(m["penalty"]),
            "startTime": start,
            "gameType": m["desc"],
            "teams": list(self.teams_by_index.values()),
            "players": self.players,
            "bases": self.bases
        }
        return metadata

    # ------------- event processing -------------

    def prev_score(self, n: int):
        count = 0
        for sect, row in reversed(self.raw_window):
            if sect == "score":
                count += 1
                if count == n:
                    return row
        return None

    def events_from_event_row(self, row: dict):
        events = []
        try:
            t = int(row["time"]) / 1000.0
        except Exception:
            return []

        etype = row["type"]

        # game start
        if etype == "0100":
            for p in self.players.values():
                events.append({
                    "time": t,
                    "entity": p["id"],
                    "target": "",
                    "type": "game start",
                    "delta": 0
                })
            return events

        # game end
        if etype == "0101":
            for p in self.players.values():
                events.append({
                    "time": t,
                    "entity": p["id"],
                    "target": "",
                    "type": "game end",
                    "delta": 0
                })
            return events

        # deacs -> tag/tagged
        if etype in ("0206", "0208"):
            tagger = self.prev_score(2)
            tagged = self.prev_score(1)
            if tagger and tagged:
                events.append({
                    "time": t,
                    "entity": tagger["entity"],
                    "target": tagged["entity"],
                    "type": "tag",
                    "delta": int(tagger["delta"])
                })
                events.append({
                    "time": t,
                    "entity": tagged["entity"],
                    "target": tagger["entity"],
                    "type": "tagged",
                    "delta": int(tagged["delta"])
                })
            return events

        # base hit
        if etype == "0203":
            score = self.prev_score(1)
            if not score:
                return []
            base_id = row["varies"].split()[-1].strip()
            team = self.bases.get(base_id, {}).get("team", "")
            events.append({
                "time": t,
                "entity": score["entity"],
                "delta": int(score["delta"]),
                "type": "base hit",
                "target": team
            })
            return events

        # base destroy
        if etype == "0204":
            score = self.prev_score(1)
            if not score:
                return []
            base_id = row["varies"].split()[-1].strip()
            team = self.bases.get(base_id, {}).get("team", "")
            events.append({
                "time": t,
                "entity": score["entity"],
                "delta": int(score["delta"]),
                "type": "base destroy",
                "target": team
            })
            return events

        # deny
        if etype in ("0B01", "0B02"):
            score = self.prev_score(1)
            if not score:
                return []
            denied = row["varies"].split()[-1].strip()
            events.append({
                "time": t,
                "entity": score["entity"],
                "target": denied,
                "type": "deny",
                "delta": int(score["delta"])
            })
            events.append({
                "time": t,
                "entity": denied,
                "target": score["entity"],
                "type": "denied",
                "delta": 0
            })
            return events

        # penalty
        if etype == "0600":
            score = self.prev_score(1)
            if not score:
                return []
            ent = row["varies"].split()[0].strip()
            events.append({
                "time": t,
                "entity": ent,
                "target": "",
                "type": "penalty",
                "delta": int(score["delta"])
            })
            return events

        # ignore other event types (miss, reload, stun, achievements, etc.)
        return []

    # ------------- main entry -------------

    def process_line(self, line: str):
        """
        Process a single new TDF line.
        Returns a list of "items":
          - either {"__meta__": <metadata dict>}   (once)
          - or    {"time":..., "entity":..., ...}  (events)
        """
        section, row = self.parse_row(line)
        if not section:
            return []

        self.raw_window.append((section, row))
        self.handle_section(section, row)

        items = []

        # Emit metadata when we have mission + teams + at least one player,
        # and whenever the roster grows (supports late joiners).
        if self.metadata_ready():
            player_count = len(self.players)
            base_count = len(self.bases)
            if (not self.metadata_sent) or (
                player_count != self._last_meta_player_count
                or base_count != self._last_meta_base_count
            ):
                meta = self.build_metadata()
                items.append({"__meta__": meta})
                self.metadata_sent = True
                self._last_meta_player_count = player_count
                self._last_meta_base_count = base_count

        # Emit gameplay events
        if section == "event":
            items.extend(self.events_from_event_row(row))

        return items
