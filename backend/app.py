from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List
import httpx
import asyncio
import os
import re
import uuid
import json
import logging
from pathlib import Path

CONFIG_FILE    = Path(os.environ.get("CONFIG_DIR", ".")) / "config.json"
SUBMITTED_FILE = Path(os.environ.get("CONFIG_DIR", ".")) / "submitted.json"

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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Plex Intro Uploader")

scan_tasks = {}
submit_tasks = {}

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

def _build_submission(destination: str, api_key: str, ep: SubmitEpisode):
    if destination == "introdb":
        return (
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
        return (
            "https://api.skipdb.tv/api/segments",
            {
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
            payload,
        )
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
                        url, headers, payload = _build_submission(destination, api_keys[destination], ep)

                        resp = None
                        rate_limited_out = False
                        for attempt in range(4):
                            resp = await client.post(url, headers=headers, json=payload)
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
                            result_message = "OK"
                            if destination == "skipdb":
                                try:
                                    raw_id = resp.json().get("id")
                                    # SkipDB's id is numeric; coerce to str to match external_id's type
                                    external_id = str(raw_id) if raw_id is not None else None
                                except Exception:
                                    external_id = None
                                if external_id:
                                    result_message = f"OK (id {external_id})"
                            _mark_submitted(
                                destination, ep.imdb_id, ep.season, ep.episode,
                                external_id=external_id,
                                duration_ms=ep.duration_ms if destination == "skipdb" else None,
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
                        result_status = "not_submitted"
                        result_message = "No tracked SkipDB submission id for this episode"
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

@app.get("/api/health")
async def health_check():
    return JSONResponse(content={"status": "ok"})

@app.get("/api/config")
async def get_config():
    return JSONResponse(content=_read_config())

@app.post("/api/config")
async def save_config(config: AppConfig):
    _write_config(config.model_dump(exclude_none=True))
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

# Serve the built React frontend (Docker/production only).
# Only activates if dist/ exists — dev mode is unaffected since Vite serves the frontend.
_dist = Path(__file__).parent / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")
