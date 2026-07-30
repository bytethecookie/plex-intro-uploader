from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List
from apscheduler.schedulers.asyncio import AsyncIOScheduler
import httpx
import asyncio
import os
import re
import uuid
import json
import logging
from pathlib import Path

CONFIG_FILE       = Path(os.environ.get("CONFIG_DIR", ".")) / "config.json"
SUBMITTED_FILE    = Path(os.environ.get("CONFIG_DIR", ".")) / "submitted.json"
SCHEDULE_LOG_FILE = Path(os.environ.get("CONFIG_DIR", ".")) / "schedule_log.json"
SCHEDULE_LOG_LIMIT = 20

def _load_submitted() -> dict:
    try:
        if SUBMITTED_FILE.exists():
            data = json.loads(SUBMITTED_FILE.read_text())
            # Migrate legacy keys (pre-destination tracking) to the "introdb:" namespace
            legacy_keys = [k for k in data if k.count(":") == 2]
            if legacy_keys:
                for k in legacy_keys:
                    data[f"introdb:{k}"] = data.pop(k)
                SUBMITTED_FILE.write_text(json.dumps(data, indent=2))
            return data
    except Exception:
        pass
    return {}

def _mark_submitted(
    destination: str, imdb_id: str, season: int, episode: int,
    external_id: Optional[str] = None, duration_ms: Optional[int] = None,
) -> None:
    from datetime import datetime, timezone
    data = _load_submitted()
    key = f"{destination}:{imdb_id}:{season}:{episode}"
    entry = {"at": datetime.now(timezone.utc).isoformat()}
    if external_id is not None:
        entry["id"] = external_id
    if duration_ms is not None:
        entry["duration_ms"] = duration_ms
    data[key] = entry
    SUBMITTED_FILE.parent.mkdir(parents=True, exist_ok=True)
    SUBMITTED_FILE.write_text(json.dumps(data, indent=2))

def _was_submitted(submitted: dict, destination: str, imdb_id: str, season: int, episode: int) -> bool:
    return f"{destination}:{imdb_id}:{season}:{episode}" in submitted

def _submitted_entry(submitted: dict, destination: str, imdb_id: str, season: int, episode: int) -> Optional[dict]:
    entry = submitted.get(f"{destination}:{imdb_id}:{season}:{episode}")
    return entry if isinstance(entry, dict) else None

def _load_schedule_log() -> list:
    try:
        if SCHEDULE_LOG_FILE.exists():
            return json.loads(SCHEDULE_LOG_FILE.read_text())
    except Exception:
        pass
    return []

def _append_schedule_log(entry: dict) -> None:
    log = _load_schedule_log()
    log.insert(0, entry)
    log = log[:SCHEDULE_LOG_LIMIT]
    SCHEDULE_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    SCHEDULE_LOG_FILE.write_text(json.dumps(log, indent=2))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Plex Intro Uploader")

scan_tasks = {}
submit_tasks = {}

scheduler = AsyncIOScheduler()
schedule_state = {"running": False}

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=404, content={"detail": "Not found"})

# --- Models ---

class ScanRequest(BaseModel):
    library_name: str
    tmdb_api_key: str
    plex_url: str = ""
    plex_token: str = ""
    dry_run: Optional[bool] = None

class ScanResponse(BaseModel):
    task_id: str
    message: str

class LogEntry(BaseModel):
    status: str
    message: str

class ScanProgress(BaseModel):
    current: int
    total: int
    percent: float

class EpisodeResult(BaseModel):
    show_title: Optional[str] = None
    title: str
    season: int
    episode: int
    tvdb_id: str
    imdb_id: Optional[str] = None
    intro_start: Optional[float] = None
    intro_end: Optional[float] = None
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    duration_ms: Optional[int] = None
    status: str
    message: str
    previously_submitted_introdb: bool = False
    previously_submitted_skipdb: bool = False
    # duration_ms that was recorded on the existing SkipDB submission, if any (None means
    # either not submitted yet, or submitted without a duration and eligible for backfill)
    skipdb_submitted_duration_ms: Optional[int] = None

class ScanStatus(BaseModel):
    status: str
    progress: ScanProgress
    log: List[LogEntry] = []
    results: List[EpisodeResult] = []

class SubmitEpisode(BaseModel):
    imdb_id: str
    season: int
    episode: int
    title: str
    start_ms: int
    end_ms: int
    duration_ms: Optional[int] = None
    # Overrides SubmitRequest.destinations for just this episode (used to retry only
    # the destinations that previously failed, without resubmitting to ones that succeeded)
    destinations: Optional[List[str]] = None

