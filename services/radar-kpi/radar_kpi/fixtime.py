# SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
"""Time-fixed copies of bags whose MCAP ``log_time`` is not in nanoseconds.

Some processed bags store epoch *seconds* in ``log_time``, so Lichtblick's playback clock shows 1970 and all
messages of one second share a timestamp. This module rewrites such a bag with ``log_time`` taken from the payload
timestamp of every message (exact sub-second order); messages without a known payload timestamp get
``log_time * 1e9``. The copy is written next to the KPI cache and served read-only through the data server.
Original bags are never modified.
"""

from __future__ import annotations

import logging
import struct
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from mcap.reader import make_reader
from mcap.writer import CompressionType, Writer

log = logging.getLogger("radar_kpi.fixtime")

# schemas whose first field is `float64 timestamp` (CDR: encapsulation header 4 bytes, then the value)
_FLOAT64_FIRST = ("GeoRegRVMap", "RadarDetection", "RadarMeasurement", "GeoTrack")


def _extractor_for(schema_name: str, schema_text: str) -> Callable[[bytes], float] | None:
    base = schema_name.rsplit("/", 1)[-1]
    if base in _FLOAT64_FIRST:
        return lambda data: struct.unpack_from("<d", data, 4)[0]
    first = next((ln.strip() for ln in schema_text.splitlines() if ln.strip() and not ln.strip().startswith("#")), "")
    if first.startswith(("std_msgs/Header header", "Header header", "builtin_interfaces/Time stamp")):
        # Header.stamp = int32 sec, uint32 nanosec (little-endian CDR)
        def header_stamp(data: bytes) -> float:
            sec, nsec = struct.unpack_from("<iI", data, 4)
            return sec + nsec * 1e-9

        return header_stamp
    return None


def rewrite_with_payload_time(src_files: list[Path], dst: Path, progress: Callable[[float], None] | None = None) -> dict:
    """Copy `src_files` into one MCAP with payload-derived log_time. Returns summary statistics."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".mcap.part")
    total = sum(p.stat().st_size for p in src_files) or 1
    done_bytes = 0
    n = n_payload = n_fallback = 0
    t_min = float("inf")
    t_max = float("-inf")
    with open(tmp, "wb") as out:
        w = Writer(out, compression=CompressionType.ZSTD, chunk_size=4 * 1024 * 1024)
        w.start(profile="ros2", library="radar-kpi-timefix")
        schema_ids: dict[tuple[int, str], int] = {}
        channel_ids: dict[tuple[int, int], int] = {}
        extractors: dict[tuple[int, int], Callable[[bytes], float] | None] = {}
        for fi, src in enumerate(src_files):
            with open(src, "rb") as fh:
                reader = make_reader(fh)
                for schema, channel, msg in reader.iter_messages():
                    skey = (fi, schema.id if schema else 0)
                    if skey not in schema_ids:
                        schema_ids[skey] = (w.register_schema(name=schema.name, encoding=schema.encoding, data=schema.data)
                                            if schema else 0)
                    ckey = (fi, channel.id)
                    if ckey not in channel_ids:
                        channel_ids[ckey] = w.register_channel(
                            topic=channel.topic, message_encoding=channel.message_encoding, schema_id=schema_ids[skey],
                            metadata=dict(channel.metadata))
                        extractors[ckey] = (_extractor_for(schema.name, schema.data.decode("utf-8", "replace"))
                                            if schema and schema.encoding == "ros2msg" else None)
                    ex = extractors[ckey]
                    t_ns = None
                    if ex is not None:
                        try:
                            t = ex(msg.data)
                            if 1e8 < t < 4e9:  # plausible epoch seconds
                                t_ns = int(round(t * 1e9))
                        except struct.error:
                            t_ns = None
                    if t_ns is None:
                        t_ns = msg.log_time * 1_000_000_000 if msg.log_time < 4_000_000_000 else msg.log_time
                        n_fallback += 1
                    else:
                        n_payload += 1
                    t_min, t_max = min(t_min, t_ns), max(t_max, t_ns)
                    w.add_message(channel_id=channel_ids[ckey], log_time=t_ns, data=msg.data, publish_time=t_ns,
                                  sequence=msg.sequence)
                    n += 1
                    if progress and n % 2000 == 0:
                        progress(min(0.99, (done_bytes + fh.tell()) / total))
            done_bytes += src.stat().st_size
        w.finish()
    tmp.replace(dst)
    return {"messages": n, "from_payload": n_payload, "from_log_time": n_fallback,
            "t_start": t_min * 1e-9 if n else None, "t_end": t_max * 1e-9 if n else None, "size_bytes": dst.stat().st_size}


@dataclass
class Job:
    state: str = "running"  # running | done | error
    progress: float = 0.0
    error: str | None = None
    started: float = field(default_factory=time.time)
    summary: dict | None = None


class TimeFixer:
    """Background jobs producing `<cache>/fixed/<run_id>.mcap`."""

    def __init__(self, cache_dir: Path) -> None:
        self.dir = cache_dir / "fixed"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def path(self, run_id: str) -> Path:
        return self.dir / f"{run_id}.mcap"

    def url(self, run_id: str) -> str:
        return f"/data/fixed/{run_id}.mcap"

    def status(self, run_id: str) -> dict:
        with self._lock:
            job = self.jobs.get(run_id)
        p = self.path(run_id)
        if job is not None and job.state == "running":
            return {"state": "running", "progress": job.progress}
        if job is not None and job.state == "error":
            return {"state": "error", "error": job.error}
        if p.exists():
            return {"state": "done", "url": self.url(run_id), "size_bytes": p.stat().st_size,
                    **({"summary": job.summary} if job and job.summary else {})}
        return {"state": "none"}

    def start(self, run_id: str, files: list[Path]) -> dict:
        with self._lock:
            job = self.jobs.get(run_id)
            if job is not None and job.state == "running":
                return {"state": "running", "progress": job.progress}
            if self.path(run_id).exists():
                return self.status(run_id)
            job = self.jobs[run_id] = Job()

        def work() -> None:
            try:
                job.summary = rewrite_with_payload_time(files, self.path(run_id), lambda f: setattr(job, "progress", f))
                job.state, job.progress = "done", 1.0
            except Exception as exc:  # noqa: BLE001
                log.exception("time fix failed for %s", run_id)
                job.state, job.error = "error", str(exc)

        threading.Thread(target=work, daemon=True, name=f"timefix-{run_id}").start()
        return {"state": "running", "progress": 0.0}
