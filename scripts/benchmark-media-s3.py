#!/usr/bin/env python3
import argparse
import glob
import hashlib
import json
import mimetypes
import os
import sqlite3
import statistics
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


IMAGE_EXTENSIONS = {
    ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp",
}


def arguments():
    parser = argparse.ArgumentParser(description="Measure S3 media upload and persist a verified source-to-object map.")
    parser.add_argument("--source-glob", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--category", required=True, choices=("products", "catalog", "banners", "content", "ui", "public"))
    parser.add_argument("--workers", default="1,8,32")
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--public-get-samples", type=int, default=10)
    return parser.parse_args()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_item(path, category):
    digest = sha256(path)
    extension = os.path.splitext(path)[1].lower()
    stat = os.stat(path)
    return {
        "path": path,
        "hash": digest,
        "key": f"{category}/{digest[:2]}/{digest[2:4]}/{digest}{extension}",
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "mime": mimetypes.guess_type(path)[0] or "application/octet-stream",
    }


def manifest(path):
    database = sqlite3.connect(path)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute(
        """CREATE TABLE IF NOT EXISTS media_map (
        source_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        object_key TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ns INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        status TEXT NOT NULL,
        etag TEXT,
        uploaded_at TEXT,
        verified_at TEXT
        )"""
    )
    database.execute("CREATE INDEX IF NOT EXISTS media_map_hash_idx ON media_map(content_hash)")
    database.execute("CREATE INDEX IF NOT EXISTS media_map_status_idx ON media_map(status)")
    database.commit()
    return database


def s3_client():
    endpoint = os.environ["SLDS_S3_ENDPOINT"]
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=os.environ.get("AWS_DEFAULT_REGION", "ru-central1"),
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 5, "mode": "standard"},
        ),
    )


def upload(client, bucket, item):
    started = time.perf_counter()
    action = "uploaded"
    try:
        head = client.head_object(Bucket=bucket, Key=item["key"])
        if head.get("ContentLength") == item["size"]:
            action = "existing"
        else:
            raise RuntimeError("Existing object size does not match its content-addressed key")
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code not in ("404", "NoSuchKey", "NotFound"):
            raise
        with open(item["path"], "rb") as body:
            client.put_object(
                Bucket=bucket,
                Key=item["key"],
                Body=body,
                ContentLength=item["size"],
                ContentType=item["mime"],
                Metadata={"sha256": item["hash"]},
            )
    head = client.head_object(Bucket=bucket, Key=item["key"])
    if head.get("ContentLength") != item["size"]:
        raise RuntimeError("Uploaded object size verification failed")
    return item, action, time.perf_counter() - started, str(head.get("ETag", "")).strip('"')


def save_result(database, result):
    item, _action, _seconds, etag = result
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    database.execute(
        """INSERT INTO media_map (
        source_path, content_hash, object_key, size_bytes, mtime_ns, mime_type, status, etag, uploaded_at, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'uploaded_verified', ?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
        content_hash=excluded.content_hash, object_key=excluded.object_key, size_bytes=excluded.size_bytes,
        mtime_ns=excluded.mtime_ns, mime_type=excluded.mime_type, status=excluded.status,
        etag=excluded.etag, uploaded_at=excluded.uploaded_at, verified_at=excluded.verified_at""",
        (item["path"], item["hash"], item["key"], item["size"], item["mtime_ns"], item["mime"], etag, now, now),
    )


def benchmark(client, bucket, database, items, worker_counts, batch_size):
    summaries = []
    cursor = 0
    for workers in worker_counts:
        batch = items[cursor:cursor + batch_size]
        cursor += batch_size
        if not batch:
            break
        started = time.perf_counter()
        results = []
        errors = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(upload, client, bucket, item) for item in batch]
            for future in as_completed(futures):
                try:
                    results.append(future.result())
                except Exception as error:
                    errors.append(f"{type(error).__name__}: {error}")
        elapsed = time.perf_counter() - started
        uploaded_bytes = sum(item["size"] for item, action, _seconds, _etag in results if action == "uploaded")
        for result in results:
            save_result(database, result)
        database.commit()
        summaries.append({
            "workers": workers,
            "files": len(batch),
            "verified": len(results),
            "errors": errors[:3],
            "seconds": round(elapsed, 3),
            "uploaded_bytes": uploaded_bytes,
            "files_per_second": round(len(results) / elapsed, 2),
            "mib_per_second": round(uploaded_bytes / 1048576 / elapsed, 2),
        })
    return summaries


def public_latency(endpoint, bucket, items, limit):
    latencies = []
    statuses = []
    for item in items[:limit]:
        url = endpoint.rstrip("/") + "/" + bucket + "/" + urllib.parse.quote(item["key"], safe="/")
        started = time.perf_counter()
        with urllib.request.urlopen(url, timeout=15) as response:
            response.read(1)
            statuses.append(response.status)
        latencies.append((time.perf_counter() - started) * 1000)
    return {
        "statuses": sorted(set(statuses)),
        "latency_ms": {
            "min": round(min(latencies), 1),
            "median": round(statistics.median(latencies), 1),
            "max": round(max(latencies), 1),
        },
    }


def main():
    options = arguments()
    workers = [int(value) for value in options.workers.split(",") if value.strip()]
    required_files = len(workers) * options.batch_size
    paths = [
        path for path in sorted(glob.glob(options.source_glob))
        if os.path.isfile(path) and os.path.splitext(path)[1].lower() in IMAGE_EXTENSIONS
    ][:required_files]
    if len(paths) < required_files:
        raise SystemExit(f"Expected at least {required_files} matching images, found {len(paths)}")

    hash_started = time.perf_counter()
    items = [image_item(path, options.category) for path in paths]
    hash_seconds = time.perf_counter() - hash_started
    database = manifest(options.manifest)
    client = s3_client()
    bucket = os.environ["SLDS_S3_BUCKET"]
    batches = benchmark(client, bucket, database, items, workers, options.batch_size)
    latency = public_latency(os.environ["SLDS_S3_ENDPOINT"], bucket, items, options.public_get_samples)
    database.close()
    print(json.dumps({
        "selected_files": len(items),
        "selected_bytes": sum(item["size"] for item in items),
        "hash_seconds": round(hash_seconds, 3),
        "batches": batches,
        "public_get": latency,
        "manifest": options.manifest,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
