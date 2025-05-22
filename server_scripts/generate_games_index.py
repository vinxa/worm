#!/usr/bin/env python3
"""
generate_games_index.py

Scan the data/games/ directory for .json files and generate data/games/index.json
Usage:
    python generate_games_index.py
"""

import os
import json
import sys

def main():
    print("Running!")
    # Determine directories
    script_dir = os.path.abspath(os.path.dirname(__file__))
    games_dir = os.path.join(os.path.dirname(script_dir), 'data', 'games')
    out_path = os.path.join(games_dir, 'index.json')

    # List all .json files except the manifest itself
    files = sorted(
        f for f in os.listdir(games_dir)
        if f.endswith('.json') and f != 'index.json'
    )

    # Build the games list
    games = []
    for fname in files:
        game_id = os.path.splitext(fname)[0]
        title = game_id.replace('-', ' ').replace('_', ' ').title()
        data_path = f'data/games/{fname}'
        games.append({
            'id': game_id,
            'title': title,
            'dataPath': data_path
        })

    # Write manifest
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(games, f, indent=2)
    print(f'Generated {len(games)} entries in {out_path}')

if __name__ == '__main__':
    main()