class SubmitRequest(BaseModel):
    introdb_api_key: Optional[str] = None
    skipdb_api_key: Optional[str] = None
    destinations: List[str] = []  # default destinations, subset of "introdb", "skipdb"
    episodes: List[SubmitEpisode]

class SubmitResult(BaseModel):
    title: str
    season: int
    episode: int
    destination: str
    # submitted | rejected | rate_limited | error
    status: str
    message: str
    http_status: Optional[int] = None
    external_id: Optional[str] = None

class SubmitStartResponse(BaseModel):
    task_id: str
    total: int

class SubmitTaskStatus(BaseModel):
    status: str   # pending | running | completed
    current: int
    total: int
    percent: float
    results: List[SubmitResult] = []

# --- Scan background task ---

async def scan_library_task(
    task_id: str,
    plex_url: str,
    plex_token: str,
    library_name: str,
    tmdb_api_key: str,
):
    task = scan_tasks[task_id]
    task["status"] = "running"
    plex_headers = {"X-Plex-Token": plex_token, "Accept": "application/json"}
    imdb_id_cache: dict = {}  # tmdb_show_id -> imdb_id
    submitted = _load_submitted()

    async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
        try:
            lib_resp = await client.get(f"{plex_url}/library/sections", headers=plex_headers)
            lib_resp.raise_for_status()

            show_section = None
            for section in lib_resp.json().get("MediaContainer", {}).get("Directory", []):
                if section.get("type") == "show" and section.get("title") == library_name:
                    show_section = section
                    break

            if not show_section:
                task["status"] = "failed"
                task["log"].append(LogEntry(status="failed", message=f"Library '{library_name}' not found"))
                return

            library_key = show_section["key"]

            items_resp = await client.get(
                f"{plex_url}/library/sections/{library_key}/all",
                headers=plex_headers,
                params={"type": 4, "includeMarkers": 1, "includeGuids": 1,
                        "X-Plex-Container-Start": 0, "X-Plex-Container-Size": 1000}
            )
            items_resp.raise_for_status()
            episodes = items_resp.json().get("MediaContainer", {}).get("Metadata", [])
            task["total"] = len(episodes)

            if task["total"] == 0:
                task["status"] = "completed"
                return

            for idx, episode in enumerate(episodes):
                task["current"] = idx + 1
                task["percent"] = round(((idx + 1) / task["total"]) * 100)

                title = episode.get("title", "Unknown")
                parent_title = episode.get("grandparentTitle", episode.get("parentTitle", "Unknown Show"))
                season = episode.get("parentIndex", 0)
                number = episode.get("index", 0)
                rating_key = episode.get("ratingKey", "")

                guids = episode.get("Guid", [])
                tvdb_id = None
                for g in guids:
                    m = re.search(r"tvdb://(\d+)", g.get("id", ""))
                    if m:
                        tvdb_id = m.group(1)
                        break

                ep_ref = f"{parent_title} - S{str(season).zfill(2)}E{str(number).zfill(2)}"
                task["log"].append(LogEntry(
                    status="pending",
                    message=f"<span class='episode-ref'>{ep_ref}</span> — {title}"
                ))

                try:
                    if not tvdb_id:
                        task["log"].append(LogEntry(
                            status="failed",
                            message=f"No TVDB ID in Guids: {[g.get('id') for g in guids]}"
                        ))
                        task["results"].append(EpisodeResult(
                            show_title=parent_title, title=title, season=season, episode=number,
                            tvdb_id="", status="failed", message="No TVDB ID found"
                        ))
                        continue

                    ep_resp = await client.get(
                        f"{plex_url}/library/metadata/{rating_key}",
                        headers=plex_headers,
                        params={"includeMarkers": 1}
                    )
                    ep_resp.raise_for_status()
                    ep_meta = ep_resp.json().get("MediaContainer", {})
                    if isinstance(ep_meta, dict):
                        ep_meta = ep_meta.get("Metadata", [{}])[0]
                    else:
                        ep_meta = {}
                    markers = ep_meta.get("Marker", [])
                    intro_marker = next((m for m in markers if m.get("type") == "intro"), None)
                    duration_ms = ep_meta.get("duration")

                    if not intro_marker or not intro_marker.get("startTimeOffset") or not intro_marker.get("endTimeOffset"):
                        marker_types = [m.get("type") for m in markers]
                        task["log"].append(LogEntry(
                            status="skipped",
                            message=f"No intro marker <span class='detail'>({len(markers)} markers: {marker_types})</span>"
                        ))
                        task["results"].append(EpisodeResult(
                            show_title=parent_title, title=title, season=season, episode=number,
                            tvdb_id=tvdb_id, status="skipped", message="No intro markers found"
                        ))
                        continue

                    intro_start = round(intro_marker["startTimeOffset"] / 1000, 1)
                    intro_end = round(intro_marker["endTimeOffset"] / 1000, 1)
                    start_ms = intro_marker["startTimeOffset"]
                    end_ms = intro_marker["endTimeOffset"]

                    tmdb_resp = await client.get(
                        f"https://api.themoviedb.org/3/find/{tvdb_id}",
                        params={"external_source": "tvdb_id", "api_key": tmdb_api_key}
                    )
                    tmdb_resp.raise_for_status()
                    tmdb_data = tmdb_resp.json()

                    tmdb_show_id = None
                    ep_results = tmdb_data.get("tv_episode_results", [])
                    if ep_results:
                        tmdb_show_id = ep_results[0].get("show_id")
                    else:
                        show_results = tmdb_data.get("tv_results", [])
                        if show_results:
                            tmdb_show_id = show_results[0]["id"]

                    if not tmdb_show_id:
                        task["log"].append(LogEntry(
                            status="failed",
                            message=f"No TMDB match for TVDB ID {tvdb_id}"
                        ))
                        task["results"].append(EpisodeResult(
                            show_title=parent_title, title=title, season=season, episode=number,
                            tvdb_id=tvdb_id, status="failed", message="No TMDB match"
                        ))
                        continue

                    # Get IMDB ID from TMDB (cached per show to minimise API calls)
                    imdb_id = imdb_id_cache.get(tmdb_show_id)
                    if not imdb_id:
                        ext_resp = await client.get(
                            f"https://api.themoviedb.org/3/tv/{tmdb_show_id}/external_ids",
                            params={"api_key": tmdb_api_key}
                        )
                        ext_resp.raise_for_status()
                        imdb_id = ext_resp.json().get("imdb_id")
                        if imdb_id:
                            imdb_id_cache[tmdb_show_id] = imdb_id

                    if not imdb_id:
                        task["log"].append(LogEntry(
                            status="failed",
                            message=f"No IMDB ID for TMDB show {tmdb_show_id}"
                        ))
                        task["results"].append(EpisodeResult(
                            show_title=parent_title, title=title, season=season, episode=number,
                            tvdb_id=tvdb_id, status="failed", message="No IMDB ID found"
                        ))
                        continue

                    skipdb_entry = _submitted_entry(submitted, "skipdb", imdb_id, season, number)

                    task["log"].append(LogEntry(
                        status="matched",
                        message=f"<span class='intro-time'>{intro_start}s – {intro_end}s</span> → {imdb_id} S{season}E{number}"
                    ))
                    task["results"].append(EpisodeResult(
                        show_title=parent_title,
                        title=title,
                        season=season,
                        episode=number,
                        tvdb_id=tvdb_id,
                        imdb_id=imdb_id,
                        intro_start=intro_start,
                        intro_end=intro_end,
                        start_ms=start_ms,
                        end_ms=end_ms,
                        duration_ms=duration_ms,
                        status="matched",
                        message="Ready to submit",
                        previously_submitted_introdb=_was_submitted(submitted, "introdb", imdb_id, season, number),
                        previously_submitted_skipdb=_was_submitted(submitted, "skipdb", imdb_id, season, number),
                        skipdb_submitted_duration_ms=skipdb_entry.get("duration_ms") if skipdb_entry else None,
                    ))

                except Exception as ep_err:
                    task["log"].append(LogEntry(status="failed", message=f"Error: {str(ep_err)[:100]}"))
                    task["results"].append(EpisodeResult(
                        show_title=parent_title, title=title, season=season, episode=number,
                        tvdb_id="", status="failed", message=str(ep_err)[:100]
                    ))

            task["status"] = "completed"

        except Exception as err:
            task["status"] = "failed"
            task["log"].append(LogEntry(status="failed", message=f"Scan error: {str(err)}"))

