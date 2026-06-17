from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List
import httpx
import asyncio
import re
import uuid
import os
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Plex Intro Uploader")

# Log all registered routes on startup
logger.info("Starting application...")
for route in app.routes:
    logger.info(f"  Route: {route.methods} {route.path}")

# In-memory task store
tasks = {}

# --- Custom 404 Handler ---
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail}
    )

# Catch-all 404 handler
@app.exception_handler(404)
async def not_found_handler(request: Request, exc: Exception):
    logger.info(f"404: {request.method} {request.url}")
    return JSONResponse(
        status_code=404,
        content={"detail": "Not found"}
    )

# --- Models ---

class ScanRequest(BaseModel):
    library_name: str
    tmdb_api_key: str
    tidb_api_key: str
    dry_run: bool = False
    plex_url: str = ""
    plex_token: str = ""

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
    title: str
    season: int
    episode: int
    tvdb_id: str
    tmdb_id: Optional[str] = None
    intro_start: Optional[float = None
    intro_end: Optional[float] = None
    status: str
    message: str

class ScanStatus(BaseModel):
    status: str
    progress: ScanProgress
    log: List[LogEntry] = []
    results: List[EpisodeResult] = []

# --- Async Background Task ---

async def scan_library_task(
    task_id: str,
    plex_url: str,
    plex_token: str,
    library_name: str,
    tmdb_api_key: str,
    tidb_api_key: str,
    dry_run: bool
):
    """Scan a Plex library for intro markers and submit to TheIntroDB."""
    task = tasks[task_id]
    task["status"] = "running"
    
    async with httpx.AsyncClient(timeout=30.0, verify=False) as client:
        try:
            # Get library section key
            lib_resp = await client.get(
                f"{plex_url}/library/sections",
                headers={"X-Plex-Token": plex_token}
            )
            lib_resp.raise_for_status()
            lib_data = lib_resp.json()
            
            show_section = None
            for section in lib_data.get("MediaContainer", {}).get("Directory", []):
                if section.get("type") == "show" and section.get("title") == library_name:
                    show_section = section
                    break
            
            if not show_section:
                task["status"] = "failed"
                task["log"].append(LogEntry(status="failed", message=f"Library '{library_name}' not found"))
                return
            
            library_key = show_section["key"]
            
            # Get all episodes (handle pagination if needed)
            items_resp = await client.get(
                f"{plex_url}/library/sections/{library_key}/all",
                headers={"X-Plex-Token": plex_token},
                params={"X-Plex-Container-Start": 0, "X-Plex-Container-Size": 1000}
            )
            items_resp.raise_for_status()
            items_data = items_resp.json()
            
            episodes = items_data.get("MediaContainer", {}).get("Metadata", [])
            task["total"] = len(episodes)
            
            if task["total"] == 0:
                task["status"] = "completed"
                return
            
            # Process each episode
            for idx, episode in enumerate(episodes):
                task["current = idx + 1
                task["percent"] = round(((idx + 1) / task["total"]) * 100)
                
                title = episode.get("title", "Unknown")
                parent_title = episode.get("parentTitle", "Unknown Show")
                season = episode.get("parentIndex", 0)
                number = episode.get("index", 0)
                episode_guid = episode.get("guid", "")
                
                ep_ref = f"{parent_title} - S{str(season).zfill(2)}E{str(number).zfill(2)}"
                task["log"].append(LogEntry(
                    status="pending",
                    message=f"<span class='episode-ref'>{ep_ref}</span> — {title}"
                ))
                
                try:
                    # Extract TVDB ID from guid
                    tvdb_match = re.search(r"tvdb://(\d+)", episode_guid)
                    if not tvdb_match:
                        task["log"].append(LogEntry(
                            status="failed",
                            message=f"No TVDB ID found <span class='detail'>({episode_guid})</span>"
                        ))
                        task["results"].append(EpisodeResult(
                            title=title,
                            season=season,
                            episode=number,
                            tvdb_id="",
                            status="failed",
                            message=f"No TVDB ID found"
                        ))
                        continue
                    
                    tvdb_id = tvdb_match.group(1)
                    
                    # Check for intro markers
                    ep_details_resp = await client.get(
                        f"{plex_url}/library/metadata/{episode_guid.replace('tvdb://', '')}/children",
                        headers={"X-Plex-Token": plex_token},
                        params={"X-Plex-Container-Size": 0}
                    )
                    ep_details_resp.raise_for_status()
                    ep_details = ep_details_resp.json()
                    
                    # Defensive parsing: ensure we access the marker list safely
                    first_metadata = ep_details.get("MediaContainer", {}).get("Metadata", [{}])[0]
                    markers = first_metadata.get("marker") or []
                    intro_marker = next((m for m in markers if m.get("type") == "intro"), None)
                    
                    if not intro_marker or not intro_marker.get("start") or not intro_marker.get("end"):
                        task["log"].append(LogEntry(
                            status="skipped",
                            message=f"No intro markers found <span class='detail'>({len(markers)} markers)</span>"
                        ))
                        task["results"].append(EpisodeResult(
                            title=title,
                            season=season,
                            episode=number,
                            tvdb_id=tvdb_id,
                            status="skipped",
                            message="No intro markers found"
                        ))
                        continue
                    
                    intro_start = round(intro_marker["start"] / 1000, 1)
                    intro_end = round(intro_marker["end"] / 1000, 1)
                    
                    # Translate TVDB ID to TMDB ID
                    tmdb_resp = await client.get(
                        f"https://api.themoviedb.org/3/find/{tvdb_id}",
                        params={"external_source": "tvdb_id", "api_key": tmdb_api_key}
                    )
                    tmdb_resp.raise_for_status()
                    tmdb_data = tmdb_resp.json()
                    
                    tv_shows = tmdb_data.get("tv_shows", [])
                    if not tv_shows:
                        task["log"].append(LogEntry(
                            status="failed",
                            message=f"No TMDB match for TVDB ID {tvdb_id}"
                        ))
                        task["results"].append(EpisodeResult(
                            title=title,
                            season=season,
                            episode=number,
                            tvdb_id=tvdb_id,
                            status="failed",
                            message=f"No TMDB match"
                        ))
                        continue
                    
                    tmdb_id = tv_shows[0]["id"]
                    
                    if dry_run:
                        task["log"].append(LogEntry(
                            status="matched",
                            message=f"<span class='intro-time'>{intro_start}s - {intro_end}s</span> → TMDB {tmdb_id} S{season}E{number} <span class='detail'>(dry run)</span>"
                        ))
                        task["results"].append(EpisodeResult(
                            title=title,
                            season=season,
                            episode=number,
                            tvdb_id=tvdb_id,
                            tmdb_id=str(tmdb_id),
                            intro_start=intro_start,
                            intro_end=intro_end,
                            status="matched",
                            message=f"Dry run - would submit to TMDB {tmdb_id}"
                        ))
                    else:
                        # Submit to TheIntroDB
                        tidb_resp = await client.post(
                            "https://api.theintrodb.org/intros",
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {tidb_api_key}"
                            },
                            json={
                                "tmdb_id": tmdb_id,
                                "season": season,
                                "episode": number,
                                "intro_start": intro_start,
                                "intro_end": intro_end
                            }
                        )
                        
                        if tidb_resp.ok:
                            task["log"].append(LogEntry(
                                status="matched",
                                message=f"<span class='intro-time'>{intro_start}s - {intro_end}s</span> → Submitted to TheIntroDB"
                            ))
                            task["results"].append(EpisodeResult(
                                title=title,
                                season=season,
                                episode=number,
                                tvdb_id=tvdb_id,
                                tmdb_id=str(tmdb_id),
                                intro_start=intro_start,
                                intro_end=intro_end,
                                status="matched",
                                message="Successfully submitted"
                            ))
                        else:
                            error_body = tidb_resp.text
                            task["log"].append(LogEntry(
                                status="failed",
                                message=f"TIDB API error: {tidb_resp.status_code} <span class='detail'>{error_body[:100]}</span>"
                            ))
                            task["results"].append(EpisodeResult(
                                title=title,
                                season=season,
                                episode=number,
                                tvdb_id=tvdb_id,
                                status="failed",
                                message=f"TIDB API error: {tidb_resp.status_code}"
                            ))
                
                except Exception as ep_err:
                    task["log"].append(LogEntry(
                        status="failed",
                        message=f"Error processing episode: {str(ep_err)[:100]}"
                    ))
                    task["results"].append(EpisodeResult(
                        title=title,
                        season=season,
                        episode=number,
                        tvdb_id="",
                        status="failed",
                        message=str(ep_err)[:100]
                    ))
            
            task["status"] = "completed"
        
        except Exception as err:
            task["status"] = "failed"
            task["log"].append(LogEntry(status="failed", message=f"Scan error: {str(err)}"))

# --- Endpoints ---

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    try:
        with open("backend/static/index.html", "r") as f:
            return f.read()
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Index not found</h1>", status_code=404)

@app.get("/api/health")
async def health_check():
    """Check if the backend is running and ready."""
    logger.info("Health check called")
    try:
        return JSONResponse(content={"status": "ok"})
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": "Service unavailable"}
        )

