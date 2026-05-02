from fastapi import FastAPI, UploadFile, File, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from faster_whisper import WhisperModel
from pydantic import BaseModel
from concurrent.futures import ThreadPoolExecutor
import shutil
import subprocess
import tempfile
import os
import uuid
import asyncio
import yt_dlp
import gemini

app = FastAPI()

origins = [
    "http://localhost.tiangolo.com",
    "https://localhost.tiangolo.com",
    "http://localhost",
    "http://127.0.0.1:5500",
    "https://transcribe-ebon.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


executor = ThreadPoolExecutor(max_workers=2)
model = WhisperModel("tiny", device="auto", compute_type="int8")

class TranscribeRequest(BaseModel):
    text: str

import subprocess
import numpy as np

def process_audio_stream(audio_bytes: bytes):

    process = subprocess.Popen(
        [
            "ffmpeg",
            "-i", "pipe:0",
            "-f", "s16le",        # raw PCM
            "-acodec", "pcm_s16le",
            "-ac", "1",           # mono
            "-ar", "16000",       # 16kHz (Whisper requirement)
            "pipe:1"
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL
    )

    out, _ = process.communicate(input=audio_bytes)

    audio = np.frombuffer(out, np.int16).astype(np.float32) / 32768.0

    segments, _ = model.transcribe(audio, beam_size=1, vad_filter=True)

    return " ".join(s.text.strip() for s in segments)

def download_youtube_audio_stream(url):
    import yt_dlp
    import io

    buffer = io.BytesIO()

    ydl_opts = {
        'format': 'bestaudio',
        'outtmpl': '-',
        'quiet': True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        result = ydl.extract_info(url, download=False)
        audio_url = result['url']

    # stream download
    import requests
    response = requests.get(audio_url)
    return response.content

@app.post("/youtube")
async def youtube_transcription(url: str = Query(...)):
    try:
        loop = asyncio.get_event_loop()

        audio_bytes = await loop.run_in_executor(
            executor,
            download_youtube_audio_stream,
            url
        )

        text = await loop.run_in_executor(
            executor,
            process_audio_stream,
            audio_bytes
        )

        return {"url": url, "text": text}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/upload")
async def upload_audio(file: UploadFile = File(...)):
    try:
        audio_bytes = await file.read()

        # skip silence / tiny files
        if len(audio_bytes) < 8000:
            return {"text": ""}

        loop = asyncio.get_event_loop()

        text = await loop.run_in_executor(
            executor,
            process_audio_stream,
            audio_bytes
        )

        return {"text": text}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)
    
@app.post("/generate-notes")
async def generate_notes(request: TranscribeRequest):
    # Call the function inside gemini.py
    result = gemini.generate_notes(request.text)
    if "error" in result:
        return JSONResponse(result, status_code=500)
    return result

@app.get("/download/{file_id}")
async def download_pdf(file_id: str, background_tasks: BackgroundTasks):
    file_path = gemini.get_pdf_path(file_id)
    
    if os.path.exists(file_path):
        # Schedule the file to be deleted AFTER it is sent to the user
        background_tasks.add_task(os.remove, file_path)
        return FileResponse(
            file_path,
            media_type="application/pdf",
            filename="Study_Notes.pdf"
        )
    
    return JSONResponse({"error": "File expired or not found"}, status_code=404)