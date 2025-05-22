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
    current_section = None

    with open(filepath, newline='', encoding='utf-16-le') as csvfile:
        reader = csv.reader(csvfile, delimiter='\t')
        for row in reader:
            if not row:
                continue

            if row[0].startswith(";"):
                try:
                    section = row[0].split("/", 1)[1].split()[0]
                    current_section = section if section in known_headers else None
                except IndexError:
                    current_section = None
            elif current_section:
                data = row[1:]  # Skip index field
                headers = known_headers[current_section]
                row_dict = {key: val for key, val in zip(headers, data)}
                sections[current_section].append(row_dict)

    return sections

if __name__ == "__main__":
    print("RUINNING")
    if len(sys.argv) != 2:
        print("Usage: python convert_game_files.py <input_filepath>")
        sys.exit(1)

    filepath = sys.argv[1]
    output_dir = Path(__file__).parent.parent / "data/games"
    output_dir.mkdir(parents=True, exist_ok=True)  # Check it exists
    parsed_data = readFile(filepath)

    # Set basic game info
    output["gameDuration"] = int(int(parsed_data["mission"][0]["duration"]) / 1000 )
    output["penalty"] = int(parsed_data["mission"][0]["penalty"])
    output["startTime"] = datetime.strptime(parsed_data["mission"][0]["start"], "%Y%m%d%H%M%S").strftime("%Y-%m-%d %H:%M")

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

    # Set events
    for i, event in enumerate(parsed_data["score"]):
        if "delta" not in event and event["entity"] != "0101":
            continue

        event_data = {"time": int(event["time"])/1000}

        match event["entity"]:
            case "0201":  # miss
                continue

            case "0206" | "0208":  # deacs
                event_data.update({"entity": event["old"], "target": event["new"], "type":"tag", "delta": int(parsed_data["score"][i-2]["delta"])})

                # Append event for tagged player
                output["events"].append({"time":event_data["time"], "entity":event_data["target"], "target":event_data["entity"], "type":"tagged", "delta":int(parsed_data["score"][i-1]["delta"])})
                
            case "0203":  # shoot base
                event_data.update({
                    "entity": event["old"],
                    "delta": int(parsed_data["score"][i-1]["delta"]),
                    "type": "base hit",
                    "target": bases[event["new"]]["team"]})
                
            case "0204":  # destroy base
                event_data.update({
                    "entity": event["old"],
                    "delta": int(parsed_data["score"][i-1]["delta"]),
                    "type": "base destroy",
                    "target": bases[event["new"]]["team"]})
                
            case "0B01" | "0B02":  # deny (technically denies or denied, both are same here.)
                event_data.update({
                    "entity": event["old"],
                    "target": event["new"],
                    "type":"deny",
                    "delta": int(parsed_data["score"][i-1]["delta"])
                })

                # Append event for denied player. Not score change but good to keep track
                output["events"].append({"time":event_data["time"], "entity":event_data["target"], "target":event_data["entity"], "type":"denied", "delta": 0})

            case "0600":  # penalty
                event_data.update({
                    "entity": event["old"],
                    "delta": int(parsed_data["score"][i-1]["delta"]),
                    "type": "penalty",
                    "target": ""})
                
            case "0500":  # reload
                continue
            
            case "0101":  # game end
                print("Game end")
                for player in output["players"].values():
                    output["events"].append({
                        "time": event_data["time"],
                        "entity":player["id"], 
                        "target":"", 
                        "type":"game end", 
                        "delta": 0})
                continue

            case "0207":  # stun
                continue

            case _:
                if event["entity"] not in output["players"].keys():
                    print(f"Unknown event: {event}")
                continue

        output["events"].append(event_data)

    print(f"Writing to {output_path}...")
    with open(output_path, "w", encoding="utf-8") as jsonfile:
        json.dump(output, jsonfile, indent=2, ensure_ascii=False)