# --- Submit background task ---

async def _find_skipdb_segment_id(client: httpx.AsyncClient, imdb_id: str, season: int, episode: int) -> Optional[str]:
    """Look up whether an intro segment already exists on SkipDB for this episode, straight from
    their own API — not our local tracking, which may be missing an id (e.g. pre-dates id capture,
    or drifted out of sync). This is what lets us PATCH an existing segment instead of blindly
    POSTing a duplicate."""
    try:
        resp = await client.get(
            "https://api.skipdb.tv/api/segments",
            params={"imdb_id": imdb_id, "season": season, "episode": episode, "type": "intro"},
        )
        if not resp.is_success:
            return None
        segments = (resp.json() or {}).get("segments") or {}
        intro = segments.get("intro")
        if not intro:
            return None
        seg_id = intro.get("id")
        return str(seg_id) if seg_id is not None else None
    except Exception:
        return None

async def _handle_skipdb_conflict(client: httpx.AsyncClient, resp: httpx.Response, headers: dict, ep: SubmitEpisode):
    """SkipDB returned 409 because an identical segment is already approved. It hands us a
    vote_url instead of letting us write a duplicate — SkipDB's own vote endpoint already knows
    whether it's our segment (403) or someone else's (in which case we upvote it). Returns
    (status, message, external_id)."""
    try:
        conflict_body = resp.json()
    except Exception:
        conflict_body = {}

    conflict_id = conflict_body.get("id")
    conflict_id_str = str(conflict_id) if conflict_id is not None else None
    vote_url = conflict_body.get("vote_url")

    if not vote_url:
        return "rejected", f"HTTP 409: {resp.text[:200].strip()}", None

    vote_full_url = vote_url if vote_url.startswith("http") else f"https://api.skipdb.tv{vote_url}"

    try:
        vote_resp = await client.post(vote_full_url, headers=headers, json={"value": 1})
    except Exception as e:
        return "rejected", f"Duplicate exists (id {conflict_id_str}); vote attempt failed: {str(e)[:120]}", None

    if vote_resp.status_code == 429:
        return "rate_limited", f"Duplicate exists (id {conflict_id_str}); rate limited while trying to vote — try again later", None
    if vote_resp.is_success:
        _mark_submitted("skipdb", ep.imdb_id, ep.season, ep.episode, external_id=conflict_id_str, duration_ms=ep.duration_ms)
        return "submitted", f"Voted up existing segment (id {conflict_id_str})", conflict_id_str
    if vote_resp.status_code == 403:
        # SkipDB itself confirms this is already our own segment
        _mark_submitted("skipdb", ep.imdb_id, ep.season, ep.episode, external_id=conflict_id_str, duration_ms=ep.duration_ms)
        return "submitted", f"Already your own segment (id {conflict_id_str})", conflict_id_str
    if vote_resp.status_code == 401:
        return "rejected", f"Duplicate exists (id {conflict_id_str}) — voting needs a registered SkipDB account, not an anonymous API key", None

    return "rejected", f"Duplicate exists (id {conflict_id_str}); vote attempt failed: HTTP {vote_resp.status_code}: {vote_resp.text[:120].strip()}", None

