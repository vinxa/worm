import argparse
import csv
import json
import math
from datetime import datetime
from io import StringIO
from pathlib import Path
from urllib.parse import unquote_plus



def read_tdf(fileobj):
    known_headers = {
        "info": ["file-version", "program-version", "centre"],
        "mission": ["type", "desc", "start", "duration", "penalty"],
        "team": ["index", "desc", "colour-enum", "colour-desc", "colour-rgb"],
        "event": ["time", "type", "varies"],
        "entity-start": [
            "time",
            "id",
            "type",
            "desc",
            "team",
            "level",
            "category",
            "battlesuit",
            "memberId",
        ],
        "player-state": ["time", "entity", "state"],
        "score": ["time", "entity", "old", "delta", "new"],
        "entity-end": ["time", "id", "type", "score"],
    }

    sections = {key: [] for key in known_headers}
    code_to_section = {}
    raw_records = []  # preserve file order for cross-section parsing

    reader = csv.reader(fileobj, delimiter="\t")
    for row in reader:
        if not row:
            continue
        if row[0].startswith(";"):
            semicode, rest = row[0][1:].split("/", 1)
            section = rest.split()[0]
            if section in known_headers:
                code_to_section[semicode] = section
            continue

        code = row[0]
        section = code_to_section.get(code)
        if not section:
            continue

        if section == "event":
            row_dict = {
                "time": row[1],
                "type": row[2],
                "varies": " ".join(row[3:]).strip(),
            }
        else:
            data = row[1:]
            headers = known_headers[section]
            row_dict = {key: val for key, val in zip(headers, data)}

        sections[section].append(row_dict)
        raw_records.append((section, row_dict))

    return sections, raw_records


def compute_game_duration_seconds(parsed_data):
    duration_ms = int(parsed_data["mission"][0]["duration"])
    max_event_ms = max((int(e["time"]) for e in parsed_data["event"]), default=0)
    return math.ceil(max(duration_ms, max_event_ms) / 1000)


def build_teams(parsed_data):
    game_type = (parsed_data["mission"][0]["desc"] or "").strip()
    is_league_laserforce = game_type.lower() == "league laserforce"

    raw_teams = []
    for team_data in parsed_data["team"]:
        if "Neutral" in team_data["desc"]:
            continue
        if is_league_laserforce and "Yellow" in team_data["desc"]:
            team = {
                "id": "green",
                "index": team_data["index"],
                "name": "Green Team",
                "color": "#008140",
                "_from_yellow": True,
            }
        else:
            team = {
                "id": team_data["desc"].lower().split(" ")[0],
                "index": team_data["index"],
                "name": team_data["desc"],
                "color": team_data["colour-rgb"],
                "_from_yellow": False,
            }
        raw_teams.append(team)

    prefer_green_from_yellow = any(
        t["id"] == "green" and t.get("_from_yellow") for t in raw_teams
    )
    seen_ids = set()
    teams = []

    if prefer_green_from_yellow:
        for t in raw_teams:
            if t["id"] == "green" and t.get("_from_yellow"):
                teams.append({k: v for k, v in t.items() if k != "_from_yellow"})
                seen_ids.add("green")
                break

    for t in raw_teams:
        team_id = t["id"]
        if team_id in seen_ids:
            continue
        if prefer_green_from_yellow and team_id == "green" and not t.get("_from_yellow"):
            continue
        teams.append({k: v for k, v in t.items() if k != "_from_yellow"})
        seen_ids.add(team_id)

    return teams


def build_players_and_bases(parsed_data, teams):
    players = {}
    bases = {}
    for entity in parsed_data["entity-start"]:
        if entity["type"] == "player":
            players[entity["id"]] = {
                "id": entity["id"],
                "name": entity["desc"],
                "team": next(
                    (t["id"] for t in teams if t["index"] == entity["team"]),
                    None,
                ),
            }
        elif entity["type"] == "standard-target":
            bases[entity["id"]] = {
                "id": entity["id"],
                "name": entity["desc"],
                "team": next(
                    (t["id"] for t in teams if t["index"] == entity["team"]),
                    None,
                ),
            }
    return players, bases


def drop_empty_teams(teams, players):
    used_team_ids = {p["team"] for p in players.values() if p.get("team")}
    return [t for t in teams if t["id"] in used_team_ids]


