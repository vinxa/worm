import boto3
import csv
import json
from io import StringIO
from datetime import datetime

s3 = boto3.client("s3")

def readFile(fileobj):
    known_headers = {
        "info": ["file-version", "program-version", "centre"],
        "mission": ["type", "desc", "start", "duration", "penalty"],
        "team": ["index", "desc", "colour-enum", "colour-desc", "colour-rgb"],
        "event": ["time", "type", "varies"],
        "entity-start": ["time", "id", "type", "desc", "team", "level", "category", "battlesuit"],
        "player-state": ["time", "entity", "state"],
        "score": ["time", "entity", "old", "delta", "new"],
        "entity-end": ["time", "id", "type", "score"]
    }

    sections = {key: [] for key in known_headers}
    code_to_section = {}
    raw_records = []  # to preserve file order for 4 and 5 sections

    reader = csv.reader(fileobj, delimiter="\t")
    for row in reader:
        if not row:
            continue
        if row[0].startswith(";"):
            semicode, rest = row[0][1:].split("/", 1)
            section = rest.split()[0]
            if section in known_headers:
                code_to_section[semicode] = section
        else:
            code = row[0]
            section = code_to_section.get(code)
            if not section:
                continue

            # Special case because the column is variable width
            if section == "event":
                row_dict = {
                    "time": row[1],
                    "type": row[2],
                    "varies": " ".join(row[3:]).strip()
                }
            else:
                data = row[1:]  # Skip the code
                headers = known_headers[section]
                row_dict = {key: val for key, val in zip(headers, data)}

            sections[section].append(row_dict)
            raw_records.append((section, row_dict))

    return sections, raw_records


def lambda_handler(event, context):
    bucket = event["Records"][0]["s3"]["bucket"]["name"]
    key = event["Records"][0]["s3"]["object"]["key"]

    if not key.lower().endswith(".tdf"):
        print(f"Skipping non-tdf file: {key}")
        return {"status": "skipped"}

    print(f"Processing {bucket}/{key}")

    # Download file
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj["Body"].read()

    # Decode UTF-16LE
    text_stream = StringIO(body.decode("utf-16-le"))
    parsed_data, raw_records = readFile(text_stream)

    # Build output JSON
    output = {
        "gameDuration": int(int(parsed_data["mission"][0]["duration"]) / 1000),
        "penalty": int(parsed_data["mission"][0]["penalty"]),
        "startTime": datetime.strptime(
            parsed_data["mission"][0]["start"], "%Y%m%d%H%M%S"
        ).strftime("%Y-%m-%d %H:%M"),
        "gameType": parsed_data["mission"][0]["desc"],
        "teams": [],
        "players": {},
        "events": []
    }

    bases = {}

    # Teams
    for team_data in parsed_data["team"]:
        if "Neutral" in team_data["desc"]:
            continue
        if "Yellow" in team_data["desc"]:
            team = {
                "id": "green",
                "index": team_data["index"],
                "name": "Green Team",
                "color": "#008140"
            }
        else:
            team = {
                "id": team_data["desc"].lower().split(" ")[0],
                "index": team_data["index"],
                "name": team_data["desc"],
                "color": team_data["colour-rgb"]
            }
        output["teams"].append(team)

    # Players and bases
    for player_data in parsed_data["entity-start"]:
        if player_data["type"] == "player":
            player = {
                "id": player_data["id"],
                "name": player_data["desc"],
                "team": next(
                    (team["id"] for team in output["teams"] if team["index"] == player_data["team"]),
                    None
                )
            }
            output["players"][player_data["id"]] = player
        elif player_data["type"] == "standard-target":
            base = {
                "id": player_data["id"],
                "name": player_data["desc"],
                "team": next(
                    (team["id"] for team in output["teams"] if team["index"] == player_data["team"]),
                    None
                )
            }
            bases[player_data["id"]] = base

    # Check for late logins in startup sequence
    for state in parsed_data["player-state"]:
        if state["entity"].startswith("#") and state["entity"] not in output["players"].keys():
            print(state)
    # Events (full parsing logic)
    for i, (section, event) in enumerate(raw_records):
        if section != "event":
            continue

        t = int(event["time"]) / 1000

        match event["type"]:
            case "0101":  # game end
                for player in output["players"].values():
                    output["events"].append({
                        "time": t, "entity": player["id"],
                        "target": "", "type": "game end", "delta": 0
                    })

            case "0100":  # game start
                for player in output["players"].values():
                    output["events"].append({
                        "time": t, "entity": player["id"],
                        "target": "", "type": "game start", "delta": 0
                    })

            case "0201" | "0500" | "0207" | "0902":
                # miss, reload, stun, achievements
                continue

            case "0206" | "0208":  # deacs
                tagger = raw_records[i-2][1]
                tagged = raw_records[i-1][1]
                output["events"].append({
                    "time": t, "entity": tagger["entity"],
                    "target": tagged["entity"], "type": "tag",
                    "delta": int(tagger["delta"])
                })
                # Append event for tagged player
                output["events"].append({
                    "time": t, "entity": tagged["entity"],
                    "target": tagger["entity"], "type": "tagged",
                    "delta": int(tagged["delta"])
                })

            case "0203":  # shoot base
                score_event = raw_records[i-1][1]
                base_id = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t, "entity": score_event["entity"],
                    "delta": int(score_event["delta"]),
                    "type": "base hit", "target": bases[base_id]["team"]
                })

            case "0204":  # destroy base
                score_event = raw_records[i-1][1]
                base_id = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t, "entity": score_event["entity"],
                    "delta": int(score_event["delta"]),
                    "type": "base destroy", "target": bases[base_id]["team"]
                })

            case "0B01" | "0B02":  # deny (technically denies or denied, both are same here.)
                score_event = raw_records[i-1][1]
                denied = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t, "entity": score_event["entity"],
                    "target": denied, "type": "deny",
                    "delta": int(score_event["delta"])
                })
                # Append event for denied player. Not score change but good to keep track
                output["events"].append({
                    "time": t, "entity": denied,
                    "target": score_event["entity"], "type": "denied",
                    "delta": 0
                })

            case "0600":  # penalty
                output["events"].append({
                    "time": t, "entity": event["varies"].split()[0].strip(),
                    "delta": int(raw_records[i-1][1]["delta"]),
                    "type": "penalty", "target": ""
                })

            case _:
                if event.get("entity") not in output["players"].keys():
                    print(f"Unknown event: {event}")
                continue

    # Output filename from mission start
    output_filename = f"games/{parsed_data['mission'][0]['start']}.json"

    s3.put_object(
        Bucket=bucket,
        Key=output_filename,
        Body=json.dumps(output, indent=2, ensure_ascii=False),
        ContentType="application/json"
    )

    print(f"Uploaded {output_filename}")
    return {"status": "ok", "output": output_filename}