async def _build_submission(client: httpx.AsyncClient, destination: str, api_key: str, ep: SubmitEpisode):
    """Returns (method, url, headers, payload, existing_id). existing_id is the SkipDB segment id
    used for a PATCH, when applicable (None otherwise)."""
    if destination == "introdb":
        return (
            "POST",
            "https://api.introdb.app/submit",
            {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-API-Key": api_key,
            },
            {
                "imdb_id": ep.imdb_id,
                "segment_type": "intro",
                "season": ep.season,
                "episode": ep.episode,
                "start_sec": round(ep.start_ms / 1000, 3),
                "end_sec": round(ep.end_ms / 1000, 3),
            },
            None,
        )
    elif destination == "skipdb":
        payload = {
            "imdb_id": ep.imdb_id,
            "segment_type": "intro",
            "season": ep.season,
            "episode": ep.episode,
            "start_ms": ep.start_ms,
            "end_ms": ep.end_ms,
        }
        if ep.duration_ms:
            payload["duration_ms"] = ep.duration_ms
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {api_key}",
        }
        existing_id = await _find_skipdb_segment_id(client, ep.imdb_id, ep.season, ep.episode)
        if existing_id:
            return ("PATCH", f"https://api.skipdb.tv/api/segments/{existing_id}", headers, payload, existing_id)
        return ("POST", "https://api.skipdb.tv/api/segments", headers, payload, None)
    raise ValueError(f"Unknown destination: {destination}")

def _effective_destinations(ep: SubmitEpisode, default_destinations: List[str]) -> List[str]:
    return ep.destinations if ep.destinations is not None else default_destinations