def build_events(raw_records, players, bases, game_duration):
    def score_event_at(index):
        if 0 <= index < len(raw_records) and raw_records[index][0] == "score":
            return raw_records[index][1]
        return None

    def parse_deac_entities(event):
        tokens = (event.get("varies") or "").split()
        ids = [t for t in tokens if t.startswith("#")]
        if len(ids) >= 2:
            return ids[0], ids[1]
        return None, None

    events = []
    for i, (section, event) in enumerate(raw_records):
        if section == "player-state":
            entity = event.get("entity")
            if entity not in players:
                continue
            t = int(event["time"]) / 1000
            state = event.get("state")
            if state == "3":
                events.append(
                    {
                        "time": t,
                        "entity": entity,
                        "target": "",
                        "type": "deactivated",
                        "delta": 0,
                    }
                )
            elif state == "0":
                events.append(
                    {
                        "time": t,
                        "entity": entity,
                        "target": "",
                        "type": "reactivated",
                        "delta": 0,
                    }
                )
            continue

        if section != "event":
            continue

        t = int(event["time"]) / 1000

        match event["type"]:
            case "0101":  # game end
                t_end = max(t, game_duration)
                for player in players.values():
                    events.append(
                        {
                            "time": t,
                            "entity": player["id"],
                            "target": "",
                            "type": "game end",
                            "delta": 0,
                        }
                    )
                    events.append(
                        {
                            "time": t_end,
                            "entity": player["id"],
                            "target": "",
                            "type": "reactivated",
                            "delta": 0,
                        }
                    )

            case "0100":  # game start
                for player in players.values():
                    events.append(
                        {
                            "time": t,
                            "entity": player["id"],
                            "target": "",
                            "type": "game start",
                            "delta": 0,
                        }
                    )

            case "0201" | "0500" | "0207" | "0902":
                continue

            case "0206" | "0208":  # deacs
                tagger_score = score_event_at(i - 2)
                tagged_score = score_event_at(i - 1)
                tagger_id, tagged_id = parse_deac_entities(event)

                tagger_entity = tagger_score.get("entity") if tagger_score else tagger_id
                tagged_entity = tagged_score.get("entity") if tagged_score else tagged_id

                # weird exception where reloaders tag people.
                if event["type"] == "0208" and tagger_entity not in players:
                    print(f"base shot someone {event}")
                    continue

                if not tagger_entity or not tagged_entity:
                    print(f"weird event parse issue: {event}")
                    continue

                events.append(
                    {
                        "time": t,
                        "entity": tagger_entity,
                        "target": tagged_entity,
                        "type": "tag",
                        "delta": int(tagger_score["delta"]) if tagger_score else 0,
                    }
                )
                events.append(
                    {
                        "time": t,
                        "entity": tagged_entity,
                        "target": tagger_entity,
                        "type": "tagged",
                        "delta": int(tagged_score["delta"]) if tagged_score else 0,
                    }
                )

            case "0203":  # shoot base
                score_event = raw_records[i - 1][1]
                base_id = event["varies"].split()[-1].strip()
                if base_id not in bases:
                    print("WARN base id not found", {"base_id": base_id, "event": event})
                    continue
                events.append(
                    {
                        "time": t,
                        "entity": score_event["entity"],
                        "delta": int(score_event["delta"]),
                        "type": "base hit",
                        "target": bases[base_id]["team"],
                    }
                )

            case "0204":  # destroy base
                score_event = raw_records[i - 1][1]
                base_id = event["varies"].split()[-1].strip()
                if base_id not in bases:
                    print("WARN base id not found", {"base_id": base_id, "event": event})
                    continue
                events.append(
                    {
                        "time": t,
                        "entity": score_event["entity"],
                        "delta": int(score_event["delta"]),
                        "type": "base destroy",
                        "target": bases[base_id]["team"],
                    }
                )

            case "0B01" | "0B02":  # deny
                score_event = raw_records[i - 1][1]
                denied = event["varies"].split()[-1].strip()
                events.append(
                    {
                        "time": t,
                        "entity": score_event["entity"],
                        "target": denied,
                        "type": "deny",
                        "delta": int(score_event["delta"]),
                    }
                )
                events.append(
                    {
                        "time": t,
                        "entity": denied,
                        "target": score_event["entity"],
                        "type": "denied",
                        "delta": 0,
                    }
                )

            case "0600":  # penalty
                events.append(
                    {
                        "time": t,
                        "entity": event["varies"].split()[0].strip(),
                        "delta": int(raw_records[i - 1][1]["delta"]),
                        "type": "penalty",
                        "target": "",
                    }
                )

            case _:
                if event.get("entity") not in players:
                    print(f"Unknown event: {event}")
                continue

    return events


def build_output(parsed_data, raw_records):
    game_duration = compute_game_duration_seconds(parsed_data)

    output = {
        "gameDuration": game_duration,
        "penalty": int(parsed_data["mission"][0]["penalty"]),
        "startTime": datetime.strptime(
            parsed_data["mission"][0]["start"], "%Y%m%d%H%M%S"
        ).strftime("%Y-%m-%d %H:%M"),
        "gameType": parsed_data["mission"][0]["desc"],
        "teams": [],
        "players": {},
        "events": [],
    }

    teams = build_teams(parsed_data)
    players, bases = build_players_and_bases(parsed_data, teams)
    teams = drop_empty_teams(teams, players)

    output["teams"] = teams
    output["players"] = players
    output["events"] = build_events(raw_records, players, bases, game_duration)

    output_filename = (
        f"games/{parsed_data['mission'][0]['start']}@"
        f"{parsed_data['mission'][0]['desc'].replace(' ', '_')}.json"
    )

    return output, output_filename


def parse_tdf_bytes(body):
    text_stream = StringIO(body.decode("utf-16-le"))
    return read_tdf(text_stream)


def process_tdf_bytes(body):
    parsed_data, raw_records = parse_tdf_bytes(body)
    return build_output(parsed_data, raw_records)


def lambda_handler(event, context):
    import boto3
    s3 = boto3.client("s3")
    print(f"Incoming event: {event}")
    print(f"Using context: {context}")

    bucket = event["Records"][0]["s3"]["bucket"]["name"]
    key = unquote_plus(event["Records"][0]["s3"]["object"]["key"])

    if not key.lower().endswith(".tdf"):
        print(f"Skipping non-tdf file: {key}")
        return {"status": "skipped"}

    print(f"Processing {bucket}/{key}")

    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    output, output_filename = process_tdf_bytes(body)

    s3.put_object(
        Bucket=bucket,
        Key=output_filename,
        Body=json.dumps(output, indent=2, ensure_ascii=False),
        ContentType="application/json",
    )

    print(f"Uploaded {output_filename}")
    return {"status": "ok", "output": output_filename}


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
