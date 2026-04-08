import csv
import json
import math
from datetime import datetime
from io import StringIO
from urllib.parse import unquote_plus

LOG_WARNINGS = False

KNOWN_HEADERS = {
    "info": ["file-version", "program-version", "centre"],
    "mission": ["type", "desc", "start", "duration", "penalty"],
    "team": ["index", "desc", "colour-enum", "colour-desc", "colour-rgb"],
    "event": ["time", "type", "varies"],
    "entity-start": ["time", "id", "type", "desc", "team", "level", "category", "battlesuit", "memberId"],
    "player-state": ["time", "entity", "state"],
    "score": ["time", "entity", "old", "delta", "new"],
    "entity-end": ["time", "id", "type", "score"],
}

IGNORED_EVENT_TYPES = {"0201", "0500", "0207", "0902"}
TAG_EVENT_TYPES = {"0206", "0208", "0205"}
STATIC_BASE_GAMES = {"zltac settings - wapl", "league laserforce", "zltac training - full game"}
BASE_COLOR_FALLBACKS = {
    "red": "#FF0000",
    "blue": "#4060FF",
    "green": "#40FF00",
    "pink": "#FF10B0",
    "yellow": "#FFFF00",
    "orange": "#FF9000",
    "white": "#FFFFFF",
}

def read_tdf(fileobj):
    sections = {key: [] for key in KNOWN_HEADERS}
    code_to_section = {}
    raw_records = []

    reader = csv.reader(fileobj, delimiter="\t")
    for row in reader:
        if not row:
            continue

        first = row[0]
        if first.startswith(";"):
            semicode, rest = first[1:].split("/", 1)
            section = rest.split()[0]
            if section in KNOWN_HEADERS:
                code_to_section[semicode] = section
            continue

        section = code_to_section.get(first)
        if not section:
            continue

        if section == "event":
            row_dict = {
                "time": row[1],
                "type": row[2],
                "varies": " ".join(row[3:]).strip(),
            }
        else:
            row_dict = dict(zip(KNOWN_HEADERS[section], row[1:]))

        sections[section].append(row_dict)
        raw_records.append((section, row_dict))

    return sections, raw_records


def compute_game_duration_seconds(parsed_data):
    duration_ms = int(parsed_data["mission"][0]["duration"])
    max_event_ms = max((int(e["time"]) for e in parsed_data["event"]), default=0)
    return math.ceil(max(duration_ms, max_event_ms) / 1000)


def build_teams(parsed_data):
    game_type = (parsed_data["mission"][0]["desc"] or "").strip()
    is_league_laserforce = game_type.lower().startswith("league laserforce")

    raw_teams = []
    for team_data in parsed_data["team"]:
        desc = team_data["desc"]
        if "Neutral" in desc:
            continue

        if is_league_laserforce and "Yellow" in desc:
            raw_teams.append(
                {
                    "id": "green",
                    "index": team_data["index"],
                    "name": "Green Team",
                    "color": "#008140",
                    "_from_yellow": True,
                }
            )
            continue

        raw_teams.append(
            {
                "id": desc.lower().split(" ")[0],
                "index": team_data["index"],
                "name": desc,
                "color": team_data["colour-rgb"],
                "_from_yellow": False,
            }
        )

    prefer_green_from_yellow = any(
        t["id"] == "green" and t.get("_from_yellow") for t in raw_teams
    )

    teams = []
    seen_ids = set()

    if prefer_green_from_yellow:
        for team in raw_teams:
            if team["id"] == "green" and team.get("_from_yellow"):
                teams.append({k: v for k, v in team.items() if k != "_from_yellow"})
                seen_ids.add("green")
                break

    for team in raw_teams:
        team_id = team["id"]
        if team_id in seen_ids:
            continue
        if prefer_green_from_yellow and team_id == "green" and not team.get("_from_yellow"):
            continue
        teams.append({k: v for k, v in team.items() if k != "_from_yellow"})
        seen_ids.add(team_id)

    return teams


def build_players_and_bases(parsed_data, teams):
    team_id_by_index = {t["index"]: t["id"] for t in teams}
    players = {}
    bases = {}

    for entity in parsed_data["entity-start"]:
        team_id = team_id_by_index.get(entity["team"])
        if entity["type"] == "player":
            players[entity["id"]] = {
                "id": entity["id"],
                "name": entity["desc"],
                "team": team_id,
            }
        elif entity["type"] == "standard-target":
            bases[entity["id"]] = {
                "id": entity["id"],
                "name": entity["desc"],
                "team": team_id or _team_id_from_base_name(entity["desc"]),
            }

    return players, bases