async def submit_episodes_task(
    task_id: str,
    introdb_api_key: Optional[str],
    skipdb_api_key: Optional[str],
    default_destinations: List[str],
    episodes: List[SubmitEpisode],
):
    task = submit_tasks[task_id]
    task["status"] = "running"
    api_keys = {"introdb": introdb_api_key, "skipdb": skipdb_api_key}

    # A submission run can be hundreds of episodes long and unattended — nothing in here should
    # be able to wedge it in "running" forever, so anything truly unexpected is caught at the
    # top level too, rather than only relying on the per-call try/except below.
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            for ep in episodes:
                for destination in _effective_destinations(ep, default_destinations):
                    result_status = "error"
                    result_message = "Unknown error"
                    http_status = None
                    external_id = None

                    try:
                        method, url, headers, payload, existing_id = await _build_submission(
                            client, destination, api_keys[destination], ep
                        )

                        resp = None
                        rate_limited_out = False
                        for attempt in range(4):
                            resp = await client.request(method, url, headers=headers, json=payload)
                            if resp.status_code != 429:
                                break
                            if attempt == 3:
                                rate_limited_out = True
                                break
                            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
                            logger.info(f"Rate limited on {destination} for {ep.title} S{ep.season}E{ep.episode}, retrying in {wait}s")
                            await asyncio.sleep(min(wait, 60))

                        http_status = resp.status_code if resp else None

                        if rate_limited_out or (resp and resp.status_code == 429):
                            result_status = "rate_limited"
                            result_message = "Rate limit exhausted — try again later"
                        elif resp and resp.is_success:
                            result_status = "submitted"
                            result_message = "Updated" if method == "PATCH" else "OK"
                            if destination == "skipdb":
                                try:
                                    raw_id = resp.json().get("id")
                                    # SkipDB's id is numeric; coerce to str to match external_id's type
                                    external_id = str(raw_id) if raw_id is not None else existing_id
                                except Exception:
                                    external_id = existing_id
                                if external_id:
                                    result_message = f"{result_message} (id {external_id})"
                            _mark_submitted(
                                destination, ep.imdb_id, ep.season, ep.episode,
                                external_id=external_id,
                                duration_ms=ep.duration_ms if destination == "skipdb" else None,
                            )
                        elif resp and resp.status_code == 409 and destination == "skipdb":
                            # SkipDB rejects a submission identical to an already-approved segment
                            # and points us at a vote endpoint instead of letting us write a duplicate.
                            result_status, result_message, external_id = await _handle_skipdb_conflict(
                                client, resp, headers, ep
                            )
                        elif resp:
                            result_status = "rejected"
                            body = resp.text[:200].strip()
                            result_message = f"HTTP {resp.status_code}: {body}"

                    except Exception as e:
                        result_status = "error"
                        result_message = str(e)[:200]

                    # Recording the result must never be able to abort the whole batch — an
                    # unexpected value here should surface as one failed row, not a silent hang.
                    try:
                        task["results"].append(SubmitResult(
                            title=ep.title,
                            season=ep.season,
                            episode=ep.episode,
                            destination=destination,
                            status=result_status,
                            message=result_message,
                            http_status=http_status,
                            external_id=external_id,
                        ))
                    except Exception as e:
                        task["results"].append(SubmitResult(
                            title=ep.title,
                            season=ep.season,
                            episode=ep.episode,
                            destination=destination,
                            status="error",
                            message=f"Internal error recording result: {str(e)[:150]}",
                        ))
                    task["current"] += 1
                    task["percent"] = round((task["current"] / task["total"]) * 100)
    except Exception as e:
        logger.error(f"Submit task {task_id} aborted unexpectedly: {e}")

    task["status"] = "completed"

# --- SkipDB duration backfill background task ---
#
# For episodes already submitted to SkipDB before we started sending duration_ms (or before
# Plex had reported a duration at scan time), this PATCHes the existing segment in place rather
# than creating a new one — SkipDB treats a differently-timed duration as a distinct submission,
# so this only ever fires for episodes recorded with no duration yet.

class BackfillEpisode(BaseModel):
    imdb_id: str
    season: int
    episode: int
    title: str
    duration_ms: int

class BackfillRequest(BaseModel):
    skipdb_api_key: str
    episodes: List[BackfillEpisode]

class BackfillResult(BaseModel):
    title: str
    season: int
    episode: int
    # updated | not_submitted | rejected | rate_limited | error
    status: str
    message: str
    http_status: Optional[int] = None

class BackfillStartResponse(BaseModel):
    task_id: str
    total: int

class BackfillTaskStatus(BaseModel):
    status: str
    current: int
    total: int
    percent: float
    results: List[BackfillResult] = []

backfill_tasks = {}

