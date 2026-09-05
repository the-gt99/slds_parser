#!/usr/bin/env python3
import argparse
import hashlib
import mimetypes
import os
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


IMAGE_EXTENSIONS = {".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"}


def arguments():
    parser = argparse.ArgumentParser(description="Upload a file list to content-addressed S3 keys with a resumable manifest.")
    parser.add_argument("--source-list", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--category", required=True, choices=("products", "catalog", "banners", "content", "ui", "public"))
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--chunk-size", type=int, default=500)
    return parser.parse_args()


def open_manifest(path):
    database = sqlite3.connect(path)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA synchronous=NORMAL")
    database.execute(
        """CREATE TABLE IF NOT EXISTS media_map (
        source_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, object_key TEXT NOT NULL,
        size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, mime_type TEXT NOT NULL,
        status TEXT NOT NULL, etag TEXT, uploaded_at TEXT, verified_at TEXT
        )"""
    )
    database.execute("CREATE INDEX IF NOT EXISTS media_map_hash_idx ON media_map(content_hash)")
    database.execute("CREATE INDEX IF NOT EXISTS media_map_status_idx ON media_map(status)")
    database.commit()
    return database


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["SLDS_S3_ENDPOINT"],
        region_name=os.environ.get("AWS_DEFAULT_REGION", "ru-central1"),
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, retries={"max_attempts": 5, "mode": "standard"}),
    )


def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare(path, category):
    stat = os.stat(path)
    digest = digest_file(path)
    extension = os.path.splitext(path)[1].lower()
    return {
        "path": path, "hash": digest, "key": f"{category}/{digest[:2]}/{digest[2:4]}/{digest}{extension}",
        "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
        "mime": mimetypes.guess_type(path)[0] or "application/octet-stream",
    }


def upload(client, bucket, item):
    action = "uploaded"
    try:
        head = client.head_object(Bucket=bucket, Key=item["key"])
        if head.get("ContentLength") == item["size"]:
            action = "existing"
        else:
            raise RuntimeError("object size mismatch for content-addressed key")
    except ClientError as error:
        if str(error.response.get("Error", {}).get("Code", "")) not in ("404", "NoSuchKey", "NotFound"):
            raise
        with open(item["path"], "rb") as body:
            client.put_object(Bucket=bucket, Key=item["key"], Body=body, ContentLength=item["size"], ContentType=item["mime"], Metadata={"sha256": item["hash"]})
    head = client.head_object(Bucket=bucket, Key=item["key"])
    if head.get("ContentLength") != item["size"]:
        raise RuntimeError("uploaded object size verification failed")
    return item, action, str(head.get("ETag", "")).strip('"')


def chunks(source, size):
    chunk = []
    with open(source, "r", encoding="utf-8", errors="surrogateescape") as lines:
        for line in lines:
            path = line.rstrip("\r\n")
            if path:
                chunk.append(path)
            if len(chunk) >= size:
                yield chunk
                chunk = []
    if chunk:
        yield chunk


def main():
    options = arguments()
    database = open_manifest(options.manifest)
    client = s3_client()
    bucket = os.environ["SLDS_S3_BUCKET"]
    totals = {"listed": 0, "skipped": 0, "verified": 0, "uploaded": 0, "existing": 0, "errors": 0, "bytes_uploaded": 0}
    started = time.monotonic()

    for paths in chunks(options.source_list, options.chunk_size):
        candidates = []
        for path in paths:
            totals["listed"] += 1
            extension = os.path.splitext(path)[1].lower()
            if extension not in IMAGE_EXTENSIONS or not os.path.isfile(path):
                totals["errors"] += 1
                continue
            stat = os.stat(path)
            row = database.execute("SELECT size_bytes, mtime_ns, status FROM media_map WHERE source_path=?", (path,)).fetchone()
            if row and row[0] == stat.st_size and row[1] == stat.st_mtime_ns and row[2] == "uploaded_verified":
                totals["skipped"] += 1
                continue
            candidates.append(path)

        results = []
        with ThreadPoolExecutor(max_workers=options.workers) as pool:
            prepared = {pool.submit(prepare, path, options.category): path for path in candidates}
            items = []
            for future in as_completed(prepared):
                try:
                    items.append(future.result())
                except Exception as error:
                    totals["errors"] += 1
                    print(f"prepare_error path={prepared[future]!r} error={type(error).__name__}:{error}", file=sys.stderr, flush=True)
            uploaded = {pool.submit(upload, client, bucket, item): item for item in items}
            for future in as_completed(uploaded):
                try:
                    results.append(future.result())
                except Exception as error:
                    totals["errors"] += 1
                    print(f"upload_error path={uploaded[future]['path']!r} error={type(error).__name__}:{error}", file=sys.stderr, flush=True)

        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for item, action, etag in results:
            database.execute(
                """INSERT INTO media_map (source_path,content_hash,object_key,size_bytes,mtime_ns,mime_type,status,etag,uploaded_at,verified_at)
                VALUES (?,?,?,?,?,?,'uploaded_verified',?,?,?)
                ON CONFLICT(source_path) DO UPDATE SET content_hash=excluded.content_hash,object_key=excluded.object_key,
                size_bytes=excluded.size_bytes,mtime_ns=excluded.mtime_ns,mime_type=excluded.mime_type,status=excluded.status,
                etag=excluded.etag,uploaded_at=excluded.uploaded_at,verified_at=excluded.verified_at""",
                (item["path"], item["hash"], item["key"], item["size"], item["mtime_ns"], item["mime"], etag, now, now),
            )
            totals["verified"] += 1
            totals[action] += 1
            if action == "uploaded":
                totals["bytes_uploaded"] += item["size"]
        database.commit()
        elapsed = max(time.monotonic() - started, 0.001)
        print({**totals, "elapsed_seconds": round(elapsed, 1), "files_per_second": round((totals["verified"] + totals["skipped"]) / elapsed, 2)}, flush=True)

    database.close()
    if totals["errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
