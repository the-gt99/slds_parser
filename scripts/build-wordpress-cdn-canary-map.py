#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3


def arguments():
    parser = argparse.ArgumentParser(description="Select one fully mapped product for a WordPress CDN canary.")
    parser.add_argument("--candidates", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--uploads-root", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def main():
    options = arguments()
    with open(options.candidates, "r", encoding="utf-8") as source:
        candidates = json.load(source)
    database = sqlite3.connect(options.manifest)

    for candidate in candidates:
        if len(candidate["attachments"]) < 2:
            continue
        mapping = {}
        complete = True
        for attachment in candidate["attachments"]:
            for relative_path in attachment["paths"]:
                source_path = os.path.join(options.uploads_root, relative_path)
                if not os.path.isfile(source_path):
                    complete = False
                    break
                row = database.execute(
                    "SELECT object_key FROM media_map WHERE source_path=? AND status='uploaded_verified'",
                    (source_path,),
                ).fetchone()
                if row is None:
                    complete = False
                    break
                mapping[relative_path.replace("\\", "/")] = row[0]
            if not complete:
                break
        if complete and mapping:
            result = {
                "product_id": candidate["product_id"],
                "slug": candidate["slug"],
                "attachment_ids": [item["id"] for item in candidate["attachments"]],
                "mapping": mapping,
            }
            with open(options.output, "w", encoding="utf-8") as target:
                json.dump(result, target, ensure_ascii=False, separators=(",", ":"))
                target.write("\n")
            print(json.dumps({
                "product_id": result["product_id"],
                "slug": result["slug"],
                "attachments": len(result["attachment_ids"]),
                "mapped_paths": len(mapping),
            }, ensure_ascii=False, separators=(",", ":")))
            database.close()
            return

    database.close()
    raise SystemExit("No published product has a complete verified media map")


if __name__ == "__main__":
    main()