async def backfill_duration_task(task_id: str, skipdb_api_key: str, episodes: List[BackfillEpisode]):
    task = backfill_tasks[task_id]
    task["status"] = "running"
    submitted = _load_submitted()

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {skipdb_api_key}",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            for ep in episodes:
                result_status = "error"
                result_message = "Unknown error"
                http_status = None

                try:
                    entry = _submitted_entry(submitted, "skipdb", ep.imdb_id, ep.season, ep.episode)
                    segment_id = entry.get("id") if entry else None
                    if not segment_id:
                        # Not tracked locally (e.g. this predates id capture) — ask SkipDB directly
                        segment_id = await _find_skipdb_segment_id(client, ep.imdb_id, ep.season, ep.episode)

                    if not segment_id:
                        result_status = "not_submitted"
                        result_message = "No SkipDB submission found for this episode"
                    else:
                        resp = None
                        rate_limited_out = False
                        for attempt in range(4):
                            resp = await client.patch(
                                f"https://api.skipdb.tv/api/segments/{segment_id}",
                                headers=headers,
                                json={"duration_ms": ep.duration_ms},
                            )
                            if resp.status_code != 429:
                                break
                            if attempt == 3:
                                rate_limited_out = True
                                break
                            wait = int(resp.headers.get("Retry-After", 2 ** (attempt + 1)))
                            logger.info(f"Rate limited backfilling duration for {ep.title} S{ep.season}E{ep.episode}, retrying in {wait}s")
                            await asyncio.sleep(min(wait, 60))

                        http_status = resp.status_code if resp else None

                        if rate_limited_out or (resp and resp.status_code == 429):
                            result_status = "rate_limited"
                            result_message = "Rate limit exhausted — try again later"
                        elif resp and resp.is_success:
                            result_status = "updated"
                            result_message = "Duration updated"
                            _mark_submitted(
                                "skipdb", ep.imdb_id, ep.season, ep.episode,
                                external_id=segment_id, duration_ms=ep.duration_ms,
                            )
                        elif resp:
                            result_status = "rejected"
                            body = resp.text[:200].strip()
                            result_message = f"HTTP {resp.status_code}: {body}"

                except Exception as e:
                    result_status = "error"
                    result_message = str(e)[:200]

                try:
                    task["results"].append(BackfillResult(
                        title=ep.title,
                        season=ep.season,
                        episode=ep.episode,
                        status=result_status,
                        message=result_message,
                        http_status=http_status,
                    ))
                except Exception as e:
                    task["results"].append(BackfillResult(
                        title=ep.title,
                        season=ep.season,
                        episode=ep.episode,
                        status="error",
                        message=f"Internal error recording result: {str(e)[:150]}",
                    ))
                task["current"] += 1
                task["percent"] = round((task["current"] / task["total"]) * 100)
    except Exception as e:
        logger.error(f"Backfill task {task_id} aborted unexpectedly: {e}")

    task["status"] = "completed"

# --- Endpoints ---

class AppConfig(BaseModel):
    plexUrl: Optional[str] = None
    plexToken: Optional[str] = None
    tmdbKey: Optional[str] = None
    introbKey: Optional[str] = None
    skipdbKey: Optional[str] = None
    library: Optional[str] = None
    submitIntrodb: Optional[bool] = None
    submitSkipdb: Optional[bool] = None
    scheduleEnabled: Optional[bool] = None
    scheduleHour: Optional[int] = None
    scheduleMinute: Optional[int] = None

def _read_config() -> dict:
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text())
            # Migrate old field name
            if "tidbKey" in data and "introbKey" not in data:
                data["introbKey"] = data.pop("tidbKey")
            return data
    except Exception:
        pass
    return {}

def _write_config(data: dict) -> None:
    CONFIG_FILE.write_text(json.dumps(data, indent=2))

# --- Scheduled (unattended) scan + submit ---

class ScheduleRunLogEntry(BaseModel):
    started_at: str
    finished_at: Optional[str] = None
    status: str  # running | completed | skipped | failed
    scanned: int = 0
    matched: int = 0
    to_submit: int = 0
    submitted: int = 0
    rejected: int = 0
    rate_limited: int = 0
    error: int = 0
    message: str = ""

class ScheduleStatus(BaseModel):
    enabled: bool
    hour: int
    minute: int
    running: bool
    next_run: Optional[str] = None
    history: List[ScheduleRunLogEntry] = []

def _reschedule_from_config() -> None:
    cfg = _read_config()
    try:
        scheduler.remove_job("auto_run")
    except Exception:
        pass
    if cfg.get("scheduleEnabled"):
        hour = cfg.get("scheduleHour", 3)
        minute = cfg.get("scheduleMinute", 0)
        scheduler.add_job(
            run_scheduled_pipeline, "cron", hour=hour, minute=minute,
            id="auto_run", replace_existing=True,
        )
        logger.info(f"Scheduled run enabled: daily at {hour:02d}:{minute:02d}")
    else:
        logger.info("Scheduled run disabled")

