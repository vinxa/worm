import boto3
import json
import os

s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET"]
PREFIX = "games/"

def lambda_handler(event, context):
    # List all game JSONs in the bucket
    resp = s3.list_objects_v2(Bucket=BUCKET, Prefix=PREFIX)

    games = []
    for obj in resp.get("Contents", []):
        key = obj["Key"]
        if not key.endswith(".json") or key.endswith("index.json"):
            continue
        game_id = os.path.splitext(os.path.basename(key))[0].split("@")[0]
        title = os.path.splitext(os.path.basename(key))[0].split("@")[1].replace("_"," ").title()
        data_path = f"https://{BUCKET}.s3.amazonaws.com/{key}"
        players = []
        teams = {}
        try:
            game_obj = s3.get_object(Bucket=BUCKET, Key=key)
            game_json = json.loads(game_obj["Body"].read())
            player_team_ids = {}

            if isinstance(game_json, dict) and "teams" in game_json and isinstance(game_json["teams"], list):
                for t in game_json["teams"]:
                    if not isinstance(t, dict):
                        continue
                    team_id = t.get("id")
                    if not team_id:
                        continue
                    teams[team_id] = {
                        "players": [],
                        "color": t.get("color", "")
                    }

            if isinstance(game_json, dict) and "players" in game_json:
                players = sorted({p.get("name") for p in game_json["players"].values() if isinstance(p, dict) and p.get("name")})
                for p in game_json["players"].values():
                    if not isinstance(p, dict):
                        continue
                    team_id = p.get("team")
                    name = p.get("name")
                    if not team_id or not name:
                        continue
                    player_team_ids.setdefault(team_id, []).append(name)

                for team_id, names in player_team_ids.items():
                    if team_id not in teams:
                        teams[team_id] = {"players": [], "color": ""}
                    teams[team_id]["players"] = sorted(set(names))
        except Exception as e:
            print(f"Warning: unable to read players for {key}: {e}")

        games.append({
            "id": game_id,
            "title": title,
            "dataPath": data_path,
            "players": players,
            "teams": teams
        })

    games.sort(key=lambda g: g["id"], reverse=True)

    # Write index.json back to S3
    s3.put_object(
        Bucket=BUCKET,
        Key=f"index.json",
        Body=json.dumps(games, indent=2),
        ContentType="application/json",
        CacheControl="no-store, no-cache, must-revalidate, proxy-revalidate",
        Expires="0"
    )

    print(f"Updated index.json with {len(games)} entries")
    return {"statusCode": 200, "games": len(games)}
