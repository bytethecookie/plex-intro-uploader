from fastapi import FastAPI, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import httpx
import os
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Plex Intro Uploader")

# Mount static files
app.mount("/static", StaticFiles(directory="backend/static"), name="static")

# --- Models ---

class PlexConfig(BaseModel):
    plex_url: str
    plex_token: str

class TmdbConfig(BaseModel):
    tmdb_api_key: str

class TidyConfig(BaseModel):
    tidb_api_key: str

class LibraryResponse(BaseModel):
    libraries: list[str]

class EpisodeData(BaseModel):
    title: str
    season: int
    episode: int
    tvdb_id: str
    tmdb_id: str | None = None
    tmdb_season: int | None = None
    tmdb_episode: int | None = None
    intro_start: float | None = None
    intro_end: float | None = None
    status: str = "pending"  # pending, matched, skipped, failed
    message: str = ""

class ScanRequest(BaseModel):
    library_name: str
    tmdb_api_key: str
    tidb_api_key: str
    dry_run: bool = False

class ScanResponse(BaseModel):
    message: str

# --- Endpoints ---

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    with open("backend/static/index.html", "r") as f:
        return f.read()

@app.get("/api/libraries", response_model=LibraryResponse)
async def get_libraries(config: PlexConfig):
    """Fetch available libraries from Plex."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{config.plex_url}/library/sections",
                headers={"X-Plex-Token": config.plex_token}
            )
            response.raise_for_status()
            data = response.json()
            
            # Extract library names from XML-like structure
            libraries = []
            for section in data.get("MediaContainer", {}).get("Directory", []):
                if section.get("type") == "show":
                    libraries.append(section.get("title", "Unknown"))
            
            return LibraryResponse(libraries=libraries)
    except httpx.HTTPError as e:
        logger.error(f"Plex API error: {e}")
        raise HTTPException(status_code=500, detail=f"Plex API error: {str(e)}")

@app.post("/api/scan", response_model=ScanResponse)
async def scan_episodes(request: ScanRequest):
    """Start scanning episodes from a Plex library."""
    # This will be handled by async tasks in the full version
    return ScanResponse(message="Scan started")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)