async def run_scheduled_pipeline() -> None:
    """Unattended scan-then-submit: everything matched and not already fully sent to whichever
    destinations are configured/enabled. No human is present to pick episodes, so this is the
    closest equivalent of clicking 'select all not-yet-sent' and 'Submit'."""
    if schedule_state["running"]:
        logger.info("Scheduled run skipped — a run is already in progress")
        return
    schedule_state["running"] = True

    from datetime import datetime, timezone
    entry = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
        "status": "running",
        "scanned": 0, "matched": 0, "to_submit": 0,
        "submitted": 0, "rejected": 0, "rate_limited": 0, "error": 0,
        "message": "",
    }

    try:
        cfg = _read_config()
        plex_url = cfg.get("plexUrl") or "http://localhost:32400"
        plex_token = cfg.get("plexToken") or ""
        library = cfg.get("library")
        tmdb_key = cfg.get("tmdbKey")
        introdb_key = cfg.get("introbKey")
        skipdb_key = cfg.get("skipdbKey")

        destinations = []
        if cfg.get("submitIntrodb", True) and introdb_key:
            destinations.append("introdb")
        if cfg.get("submitSkipdb", False) and skipdb_key:
            destinations.append("skipdb")

        if not library or not tmdb_key:
            entry["status"] = "skipped"
            entry["message"] = "No library or TMDB key configured"
            return
        if not destinations:
            entry["status"] = "skipped"
            entry["message"] = "No submission destination configured (check API keys and Submit-to toggles)"
            return

        logger.info(f"Scheduled run starting: library={library} destinations={destinations}")

        scan_task_id = str(uuid.uuid4())
        scan_tasks[scan_task_id] = {
            "status": "pending", "current": 0, "total": 0, "percent": 0,
            "log": [], "results": [],
        }
        await scan_library_task(scan_task_id, plex_url, plex_token, library, tmdb_key)
        scan_result = scan_tasks[scan_task_id]

        entry["scanned"] = len(scan_result["results"])
        matched = [r for r in scan_result["results"] if r.status == "matched"]
        entry["matched"] = len(matched)

        if scan_result["status"] != "completed":
            entry["status"] = "failed"
            entry["message"] = "Scan did not complete"
            return

        to_submit = []
        for r in matched:
            needed = [
                d for d in destinations
                if not (r.previously_submitted_introdb if d == "introdb" else r.previously_submitted_skipdb)
            ]
            if needed:
                to_submit.append((r, needed))

        entry["to_submit"] = len(to_submit)

        if not to_submit:
            entry["status"] = "completed"
            entry["message"] = "No new episodes to submit"
            return

        episodes = [
            SubmitEpisode(
                imdb_id=r.imdb_id, season=r.season, episode=r.episode, title=r.title,
                start_ms=r.start_ms, end_ms=r.end_ms, duration_ms=r.duration_ms,
                destinations=needed,
            )
            for r, needed in to_submit
        ]
        total = sum(len(needed) for _, needed in to_submit)

        submit_task_id = str(uuid.uuid4())
        submit_tasks[submit_task_id] = {
            "status": "pending", "current": 0, "total": total, "percent": 0, "results": [],
        }
        await submit_episodes_task(submit_task_id, introdb_key, skipdb_key, destinations, episodes)
        submit_result = submit_tasks[submit_task_id]

        for r in submit_result["results"]:
            if r.status in entry:
                entry[r.status] += 1

        entry["status"] = "completed"
        entry["message"] = f"Submitted {entry['submitted']} of {total} destination calls for {len(to_submit)} episodes"
        logger.info(f"Scheduled run finished: {entry['message']}")

    except Exception as e:
        entry["status"] = "failed"
        entry["message"] = f"Unexpected error: {str(e)[:200]}"
        logger.error(f"Scheduled run failed: {e}")
    finally:
        entry["finished_at"] = datetime.now(timezone.utc).isoformat()
        _append_schedule_log(entry)
        schedule_state["running"] = False

@app.on_event("startup")
async def _on_startup():
    scheduler.start()
    _reschedule_from_config()

@app.get("/api/health")
async def health_check():
    return JSONResponse(content={"status": "ok"})

@app.get("/api/config")
async def get_config():
    return JSONResponse(content=_read_config())

@app.post("/api/config")
async def save_config(config: AppConfig):
    _write_config(config.model_dump(exclude_none=True))
    _reschedule_from_config()
    return JSONResponse(content={"status": "ok"})

@app.get("/api/libraries")
async def get_libraries(plex_url: str, plex_token: str):
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{plex_url}/library/sections",
                headers={"X-Plex-Token": plex_token}
            )
            response.raise_for_status()
            libraries = [
                s.get("title", "Unknown")
                for s in response.json().get("MediaContainer", {}).get("Directory", [])
                if s.get("type") == "show"
            ]
            return {"libraries": libraries}
    except httpx.HTTPError as e:
        raise HTTPException(status_code=500, detail=f"Plex API error: {str(e)}")