def _last_token(value):
    tokens = (value or "").split()
    return tokens[-1].strip() if tokens else ""


def _team_id_from_base_name(name):
    tokens = (name or "").strip().lower().split()
    return tokens[0] if tokens else None


def _team_color_for(team_id, team_color_by_id):
    return team_color_by_id.get(team_id) or BASE_COLOR_FALLBACKS.get(team_id) or "#FFFFFF"


def build_events(raw_records, players, bases, game_duration):
    events = []
    raw_len = len(raw_records)
    players_set = set(players)

    def score_event_at(index):
        if 0 <= index < raw_len and raw_records[index][0] == "score":
            return raw_records[index][1]
        return None

    def parse_deac_entities(event):
        ids = [t for t in (event.get("varies") or "").split() if t.startswith("#")]
        if len(ids) >= 2:
            return ids[0], ids[1]
        return None, None

    for i, (section, event) in enumerate(raw_records):
        if section == "player-state":
            entity = event.get("entity")
            if entity not in players_set:
                continue
            state_event_type = {"3": "deactivated", "0": "reactivated"}.get(event.get("state"))
            if state_event_type:
                events.append({"time": int(event["time"]) / 1000, "entity": entity, "target": "", "type": state_event_type, "delta": 0})
            continue

        if section != "event":
            continue

        t = int(event["time"]) / 1000
        event_type = event.get("type")

        if event_type == "0101":
            t_end = max(t, game_duration)
            for player in players.values():
                events.append({"time": t, "entity": player["id"], "target": "", "type": "game end", "delta": 0})
                events.append({"time": t_end, "entity": player["id"], "target": "", "type": "reactivated", "delta": 0})
            continue

        if event_type == "0100":
            for player in players.values():
                events.append({"time": t, "entity": player["id"], "target": "", "type": "game start", "delta": 0})
            continue

        if event_type in IGNORED_EVENT_TYPES:
            continue

        if event_type in TAG_EVENT_TYPES:
            tagger_score = score_event_at(i - 2)
            tagged_score = score_event_at(i - 1)
            tagger_id, tagged_id = parse_deac_entities(event)

            tagger_entity = tagger_score.get("entity") if tagger_score else tagger_id
            tagged_entity = tagged_score.get("entity") if tagged_score else tagged_id

            if event_type == "0208" and tagger_entity not in players_set:
                if LOG_WARNINGS:
                    print(f"base shot someone {event}")
                continue

            if not tagger_entity or not tagged_entity:
                if LOG_WARNINGS:
                    print(f"weird event parse issue: {event}")
                continue

            is_stun = event_type == "0205"
            events.append({"time": t, "entity": tagger_entity, "target": tagged_entity, "type": "stun" if is_stun else "tag", "delta": int(tagger_score["delta"]) if tagger_score else 0})
            events.append({"time": t, "entity": tagged_entity, "target": tagger_entity, "type": "stunned" if is_stun else "tagged", "delta": int(tagged_score["delta"]) if tagged_score else 0})
            continue

        if event_type in {"0203", "0204"}:
            score_event = raw_records[i - 1][1]
            base_id = _last_token(event.get("varies"))
            if base_id not in bases:
                if LOG_WARNINGS:
                    print("WARN base id not found", {"base_id": base_id, "event": event})
                continue
            events.append({"time": t, "entity": score_event["entity"], "target": bases[base_id]["team"], "type": "base hit" if event_type == "0203" else "base destroy", "delta": int(score_event["delta"])})
            continue

        if event_type in {"0B01", "0B02"}:
            score_event = raw_records[i - 1][1]
            denied = _last_token(event.get("varies"))
            events.append({"time": t, "entity": score_event["entity"], "target": denied, "type": "deny", "delta": int(score_event["delta"])})
            events.append({"time": t, "entity": denied, "target": score_event["entity"], "type": "denied", "delta": 0})
            continue

        if event_type == "0600":
            penalty_entity = (event.get("varies") or "").split()
            events.append({"time": t, "entity": penalty_entity[0].strip() if penalty_entity else "", "target": "", "type": "penalty", "delta": int(raw_records[i - 1][1]["delta"])})
            continue

        if event.get("entity") not in players and LOG_WARNINGS:
            print(f"Unknown event: {event}")

    return events


