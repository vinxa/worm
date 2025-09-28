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
        game_id = os.path.splitext(os.path.basename(key))[0]
        title = game_id.replace("-", " ").replace("_", " ").title()
        data_path = f"https://{BUCKET}.s3.amazonaws.com/{key}"
        games.append({
            "id": game_id,
            "title": title,
            "dataPath": data_path
        })

    # Write index.json back to S3
    s3.put_object(
        Bucket=BUCKET,
        Key=f"index.json",
        Body=json.dumps(games, indent=2),
        ContentType="application/json"
    )

    print(f"Updated index.json with {len(games)} entries")
    return {"statusCode": 200, "games": len(games)}