@app.post("/api/scan", response_model=ScanResponse)
async def start_scan(request: ScanRequest):
    logger.info(f"Scan started: library={request.library_name}")
    task_id = str(uuid.uuid4())
    scan_tasks[task_id] = {
        "status": "pending", "current": 0, "total": 0, "percent": 0,
        "log": [], "results": [],
    }
    asyncio.create_task(scan_library_task(
        task_id=task_id,
        plex_url=request.plex_url or "http://localhost:32400",
        plex_token=request.plex_token or "",
        library_name=request.library_name,
        tmdb_api_key=request.tmdb_api_key,
    ))
    return ScanResponse(task_id=task_id, message="Scan started")

@app.get("/api/scan/results")
async def get_scan_results(task_id: str):
    if task_id not in scan_tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    task = scan_tasks[task_id]
    return ScanStatus(
        status=task["status"],
        progress=ScanProgress(current=task["current"], total=task["total"], percent=task["percent"]),
        log=task["log"],
        results=task["results"]
    )

@app.post("/api/submit", response_model=SubmitStartResponse)
async def start_submit(request: SubmitRequest):
    default_destinations = request.destinations

    per_episode = [_effective_destinations(ep, default_destinations) for ep in request.episodes]
    used_destinations = {d for eps in per_episode for d in eps}

    if not used_destinations:
        raise HTTPException(status_code=400, detail="No submission destination selected")
    for d in used_destinations:
        if d not in ("introdb", "skipdb"):
            raise HTTPException(status_code=400, detail=f"Unknown destination: {d}")
    if "introdb" in used_destinations and not request.introdb_api_key:
        raise HTTPException(status_code=400, detail="IntroDB API key is required")
    if "skipdb" in used_destinations and not request.skipdb_api_key:
        raise HTTPException(status_code=400, detail="SkipDB API key is required")

    total = sum(len(eps) for eps in per_episode)
    logger.info(f"Submit started: {len(request.episodes)} episodes -> {sorted(used_destinations)}")
    task_id = str(uuid.uuid4())
    submit_tasks[task_id] = {
        "status": "pending",
        "current": 0,
        "total": total,
        "percent": 0,
        "results": [],
    }
    asyncio.create_task(submit_episodes_task(
        task_id, request.introdb_api_key, request.skipdb_api_key, default_destinations, request.episodes
    ))
    return SubmitStartResponse(task_id=task_id, total=total)

@app.get("/api/submit/results")
async def get_submit_results(task_id: str):
    if task_id not in submit_tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    task = submit_tasks[task_id]
    return SubmitTaskStatus(
        status=task["status"],
        current=task["current"],
        total=task["total"],
        percent=task["percent"],
        results=task["results"]
    )

@app.post("/api/skipdb/backfill-duration", response_model=BackfillStartResponse)
async def start_backfill_duration(request: BackfillRequest):
    if not request.skipdb_api_key:
        raise HTTPException(status_code=400, detail="SkipDB API key is required")
    if not request.episodes:
        raise HTTPException(status_code=400, detail="No episodes provided")

    logger.info(f"Duration backfill started: {len(request.episodes)} episodes")
    task_id = str(uuid.uuid4())
    backfill_tasks[task_id] = {
        "status": "pending",
        "current": 0,
        "total": len(request.episodes),
        "percent": 0,
        "results": [],
    }
    asyncio.create_task(backfill_duration_task(task_id, request.skipdb_api_key, request.episodes))
    return BackfillStartResponse(task_id=task_id, total=len(request.episodes))

@app.get("/api/skipdb/backfill-duration/results")
async def get_backfill_results(task_id: str):
    if task_id not in backfill_tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    task = backfill_tasks[task_id]
    return BackfillTaskStatus(
        status=task["status"],
        current=task["current"],
        total=task["total"],
        percent=task["percent"],
        results=task["results"]
    )

@app.get("/api/schedule/status", response_model=ScheduleStatus)
async def get_schedule_status():
    cfg = _read_config()
    job = scheduler.get_job("auto_run")
    next_run = job.next_run_time.isoformat() if job and job.next_run_time else None
    return ScheduleStatus(
        enabled=bool(cfg.get("scheduleEnabled", False)),
        hour=cfg.get("scheduleHour", 3),
        minute=cfg.get("scheduleMinute", 0),
        running=schedule_state["running"],
        next_run=next_run,
        history=_load_schedule_log(),
    )

@app.post("/api/schedule/run-now")
async def run_schedule_now():
    if schedule_state["running"]:
        return JSONResponse(content={"status": "already_running"})
    asyncio.create_task(run_scheduled_pipeline())
    return JSONResponse(content={"status": "started"})

# Serve the built React frontend (Docker/production only).
# Only activates if dist/ exists — dev mode is unaffected since Vite serves the frontend.
_dist = Path(__file__).parent / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