def build_active_bases(raw_records, bases, team_color_by_id):
    active_bases = []
    seen = set()

    def add_active_base(team_id):
        if not team_id or team_id in seen:
            return
        seen.add(team_id)
        active_bases.append({"id": team_id, "color": _team_color_for(team_id, team_color_by_id)})

    for section, event in raw_records:
        if section != "event" or event.get("type") not in {"0203", "0204"}:
            continue
        base_id = _last_token(event.get("varies"))
        base = bases.get(base_id)
        if not base:
            continue
        base_team = base["team"] if base.get("team") else _team_id_from_base_name(base.get("name"))
        add_active_base(base_team)

    return active_bases


def build_output(parsed_data, raw_records):
    game_duration = compute_game_duration_seconds(parsed_data)

    all_teams = build_teams(parsed_data)
    team_color_by_id = {team["id"]: team["color"] for team in all_teams}
    players, bases = build_players_and_bases(parsed_data, all_teams)
    teams = [t for t in all_teams if t["id"] in {p["team"] for p in players.values() if p.get("team")}]  # remove empty teams
    events = build_events(raw_records, players, bases, game_duration)
    active_bases = build_active_bases(raw_records, bases, team_color_by_id)
    if parsed_data["mission"][0]["desc"].lower() in STATIC_BASE_GAMES:
        seen_active_base_ids = {base["id"] for base in active_bases}
        for team in all_teams:
            team_id = team["id"]
            if team_id in seen_active_base_ids:
                continue
            active_bases.append({"id": team_id, "color": _team_color_for(team_id, team_color_by_id)})
            seen_active_base_ids.add(team_id)

    output = {
        "gameDuration": game_duration,
        "penalty": int(parsed_data["mission"][0]["penalty"]),
        "startTime": datetime.strptime(
            parsed_data["mission"][0]["start"], "%Y%m%d%H%M%S"
        ).strftime("%Y-%m-%d %H:%M"),
        "gameType": parsed_data["mission"][0]["desc"],
        "teams": teams,
        "players": players,
        "active_bases": active_bases,
        "events": events,
    }

    output_filename = (
        f"games/{parsed_data['mission'][0]['start']}@"
        f"{parsed_data['mission'][0]['desc'].replace(' ', '_')}.json"
    )
    return output, output_filename


def process_tdf_bytes(body):
    parsed_data, raw_records = read_tdf(StringIO(body.decode("utf-16-le")))
    return build_output(parsed_data, raw_records)


def lambda_handler(event, context):
    import boto3

    s3 = boto3.client("s3")
    bucket = event["Records"][0]["s3"]["bucket"]["name"]
    key = unquote_plus(event["Records"][0]["s3"]["object"]["key"])

    if not key.lower().endswith(".tdf"):
        print(f"Skipping non-tdf file: {key}")
        return {"status": "skipped"}

    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    output, output_filename = process_tdf_bytes(body)

    s3.put_object(
        Bucket=bucket,
        Key=output_filename,
        Body=json.dumps(output, indent=2, ensure_ascii=False),
        ContentType="application/json",
    )

    print(f"Uploaded {output_filename}")
    return {"status": "ok", "output": output_filename}


# Local Helper
""" import argparse
from pathlib import Path

def parse_args():
    p = argparse.ArgumentParser(description="Convert .tdf to game JSON")
    p.add_argument("input", help="Path to .tdf file")
    p.add_argument("-o", "--output", help="Path to output JSON")
    p.add_argument("--compact", action="store_true", help="Minified JSON")
    return p.parse_args()

def main():
    args = parse_args()
    tdf_path = Path(args.input)
    body = tdf_path.read_bytes()
    output, output_filename = process_tdf_bytes(body)

    if args.output:
        out_path = Path(args.output)
    else:
        out_path = tdf_path.with_suffix(".json")

    if args.compact:
        out_path.write_text(json.dumps(output, ensure_ascii=False))
    else:
        out_path.write_text(json.dumps(output, indent=2, ensure_ascii=False))

    print(f"Wrote {out_path} (source: {output_filename})")

if __name__ == "__main__":
    main()
 """