@app.get("/api/libraries")
async def get_libraries(plex_url: str, plex_token: str):
    """Fetch available libraries from Plex."""
    logger.info(f"Libraries called with plex_url={plex_url}")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{plex_url}/library/sections",
                headers={"X-Plex-Token": plex_token}
            )
            response.raise_for_status()
            data = response.json()
            
            libraries = []
            for section in data.get("MediaContainer", {}).get("Directory", []):
                if section.get("type") == "show":
                    libraries.append(section.get("title", "Unknown"))
            
            return {"libraries": libraries}
    except httpx.HTTPError as e:
        logger.error(f"Plex API error: {e}")
        raise HTTPException(status_code=500, detail=f"Plex API error: {str(e)}")

@app.post("/api/scan", response_model=ScanResponse)
async def start_scan(request: ScanRequest):
    """Start scanning episodes from a Plex library."""
    logger.info(f"Scan called with library_name={request.library_name}, tmdb_key={request.tmdb_api_key}, tidb_key={request.tidb_api_key}, dry_run={request.dry_run}")
    task_id = str(uuid.uuid4())
    
    tasks[task_id] = {
        "status": "pending",
        "current": 0,
        "total": 0,
        "percent": 0,
        "log": [],
        "results": [],
        "plex_url": request.plex_url,
        "plex_token": request.plex_token,
        "library_name": request.library_name,
        "tmdb_api_key": request.tmdb_api_key,
        "tidb_api_key": request.tidb_api_key,
        "dry_run": request.dry_run,
    }
    
    # Start background task
    asyncio.create_task(scan_library_task(
        task_id=task_id,
        plex_url=request.plex_url or "http://localhost:32400",
        plex_token=request.plex_token or "",
        library_name=request.library_name,
        tmdb_api_key=request.tmdb_api_key,
        tidb_api_key=request.tidb_api_key,
        dry_run=request.dry_run
    ))
    
    return ScanResponse(task_id=task_id, message="Scan started")

@app.get("/api/scan/results")
async def get_scan_results(task_id: str):
    """Get scan progress and results via polling."""
    logger.info(f"Scan results called with task_id={task_id}")
    if task_id not in tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    
    task = tasks[task_id]
    
    progress = ScanProgress(
        current=task["current"],
        total=task["total"],
        percent=task["percent"]
    )
    
    return ScanStatus(
        status=task["status"],
        progress=progress,
        log=[LogEntry(**log) for log in task["log"]],
        results=[EpisodeResult(**r) for r in task["results"]]
    )