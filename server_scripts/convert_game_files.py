import csv
import sys
from pathlib import Path
import json
from datetime import datetime

print("Argument:", sys.argv[1])

output = {
    "gameDuration": 0,
    "penalty": 0,
    "startTime": "",
    "teams": [],
    "players": {},
    "events": []}

bases = {}

# Load the file
import csv
import json

def readFile(filepath):
    # Known headers for each section
    
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

    with open(filepath, newline='', encoding='utf-16-le') as csvfile:
        reader = csv.reader(csvfile, delimiter='\t')
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
            
                # Special case cos the column is variable width
                if section == "event":
                    row_dict = {
                        "time":   row[1],
                        "type":   row[2],
                        "varies": " ".join(row[3:]).strip()
                    }
                else:
                    data    = row[1:]  # Skip the code
                    headers = known_headers[section]
                    row_dict = {key: val for key, val in zip(headers, data)}

                sections[section].append(row_dict)
                raw_records.append((section, row_dict))

    return sections, raw_records

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python convert_game_files.py <input_filepath>")
        sys.exit(1)

    filepath = sys.argv[1]
    output_dir = Path(__file__).parent.parent / "data/games"
    output_dir.mkdir(parents=True, exist_ok=True)  # Check it exists
    parsed_data, raw_records = readFile(filepath)

    # Set basic game info
    output["gameDuration"] = int(int(parsed_data["mission"][0]["duration"]) / 1000 )
    output["penalty"] = int(parsed_data["mission"][0]["penalty"])
    output["startTime"] = datetime.strptime(parsed_data["mission"][0]["start"], "%Y%m%d%H%M%S").strftime("%Y-%m-%d %H:%M")
    output["gameType"] = parsed_data["mission"][0]["desc"]

    # Set output filename
    output_filename = parsed_data["mission"][0]["start"] + ".json"
    output_path = output_dir / output_filename


    # Set teams
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

    # Set players
    for player_data in parsed_data["entity-start"]:
        if player_data["type"] == "player":
            player = {
                "id": player_data["id"],
                "name": player_data["desc"],
                "team": next((team["id"] for team in output["teams"] if team["index"] == player_data["team"]), None)
            }
            output["players"][player_data["id"]] = player

        # Store bases locally.
        elif player_data["type"] == "standard-target":
            base = {
                "id": player_data["id"],
                "name": player_data["desc"],
                "team": next((team["id"] for team in output["teams"] if team["index"] == player_data["team"]), None)
            }
            bases[player_data["id"]] = base

    # Check for late logins in startup sequence
    for state in parsed_data["player-state"]:
        if state["entity"].startswith("#") and state["entity"] not in output["players"].keys():
            print(state)

    # Set events
    for i, (section, event) in enumerate(raw_records):
        if section != "event":
            continue

        # Check for late logins
        #if event["entity"].startswith("#") and event["entity"] not in output["players"].keys():

        t = int(event["time"])/1000

        match event["type"]:
            case "0101":  # game end
                print("Game end")
                for player in output["players"].values():
                    output["events"].append({
                        "time": t,
                        "entity":player["id"], 
                        "target":"", 
                        "type":"game end", 
                        "delta": 0})
                continue

            case "0100":  # game start
                print("Game start")
                for player in output["players"].values():
                    output["events"].append({
                        "time": t,
                        "entity":player["id"], 
                        "target":"", 
                        "type":"game start", 
                        "delta": 0})
                continue

            case "0201" | "0500" | "0207" | "0902":  
                # miss, reload, stun, achievements
                continue

            case "0206" | "0208":  # deacs
                tagger = raw_records[i-2][1]
                tagged = raw_records[i-1][1]
                output["events"].append({
                    "time":t,
                    "entity":tagger["entity"],
                    "target":tagged["entity"],
                    "type":"tag",
                    "delta":int(tagger["delta"])
                    })
                # Append event for tagged player
                output["events"].append({
                    "time":t,
                    "entity":tagged["entity"],
                    "target":tagger["entity"],
                    "type":"tagged",
                    "delta":int(tagged["delta"])
                    })
                
            case "0203":  # shoot base
                score_event = raw_records[i-1][1]
                base_id = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t,
                    "entity": score_event["entity"],
                    "delta": int(score_event["delta"]),
                    "type": "base hit",
                    "target": bases[base_id]["team"]
                })
                
            case "0204":  # destroy base
                score_event = raw_records[i-1][1]
                base_id = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t,
                    "entity": score_event["entity"],
                    "delta": int(score_event["delta"]),
                    "type": "base destroy",
                    "target": bases[base_id]["team"]
                })
                
            case "0B01" | "0B02":  # deny (technically denies or denied, both are same here.)
                score_event = raw_records[i-1][1]
                denied = event["varies"].split()[-1].strip()
                output["events"].append({
                    "time": t,
                    "entity": score_event["entity"],
                    "target": denied,
                    "type": "deny",
                    "delta": int(score_event["delta"])
                })

                # Append event for denied player. Not score change but good to keep track
                output["events"].append({
                    "time": t,
                    "entity": denied,
                    "target": score_event["entity"],
                    "type":"denied",
                    "delta": 0})

            case "0600":  # penalty
                output["events"].append({
                    "time": t,
                    "entity": event["varies"].split()[0].strip(),
                    "delta": int(raw_records[i-1][1]["delta"]),
                    "type": "penalty",
                    "target": ""})

            case _:
                if event["entity"] not in output["players"].keys():
                    print(f"Unknown event: {event}")
                continue

    print(f"Writing to {output_path}...")
    with open(output_path, "w", encoding="utf-8") as jsonfile:
        json.dump(output, jsonfile, indent=2, ensure_ascii=False)